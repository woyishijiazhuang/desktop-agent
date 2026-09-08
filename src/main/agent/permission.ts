import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { rendererClient } from '../service/render-client'
import { db } from '../database'
import { createLogger } from '../utils/log'
import { isPlanMode, isPlanRunAutoAllow } from './plan-mode'
import {
  getSessionWriteBoundary,
  isPathWithinAny,
  getSessionFsPolicy,
  isSandboxWriteAllowed,
  sandboxWriteDeniedMessage
} from './sandbox'
import {
  beginInteraction,
  respondInteraction,
  getInteractionCtx,
  getInteractionTimeoutMs
} from './interaction'
import type { PermissionScope } from './types'
import { SETTING_PERMISSION_AUTO_APPROVE } from './types'

const log = createLogger('permission')

/**
 * 危险工具执行前的权限拦截（判定收敛后的单一决策引擎）。
 *
 * 决策档位只有三档：
 * - allow：免确认放行（只读命令 / 持久白名单 / 会话放行 / 工作区内写文件 / run 自动放行）
 * - ask（soft）：需要人工确认，可提供「本会话放行 / 总是允许（仅 bash）」
 * - ask（hardAsk，命中破坏性 deny）：强制人工确认，不可会话/总是/自动放行覆盖
 *
 * bash 命令决策顺序（deny 优先于一切 allow，对齐主流 Agent 客户端）：
 * 1. 命中 DENY_PATTERNS（破坏性）→ ask(hardAsk)；
 * 2. 只读简单命令 → allow（消除 ls/git status 等日常确认）；
 * 3. 命中持久白名单（bashAllowlist，用户点过「总是允许」）→ allow；
 * 4. 命中本会话放行（用户点过「本会话允许」）→ allow；
 * 5. run 自动放行（计划已批准 / 语音 run / 「跳过工具确认」）→ allow；
 * 6. 其余 → ask。
 *
 * write_file / edit_file：
 * 1. 目标路径位于「会话可写边界」（工作区 + 可写目录 + 系统临时目录）内 → allow；
 * 2. 命中本会话路径放行 → allow；
 * 3. 其余 → ask。文件型操作无持久白名单（路径型 always 意义有限），仅支持会话放行。
 *
 * install_skill：从外部平台下载并落盘不可信代码，恒 ask（仅本次，无会话/总是放行）。
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

/** 本会话放行：bash 命令（sessionId → 词级前缀规则列表）。 */
const sessionBashAllow = new Map<string, string[]>()
/** 本会话放行：文件路径（sessionId → 路径集合）。 */
const sessionFileAllow = new Map<string, Set<string>>()

/**
 * 决策结果：
 * - allow：直接放行（reason 仅日志用）
 * - ask：需人工确认；hardAsk=true 表示命中破坏性 deny（UI 不给会话/总是，也不受 run 自动放行覆盖）
 */
type ToolDecision =
  { decision: 'allow'; reason?: string } | { decision: 'ask'; hardAsk: boolean; target: string }

/** 挂起权限请求登记给交互通道的上下文（回执时记录放行规则用）。 */
interface PermissionCtx {
  sessionId: string
  toolName: string
  /** 放行规则目标：bash=命令原文，write/edit=路径。 */
  target: string
  hardAsk: boolean
}

/** 是否为只读安全命令（简单命令 + 命中只读白名单）：计划模式与只读子代理的 bash 放行判定。 */
export function evaluateReadonlyBash(command: string): boolean {
  if (!command) return false
  return isSimpleCommand(command) && READONLY_COMMANDS.some((rule) => matchesRule(command, rule))
}

/** bash 命令决策：deny 优先，其次只读，其次持久白名单，其次会话放行。 */
function decideBash(sessionId: string, command: string): ToolDecision {
  if (!command) return { decision: 'ask', hardAsk: false, target: '' }
  if (DENY_PATTERNS.some((re) => re.test(command))) {
    return { decision: 'ask', hardAsk: true, target: command }
  }
  if (evaluateReadonlyBash(command)) return { decision: 'allow', reason: '只读命令' }
  const allowlist = db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
  if (allowlist.some((rule) => matchesRule(command, rule))) {
    return { decision: 'allow', reason: '持久白名单' }
  }
  const sessionRules = sessionBashAllow.get(sessionId) ?? []
  if (sessionRules.some((rule) => matchesRule(command, rule))) {
    return { decision: 'allow', reason: '本会话放行' }
  }
  return { decision: 'ask', hardAsk: false, target: command }
}

/** 文件操作决策：可写边界内自动放行 → 本会话同路径放行 → ask。 */
async function decideFile(sessionId: string, path: string): Promise<ToolDecision> {
  if (!path) return { decision: 'ask', hardAsk: false, target: '' }
  const boundary = await getSessionWriteBoundary(sessionId)
  if (
    isPathWithinAny(path, boundary.allowWriteRoots) &&
    !isPathWithinAny(path, boundary.denyReadRoots)
  ) {
    return { decision: 'allow', reason: '可写边界内' }
  }
  if (sessionFileAllow.get(sessionId)?.has(path)) {
    return { decision: 'allow', reason: '本会话路径放行' }
  }
  return { decision: 'ask', hardAsk: false, target: path }
}

/** run 是否处于自动放行态（计划已批准 / 语音 run / 「跳过工具确认」任一生效）。 */
function isRunAutoAllowed(sessionId: string, isVoiceAutoApprove?: () => boolean): boolean {
  if (isPlanRunAutoAllow(sessionId)) {
    log.debug('计划已批准：本轮危险工具自动放行', { sessionId })
    return true
  }
  if (isVoiceAutoApprove?.()) {
    log.debug('语音 run：危险工具自动放行（破坏性命令除外）', { sessionId })
    return true
  }
  if (db.getSetting<boolean>(SETTING_PERMISSION_AUTO_APPROVE)) {
    log.debug('「跳过工具确认」生效：危险工具自动放行', { sessionId })
    return true
  }
  return false
}

/** 生成待确认单条操作的一行摘要：只取决策所需的关键参数，避免把文件内容等大字段带进载荷。 */
function summarizeToolArgs(toolName: string, args: unknown): string {
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

/**
 * 创建 beforeToolCall 钩子（绑定 sessionId，用于推送权限请求）。
 * isVoiceAutoApprove：语音 run 判定（由 agent-manager 传入，实时查询 voiceRuns 标记）。
 * 语音会话没有人工确认入口，因此 run 自动放行涵盖语音；破坏性命令（hardAsk）仍要求人工。
 * 返回 undefined = 放行；返回 { block } = 拦截（用户拒绝 / 超时 / 中止 / 计划模式）。
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

    const args = ctx.args as { command?: string; path?: string } | undefined
    let decision: ToolDecision
    if (toolCall.name === 'bash') {
      decision = decideBash(sessionId, args?.command?.trim() ?? '')
    } else if (toolCall.name === 'write_file' || toolCall.name === 'edit_file') {
      const path = args?.path ?? ''
      // 沙箱开启时区外写入不可被人工放行（执行层/OS 沙箱必拒），直接按沙箱口径拒绝，
      // 不弹确认条——避免「确认允许 → 执行层又硬拒」的假确认（见 sandbox.ts 文件域策略）。
      const policy = await getSessionFsPolicy(sessionId)
      if (policy && path && !isSandboxWriteAllowed(policy, path)) {
        log.info('沙箱开启，区外写入直接拒绝（不弹确认）', { sessionId, toolName: toolCall.name, path })
        return { block: true, reason: sandboxWriteDeniedMessage(path) }
      }
      decision = await decideFile(sessionId, path)
    } else {
      decision = {
        decision: 'ask',
        hardAsk: false,
        target: summarizeToolArgs(toolCall.name, ctx.args)
      }
    }
    if (decision.decision === 'allow') return undefined
    // 破坏性命令（hardAsk）不可被 run 自动放行 / 会话放行覆盖，始终强制人工确认。
    if (!decision.hardAsk && isRunAutoAllowed(sessionId, isVoiceAutoApprove)) return undefined

    const denyHit = decision.decision === 'ask' && decision.hardAsk
    const summary = summarizeToolArgs(toolCall.name, ctx.args)
    log.info('危险工具待用户确认', {
      sessionId,
      toolName: toolCall.name,
      denyHit,
      summary: summary.slice(0, 200)
    })
    const timeoutMs = getInteractionTimeoutMs()
    const expiresAt = timeoutMs > 0 ? Date.now() + timeoutMs : 0
    const slot = beginInteraction<{ allowed: boolean; blockedReason: string }>({
      kind: 'tool_permission',
      sessionId,
      timeoutMs,
      signal,
      ctx: {
        sessionId,
        toolName: toolCall.name,
        target: summary,
        hardAsk: denyHit
      } satisfies PermissionCtx,
      onTimeout: () => ({ allowed: false, blockedReason: '权限确认超时，已自动拒绝' }),
      onAbort: () => ({ allowed: false, blockedReason: '已中断' })
    })
    rendererClient.agentEvent.onInteractionRequest({
      kind: 'tool_permission',
      requestId: slot.requestId,
      sessionId,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      summary,
      denyHit,
      expiresAt
    })
    const outcome = await slot.promise
    if (outcome.allowed) return undefined
    log.info('危险工具未获放行', {
      sessionId,
      toolName: toolCall.name,
      reason: outcome.blockedReason
    })
    return { block: true, reason: outcome.blockedReason }
  }
}

/** renderer 回传权限确认结果（scope 决定放行作用域），解除对应挂起。 */
export function resolvePermission(
  requestId: string,
  approved: boolean,
  scope: PermissionScope = 'once'
): void {
  const ctx = getInteractionCtx(requestId) as PermissionCtx | undefined
  if (!ctx) {
    log.warn('收到未知权限请求的回执', { requestId, approved })
    return
  }
  if (!approved) {
    log.info('权限请求已拒绝', { requestId, toolName: ctx.toolName, scope })
    respondInteraction(requestId, { allowed: false, blockedReason: '用户拒绝执行该工具' })
    return
  }
  if (scope === 'session') recordSessionAllow(ctx)
  else if (scope === 'always') recordAlwaysAllow(ctx)
  log.info('权限请求已批准', { requestId, toolName: ctx.toolName, scope })
  respondInteraction(requestId, { allowed: true, blockedReason: '' })
}

/** 记录本会话放行规则（bash 按命令词级前缀，write/edit 按路径；install_skill 仅本次）。 */
function recordSessionAllow(ctx: PermissionCtx): void {
  if (ctx.toolName === 'bash') {
    const command = ctx.target
    if (!command) return
    const list = sessionBashAllow.get(ctx.sessionId) ?? []
    if (!list.some((rule) => rule === command)) list.push(command)
    sessionBashAllow.set(ctx.sessionId, list)
  } else if (ctx.toolName === 'write_file' || ctx.toolName === 'edit_file') {
    const path = ctx.target
    if (!path) return
    const set = sessionFileAllow.get(ctx.sessionId) ?? new Set<string>()
    set.add(path)
    sessionFileAllow.set(ctx.sessionId, set)
  }
}

/** 写入持久白名单（仅 bash 且未命中破坏性命令；deny 兜底不可被白名单覆盖）。 */
function recordAlwaysAllow(ctx: PermissionCtx): void {
  if (ctx.toolName !== 'bash' || ctx.hardAsk) return
  const command = ctx.target
  if (!command) return
  const list = db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
  if (!list.some((rule) => rule === command)) {
    list.push(command)
    db.setSetting(SETTING_BASH_ALLOWLIST, list)
    log.info('已加入 bash 白名单', { sessionId: ctx.sessionId, command })
  }
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
