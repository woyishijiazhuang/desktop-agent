import { randomUUID } from 'node:crypto'
import type {
  AgentToolCall,
  BeforeToolCallContext,
  BeforeToolCallResult
} from '@earendil-works/pi-agent-core'
import { rendererClient } from '../service/render-client'
import { db } from '../database'
import { createLogger } from '../utils/log'
import { isPlanMode, isPlanAllowedCommand } from './plan-mode'
import type { PermissionRequest, PermissionBatchItem, PermissionScope } from './types'
import {
  SETTING_PERMISSION_AUTO_APPROVE,
  SETTING_PERMISSION_TIMEOUT_SEC,
  DEFAULT_PERMISSION_TIMEOUT_SEC
} from './types'

const log = createLogger('permission')

/**
 * 危险工具执行前的权限拦截。
 * 判定顺序（deny 优先于 allow，对齐主流 Agent 客户端）：
 * 1. bash 命中 DENY_PATTERNS（破坏性命令）→ 强制人工确认，且不提供「总是允许」；
 * 2. bash 为内置只读命令且是简单命令 → 直接放行（消除 ls/git status 等日常确认）；
 * 3. 命中持久白名单（用户点过「总是允许」）→ 直接放行；
 * 4. 命中本会话放行（用户点过「本次会话允许」）→ 直接放行；
 * 5. 命中本回合自动放行（用户点过「允许本回合全部」，未命中破坏性模式）→ 直接放行；
 * 6. 设置开启「跳过工具确认」（且未命中破坏性模式）→ 直接放行；
 * 7. 其余 → 推送 renderer，在对应的工具卡片上等待人工确认。
 * write_file / edit_file 无持久白名单（路径型放行意义有限），仅支持「本次会话放行」。
 * install_skill 会从外部平台下载并落盘不可信代码，同样需要人工确认。
 */
const DANGEROUS_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'install_skill'])

/** settings 表中存储的 bash 持久白名单 key（值为 string[]，按词级前缀匹配）。 */
export const SETTING_BASH_ALLOWLIST = 'bashAllowlist'

/**
 * 内置只读命令集合（命中且为简单命令时自动放行）。
 * 匹配按「词级前缀」：单词规则要求命令首词精确相等（避免 lsblk / echo 之类误放行），
 * 多词规则比较命令前 N 个词（如 git status 放行 git status --short）。
 * 词级比较天然防 `ls; rm` 绕过（`ls;` 不等于 `ls`），再叠加 isSimpleCommand 双保险。
 */
const READONLY_COMMANDS: string[] = [
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'echo',
  'date',
  'whoami',
  'which',
  'type',
  'uname',
  'df',
  'du',
  'free',
  'ps',
  'env',
  'stat',
  'file',
  'sw_vers',
  'sysctl',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git remote',
  'git rev-parse',
  'git config',
  'git ls-files',
  'git stash list',
  'git tag',
  'node --version',
  'npm --version',
  'pnpm --version',
  'python --version',
  'python3 --version',
  'git --version'
]

/**
 * 破坏性命令模式（deny，优先于一切 allow 规则）。
 * 命中后即使已加入白名单也强制人工确认，防止 `git status && git push --force` 之类
 * 复合命令借白名单逃过拦截。注意判定的是整个命令字符串。
 */
const DENY_PATTERNS: RegExp[] = [
  // rm 带 r/R/f（recursive/force 任一）选项即为破坏性删除；-i 等交互选项不命中。
  // 用「全命令前瞻」而非「紧跟 rm 的选项」匹配，覆盖 `rm file -rf` 这类选项在文件名之后的写法。
  /\brm\b(?=[^;&\n]*(?:\s|^)--?[a-zA-Z]*[rRf][a-zA-Z]*)/i,
  /\brmdir\s+\/s/i,
  /\bgit\s+push\b[^&\n]*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*[df]/i,
  /\bgit\s+checkout\s+-f/i,
  /\bmkfs/i,
  /\bsudo\b/i,
  /\bdd\b[^;&\n]*of=(\/dev\/|\/tmp\/)/i,
  /\b(reboot|shutdown|poweroff|halt)\b/i,
  /\bchmod\s+-R\s+777/i,
  /\bchown\s+-R/i,
  /\bkill\s+-9/i,
  /curl\s+[^|&]*\|\s*(ba|z)?sh/i
]

/** pending 权限请求：requestId → 决策上下文 + resolver。 */
interface PendingRequest {
  sessionId: string
  toolName: string
  args: unknown
  /** 是否命中破坏性命令模式（deny 兜底，决定 UI 是否提供「总是允许」）。 */
  denyHit: boolean
  /** 本条消息中需要人工确认的整批操作（batch-session / batch-always 一次性记录用）。 */
  batch: PermissionBatchItem[]
  /** 所属 assistant 消息引用：scope='batch' 自动放行以它为边界（identity 匹配）。 */
  assistantMessage: object
  resolve: (result?: BeforeToolCallResult) => void
}

const pending = new Map<string, PendingRequest>()

/** 本会话放行：bash 命令（sessionId → 词级前缀规则列表）。 */
const sessionBashAllow = new Map<string, string[]>()
/** 本会话放行：文件路径（sessionId → 路径集合）。 */
const sessionFileAllow = new Map<string, Set<string>>()

/**
 * 本批自动放行：sessionId → 放行作用到的 assistant 消息引用（对象 identity 匹配）。
 * 用户点了「允许本批全部」（scope='batch' 且 approved）后，同一条消息内剩余的未命中
 * 破坏性模式的危险工具直接放行。破坏性命令（denyHit）始终强制人工确认。
 */
const sessionBatchAutoAllow = new Map<string, object>()

/**
 * 本批自动拒绝：sessionId → 拒绝作用到的 assistant 消息引用。
 * 用户点了「拒绝本批全部」（scope='batch' 且拒绝）后，同一条消息内剩余的危险工具自动拒绝。
 */
const sessionBatchDeny = new Map<string, object>()

/** 清空某会话的本批自动放行 / 自动拒绝（agent_start 重置 / agent_end 释放时调用）。 */
export function clearRunAutoAllow(sessionId: string): void {
  sessionBatchAutoAllow.delete(sessionId)
  sessionBatchDeny.delete(sessionId)
}

/**
 * 创建 beforeToolCall 钩子（绑定 sessionId，用于推送权限请求）。
 * isVoiceAutoApprove：语音 run 判定（由 agent-manager 传入，实时查询 voiceRuns 标记）。
 * 语音会话没有人工确认入口（用户在说话，无法点确认卡片），因此语音 run 内非破坏性
 * 危险工具自动放行；破坏性命令（deny 兜底）与全局「跳过工具确认」一致，仍要求人工确认。
 * 返回 undefined = 放行；返回 { block } = 拦截（含用户拒绝/中止）。
 */
export function createBeforeToolCallHook(
  sessionId: string,
  isVoiceAutoApprove?: () => boolean
): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async (ctx, signal) => {
    const { toolCall } = ctx
    if (!DANGEROUS_TOOLS.has(toolCall.name)) return undefined

    // 计划模式：危险工具一律拦截，引导先提交计划（exit_plan_mode 审批）。
    // 例外：bash 的只读简单命令（ls / git status 等）在规划期放行，便于探索代码库。
    if (isPlanMode(sessionId)) {
      if (toolCall.name === 'bash') {
        const command = (ctx.args as { command?: string }).command?.trim() ?? ''
        if (evaluateReadonlyBash(command)) return undefined
      }
      log.info('计划模式拦截危险工具', { sessionId, toolName: toolCall.name })
      return {
        block: true,
        reason: '当前处于计划模式：请先调用 exit_plan_mode 提交计划并获得用户批准后再执行操作。'
      }
    }

    // 自动放行判定（bash 走三层规则；文件操作仅支持会话放行）
    let decision: 'allow' | 'ask'
    let denyHit = false
    if (toolCall.name === 'bash') {
      const command = (ctx.args as { command?: string }).command?.trim() ?? ''
      ;({ decision, denyHit } = evaluateBash(sessionId, command))
    } else {
      const path = (ctx.args as { path?: string }).path ?? ''
      decision = evaluateFile(sessionId, path)
    }
    if (decision === 'allow') return undefined
    // 语音模式：自动放行非破坏性危险工具（语音会话无人工确认入口）。
    // 复用「跳过工具确认」的语义：破坏性命令（denyHit）仍走人工确认/超时拒绝，不跳过。
    if (!denyHit && isVoiceAutoApprove?.()) {
      log.info('语音模式自动放行危险工具（破坏性命令除外）', {
        sessionId,
        toolName: toolCall.name
      })
      return undefined
    }
    // 全局「跳过工具确认」开关：开启时危险工具免确认直接放行；
    // 破坏性命令（deny 兜底）不可被覆盖，始终人工确认。实时读取，改后下一轮立即生效。
    if (!denyHit && db.getSetting<boolean>(SETTING_PERMISSION_AUTO_APPROVE)) {
      log.info('跳过工具确认设置生效，自动放行', { sessionId, toolName: toolCall.name })
      return undefined
    }
    // 批标记只作用于同一条 assistant 消息：引用不同说明已进入新一批，旧标记失效。
    const batchRef = sessionBatchAutoAllow.get(sessionId)
    const denyRef = sessionBatchDeny.get(sessionId)
    if (batchRef !== undefined && batchRef !== ctx.assistantMessage) {
      sessionBatchAutoAllow.delete(sessionId)
    }
    if (denyRef !== undefined && denyRef !== ctx.assistantMessage) {
      sessionBatchDeny.delete(sessionId)
    }
    // 用户点了「拒绝本批全部」：同一条消息内的剩余危险工具自动拒绝。
    if (sessionBatchDeny.get(sessionId) === ctx.assistantMessage) {
      log.info('本批已拒绝，自动拒绝剩余危险工具', { sessionId, toolName: toolCall.name })
      return { block: true, reason: '用户拒绝执行该工具' }
    }
    // 本批自动放行（未命中破坏性模式才生效）：同一条消息内的剩余危险工具直接放行。
    if (!denyHit && sessionBatchAutoAllow.get(sessionId) === ctx.assistantMessage) {
      log.info('本批自动放行危险工具', { sessionId, toolName: toolCall.name })
      return undefined
    }

    // 本条消息中需要人工确认的危险工具批（含当前）：供 renderer 批量条一次列全。
    const batch = countPendingBatch(sessionId, ctx.assistantMessage)
    const requestId = randomUUID()
    log.info('危险工具待用户确认', {
      sessionId,
      toolName: toolCall.name,
      denyHit,
      batchCount: batch.length,
      command:
        toolCall.name === 'bash'
          ? (ctx.args as { command?: string }).command?.slice(0, 200)
          : undefined
    })
    // 超时实时读取设置（秒 → ms）：0 = 一直等待，不设超时兜底。
    const timeoutSec = getPermissionTimeoutSec()
    const expiresAt = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : 0
    const payload: PermissionRequest = {
      requestId,
      sessionId,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      args: ctx.args,
      denyHit,
      batch,
      expiresAt
    }
    rendererClient.agentEvent.onPermissionRequest(payload)

    return new Promise<BeforeToolCallResult | undefined>((resolve) => {
      // 超时兜底：确认卡片无人响应（如用户在设置页、窗口被重建、应用失焦）时自动拒绝，
      // 避免 Agent 因 pending Promise 永久挂起。一直等待（timeoutSec = 0）时不设兜底。
      // renderer 侧依据 payload.expiresAt 同步显示倒计时并清理本地队列。
      const timer =
        timeoutSec > 0
          ? setTimeout(() => {
              pending.delete(requestId)
              log.warn('权限请求超时，自动拒绝', { sessionId, toolName: toolCall.name })
              resolve({ block: true, reason: '权限确认超时，已自动拒绝' })
            }, timeoutSec * 1000)
          : null
      // 支持 abort：agent.abort 时取消等待
      const finish = (result?: BeforeToolCallResult): void => {
        if (timer) clearTimeout(timer)
        pending.delete(requestId)
        resolve(result)
      }
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            log.warn('权限请求已中断', { sessionId, toolName: toolCall.name })
            finish({ block: true, reason: '已中断' })
          },
          { once: true }
        )
      }
      pending.set(requestId, {
        sessionId,
        toolName: toolCall.name,
        args: ctx.args,
        denyHit,
        batch,
        assistantMessage: ctx.assistantMessage,
        resolve: finish
      })
    })
  }
}

/**
 * 统计本条 assistant 消息中需要人工确认的危险工具批（含当前），每条附带一行摘要。
 * 用与钩子相同的判定（只读命令 / 白名单 / 会话放行会被剔除），供 renderer 批量条一次列全。
 */
function countPendingBatch(
  sessionId: string,
  assistantMessage: BeforeToolCallContext['assistantMessage']
): PermissionBatchItem[] {
  const calls = assistantMessage.content.filter((b): b is AgentToolCall => b.type === 'toolCall')
  const items: PermissionBatchItem[] = []
  for (const call of calls) {
    if (!DANGEROUS_TOOLS.has(call.name)) continue
    let denyHit = false
    if (call.name === 'bash') {
      const command = (call.arguments as { command?: string }).command?.trim() ?? ''
      const d = evaluateBash(sessionId, command)
      if (d.decision !== 'ask') continue
      denyHit = d.denyHit
    } else {
      const path = (call.arguments as { path?: string }).path ?? ''
      if (evaluateFile(sessionId, path) !== 'ask') continue
    }
    items.push({
      toolName: call.name,
      toolCallId: call.id,
      summary: summarizeBatchArgs(call.name, call.arguments),
      denyHit
    })
  }
  return items
}

/** 生成待确认批单条操作的一行摘要：只取决策所需的关键参数，避免把文件内容等大字段带进 payload。 */
function summarizeBatchArgs(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (toolName) {
    case 'bash':
      return str('command').trim()
    case 'write_file':
    case 'edit_file':
      return str('path')
    case 'install_skill':
      return str('name') || str('path')
    default:
      return str('path') || ''
  }
}

/** 读取「工具确认超时」设置（秒）：非法/未配置回退默认 60；0 = 一直等待。 */
function getPermissionTimeoutSec(): number {
  const v = db.getSetting<number>(SETTING_PERMISSION_TIMEOUT_SEC)
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : DEFAULT_PERMISSION_TIMEOUT_SEC
}

/** 是否为只读安全命令（简单命令 + 命中只读白名单）：计划模式与只读子代理的 bash 放行判定。 */
export function evaluateReadonlyBash(command: string): boolean {
  if (!command) return false
  return isSimpleCommand(command) && READONLY_COMMANDS.some((rule) => matchesRule(command, rule))
}

/** bash 命令判定：deny 优先，其次只读命令，再次计划预批准，再次持久白名单，最后会话放行。 */
function evaluateBash(
  sessionId: string,
  command: string
): { decision: 'allow' | 'ask'; denyHit: boolean } {
  if (!command) return { decision: 'ask', denyHit: false }
  if (DENY_PATTERNS.some((re) => re.test(command))) {
    return { decision: 'ask', denyHit: true }
  }
  if (evaluateReadonlyBash(command)) {
    return { decision: 'allow', denyHit: false }
  }
  // 计划批准时预登记的免确认命令（词级前缀匹配；deny 兜底已先行拦截）
  if (isPlanAllowedCommand(sessionId, command)) {
    return { decision: 'allow', denyHit: false }
  }
  const allowlist = db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
  if (allowlist.some((rule) => matchesRule(command, rule))) {
    return { decision: 'allow', denyHit: false }
  }
  const sessionRules = sessionBashAllow.get(sessionId) ?? []
  if (sessionRules.some((rule) => matchesRule(command, rule))) {
    return { decision: 'allow', denyHit: false }
  }
  return { decision: 'ask', denyHit: false }
}

/** 文件操作判定：仅支持本会话内对同一路径放行。 */
function evaluateFile(sessionId: string, path: string): 'allow' | 'ask' {
  if (path && sessionFileAllow.get(sessionId)?.has(path)) return 'allow'
  return 'ask'
}

/** 规则匹配：比较命令前 rule 词数个词是否完全相等（单/多词通用）。 */
function matchesRule(command: string, rule: string): boolean {
  const cmdWords = command.split(/\s+/).filter(Boolean)
  const ruleWords = rule.split(/\s+/).filter(Boolean)
  if (cmdWords.length < ruleWords.length) return false
  for (let i = 0; i < ruleWords.length; i++) {
    if (cmdWords[i] !== ruleWords[i]) return false
  }
  return true
}

/** 是否为简单命令（不含 shell 控制/重定向操作符），只读自动放行的前提。 */
function isSimpleCommand(command: string): boolean {
  return !/[;&|<>`]/.test(command) && !/\$\s*\(|\$\{/.test(command)
}

/** renderer 回传权限确认结果（scope 决定放行作用域），解除对应 pending Promise。 */
export function resolvePermission(
  requestId: string,
  approved: boolean,
  scope: PermissionScope = 'once'
): void {
  const req = pending.get(requestId)
  if (!req) {
    log.warn('收到未知权限请求的回执', { requestId, approved })
    return
  }
  pending.delete(requestId)
  if (scope === 'batch') {
    // 本批统一决策：允许则自动放行同批剩余工具，拒绝则自动拒绝同批剩余工具（以当前消息为边界）。
    if (approved) sessionBatchAutoAllow.set(req.sessionId, req.assistantMessage)
    else sessionBatchDeny.set(req.sessionId, req.assistantMessage)
  } else if (scope === 'batch-session') {
    // 整批放行 + 把批内每条命令/路径记入本会话放行（剩余工具经 evaluate 自动命中会话放行）。
    for (const item of req.batch) recordSessionAllowItem(req.sessionId, item)
  } else if (scope === 'batch-always') {
    // 整批放行 + 把批内每条 bash 非破坏性命令加入持久白名单。
    for (const item of req.batch) recordAlwaysAllowItem(req.sessionId, item)
  }
  if (!approved) {
    log.info('权限请求已拒绝', { requestId, toolName: req.toolName, scope })
    req.resolve({ block: true, reason: '用户拒绝执行该工具' })
    return
  }
  if (scope === 'session') recordSessionAllow(req)
  else if (scope === 'always') recordAlwaysAllow(req)
  log.info('权限请求已批准', { requestId, toolName: req.toolName, scope })
  req.resolve(undefined)
}

/** 记录本会话放行规则（bash 按命令词级前缀，文件按路径）。 */
function recordSessionAllow(req: PendingRequest): void {
  if (req.toolName === 'bash') {
    const command = (req.args as { command?: string }).command?.trim() ?? ''
    if (!command) return
    const list = sessionBashAllow.get(req.sessionId) ?? []
    if (!list.some((rule) => rule === command)) list.push(command)
    sessionBashAllow.set(req.sessionId, list)
  } else {
    const path = (req.args as { path?: string }).path ?? ''
    if (!path) return
    const set = sessionFileAllow.get(req.sessionId) ?? new Set<string>()
    set.add(path)
    sessionFileAllow.set(req.sessionId, set)
  }
}

/** 按批量条目记录本会话放行（batch-session 用；summary 即命令/路径）。 */
function recordSessionAllowItem(sessionId: string, item: PermissionBatchItem): void {
  if (item.toolName === 'bash') {
    const command = item.summary.trim()
    if (!command) return
    const list = sessionBashAllow.get(sessionId) ?? []
    if (!list.some((rule) => rule === command)) list.push(command)
    sessionBashAllow.set(sessionId, list)
  } else {
    const path = item.summary.trim()
    if (!path) return
    const set = sessionFileAllow.get(sessionId) ?? new Set<string>()
    set.add(path)
    sessionFileAllow.set(sessionId, set)
  }
}

/** 写入持久白名单（仅 bash 且未命中破坏性命令；deny 兜底不可被白名单覆盖）。 */
function recordAlwaysAllow(req: PendingRequest): void {
  if (req.toolName !== 'bash' || req.denyHit) return
  const command = (req.args as { command?: string }).command?.trim() ?? ''
  if (!command) return
  const list = db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
  if (!list.some((rule) => rule === command)) {
    list.push(command)
    db.setSetting(SETTING_BASH_ALLOWLIST, list)
    log.info('已加入 bash 白名单', { sessionId: req.sessionId, command })
  }
}

/** 按批量条目写入持久白名单（batch-always 用；仅 bash 且未命中破坏性命令）。 */
function recordAlwaysAllowItem(sessionId: string, item: PermissionBatchItem): void {
  if (item.toolName !== 'bash' || item.denyHit) return
  const command = item.summary.trim()
  if (!command) return
  const list = db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
  if (!list.some((rule) => rule === command)) {
    list.push(command)
    db.setSetting(SETTING_BASH_ALLOWLIST, list)
    log.info('已加入 bash 白名单', { sessionId, command })
  }
}
