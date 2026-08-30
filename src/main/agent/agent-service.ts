import { IpcService } from 'electron-ipc-service'
import { clipboard, dialog } from 'electron'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import { rendererClient } from '../service/render-client'
import { db } from '../database'
import { toCreateMessageParams, fromMessageRow, persistMessageImages } from './convert'
import { extractMessageText } from '../utils/message-text'
import { readAttachmentDataUrl, deleteAttachmentFile, collectFileRefs } from './attachment'
import { listTools } from './tools'
import { testWebSearchConnection } from './tools/web-search'
import {
  getFindSkillSource,
  setFindSkillSourceConfig,
  testFindSkillConnection
} from './tools/find-skill'
import {
  listInstalledSkills as listInstalledSkillsStore,
  setSkillEnabled as setSkillEnabledStore,
  uninstallSkill as uninstallSkillStore,
  openSkillsDir as openSkillsDirStore,
  readSkillFile
} from './skills-store'
import {
  hasWebSearchApiKey,
  setWebSearchApiKeyConfig,
  clearWebSearchApiKeyConfig
} from './web-search-config'
import { resolvePermission, SETTING_BASH_ALLOWLIST } from './permission'
import { resolvePlanApproval } from './plan-mode'
import { resolveAskUser } from './ask-user'
import { extractDocumentText } from '../utils/doc-parser'
import { completeText, type CompleteTextResult } from './models'
import { resolveAssistantCost } from './model-config'
import { AgentManager } from './agent-manager'
import { createLogger } from '../utils/log'
import type {
  FindSkillSource,
  InstalledSkill,
  ThinkingLevel,
  ToolInfo,
  PermissionScope
} from './types'
import {
  isThinkingLevel,
  SETTING_AGENT_WORKDIR,
  SETTING_WELCOME_SUGGESTIONS,
  SETTING_AUTO_COMPRESS_ENABLED,
  SETTING_AUTO_COMPRESS_THRESHOLD,
  DEFAULT_AUTO_COMPRESS_THRESHOLD
} from './types'
import { resolveAgentWorkdir } from './workdir'
import { refreshShellEnv } from '../utils/shell-env'
import { notifyAgentFinished } from '../service/notifier'
import { isDeepEqual } from '../utils/deep-equal'
import { estimateTokens, truncateMiddle } from '../utils/token'

const log = createLogger('agent')

/** 压缩时保留的最近消息条数（其余摘要化）。 */
const COMPRESS_KEEP_COUNT = 6
/**
 * 自适应压缩目标：压缩后「摘要 + 活跃消息」尽量降到 压缩阈值 × 该比例 以下，
 * 留出增长空间，避免达到阈值后每一轮都触发压缩。
 */
const COMPRESS_HEADROOM = 0.7
/** 摘要容量上限（占模型窗口比例）：超过则触发摘要浓缩，防止摘要无限增长撑爆窗口。 */
const SUMMARY_MAX_FRACTION = 0.15
/** 压缩调用为模型输出预留的 token 预算（截断输入时使用）。 */
const COMPRESS_OUTPUT_BUDGET = 2048

/**
 * 压缩结果：compressed=false 表示无新增可压缩内容（非错误，UI 按普通提示展示，
 * 而非 error）。reason 为该场景的说明文案。
 */
export interface CompressResult {
  compressed: boolean
  reason?: string
}

/**
 * 压缩摘要系统提示（结构化模板）。
 * 核心要求：逐条保留全部用户消息原文（用户意图是压缩时最容易丢失的信息），
 * 其余内容（助手回复 / 工具细节）按分节浓缩，便于增量合并时无损继承旧摘要。
 */
const COMPRESS_SYSTEM_PROMPT =
  '你是一个对话摘要助手。下面是该会话「此前已生成的摘要」与「新增对话内容」，请把它们合并为一份新摘要，供未来对话作为背景上下文。直接输出摘要文本。\n' +
  '新摘要按以下结构组织：\n' +
  '## 用户原话\n' +
  '- 逐条保留全部用户消息的原文（含此前摘要中已有的），按时间顺序一条一行，一字不改，编号列出。\n' +
  '## 关键事实\n' +
  '- 来自助手回复与工具执行的关键信息：项目背景、技术选型、关键代码或配置、约束条件等。\n' +
  '## 已做决定\n' +
  '- 对话中已确认的决策。\n' +
  '## 待办事项\n' +
  '- 尚未完成的任务、下一步计划。\n' +
  '规则：与此前摘要重复的信息不重复展开；忽略寒暄与无关细节；不要输出本说明以外的内容。'

/** 欢迎页建议生成系统提示：根据用户环境信息产出可立即开始的开场建议。 */
const WELCOME_SUGGEST_SYSTEM_PROMPT =
  '你是一个对话开场建议生成助手。根据给定的用户环境信息，生成 4 条简短、具体、可直接开始的中文提问或任务建议，用于 AI 助手欢迎页的快捷入口。' +
  '要求：每条不超过 25 字；每条独立成行；不要编号；不要引号；不要空行；不要任何解释或前后缀。'

/** 图表重新生成的系统提示：只输出可渲染的 echarts 配置，不解释。 */
const CHART_REGEN_SYSTEM_PROMPT =
  '你是数据可视化专家。根据用户提供的 ECharts 配置与渲染错误信息，修正配置使其能正常渲染。' +
  '常见需要修正的问题：仅接受函数的字段被写成字符串（如 tooltip.valueFormatter，需移除）；' +
  '无效的坐标系组合（geo 上使用 line 系列、series 引用了不存在的 xAxis/yAxis/geo）；JSON 语法错误（注释、尾逗号、单引号）。' +
  '要求：只输出一个 ```echarts 代码块（内容为修正后的 JSON 配置，不写注释、不含函数或 JS 代码），不要输出任何解释；' +
  '务必对原始配置做出实际修改，禁止原样返回。'

/** 组装图表修正的用户提示；retry=true 时追加「上一轮原样返回」的更强指令。 */
function buildFixPrompt(error: string, config: string, retry: boolean): string {
  const lines = [
    '以下 ECharts 配置渲染失败，请根据错误信息修正后重新输出。',
    `错误信息：${error}`,
    `原始配置：\n\`\`\`echarts\n${truncateMiddle(config, 4000)}\n\`\`\``
  ]
  if (retry) {
    lines.push(
      '注意：你上一轮返回了与原始配置完全相同的配置，未能解决问题。请重新分析错误信息，' +
        '找出具体需要修改的地方（如移除仅接受函数的字段、修正无效的坐标系组合、修复 JSON 语法），输出修正后的配置。'
    )
  }
  return lines.join('\n\n')
}

/** 判断模型返回的配置与原始配置是否实质相同（解析后深比较，键序无关；解析失败回退文本比较）。 */
function isSameConfig(extracted: string, original: string): boolean {
  try {
    return isDeepEqual(JSON.parse(extracted), JSON.parse(original))
  } catch {
    return extracted.trim() === original.trim()
  }
}

/** 从模型回复中提取 echarts JSON 文本：优先 ```echarts 围栏，其次 ```json 围栏，最后尝试整体文本。 */
function extractEChartsConfig(text: string): string | null {
  const echartsFence = /```echarts\s*\n([\s\S]*?)\n```/.exec(text)
  if (echartsFence) return echartsFence[1].trim()
  const jsonFence = /```json\s*\n([\s\S]*?)\n```/.exec(text)
  if (jsonFence) return jsonFence[1].trim()
  const trimmed = text.trim()
  return trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : null
}

/**
 * 在消息内容（markdown 文本或 text block 数组）中定位旧 echarts 块并替换为新配置。
 * 以「围栏内容与旧配置一致」精确定位（多图表消息也不误伤）；内容不一致且全文仅一个
 * echarts 块时兜底替换该块。定位不到时抛错（调用方据此报错、不改动原消息）。
 */
function replaceEChartsBlock(content: unknown, oldConfig: string, newConfig: string): unknown {
  const replaceInText = (md: string): string | null => {
    const fences = [...md.matchAll(/```echarts\s*\n([\s\S]*?)\n```/g)]
    if (fences.length === 0) return null
    const target =
      fences.find((f) => f[1].trim() === oldConfig.trim()) ??
      (fences.length === 1 ? fences[0] : undefined)
    if (!target) return null
    const start = target.index ?? 0
    const end = start + target[0].length
    return `${md.slice(0, start)}\`\`\`echarts\n${newConfig}\n\`\`\`${md.slice(end)}`
  }
  if (typeof content === 'string') {
    const next = replaceInText(content)
    if (next === null) throw new Error('未能在消息中找到对应的 echarts 代码块')
    return next
  }
  if (Array.isArray(content)) {
    let replaced = false
    const blocks = content.map((b) => {
      if (replaced || !b || typeof b !== 'object') return b
      const block = b as { type?: string; text?: unknown }
      if (block.type !== 'text' || typeof block.text !== 'string') return b
      const next = replaceInText(block.text)
      if (next === null) return b
      replaced = true
      return { ...block, text: next }
    })
    if (!replaced) throw new Error('未能在消息中找到对应的 echarts 代码块')
    return blocks
  }
  throw new Error('消息内容格式不支持就地替换')
}

/**
 * Agent 运行时服务：管理每会话的 Agent 实例，桥接事件到 renderer。
 * - 实例生命周期（创建/LRU 淘汰/事件桥）委托给 AgentManager
 * - 事件通过 rendererClient.agentEvent.onEvent 推送（沿用 UiService.windowStateChange 模式）
 * - prompt 不 await，让 agent 后台跑，事件流推送更新
 */
export class AgentService extends IpcService {
  static override readonly namespace = 'agent'
  private manager = new AgentManager()
  /** 正在压缩的会话 id 集合：同会话压缩互斥（压缩耗时长且依赖乐观锁写入，并发会导致版本冲突）。 */
  private compressLocks = new Set<string>()

  // ==================== 对话控制 ====================

  /**
   * 发送一条用户消息：正文 + 指定技能 + 文件附件（解析后的文本）按块组装为 user 消息。
   * 技能块带 skill_name（模型侧按 text 消费技能 SKILL.md 全文，renderer 据此渲染技能卡片）；
   * 文件块带 file_name（模型侧仍按 text 消费，renderer 据此按文件卡片渲染）。
   * 传整条 userMsg 给 agent（Agent.prompt 支持消息数组），图片以 base64 原样入模型，
   * 落库时 persistMessageImages 再把图片转本地文件引用。
   */
  async prompt(
    sessionId: string,
    text: string,
    images?: ImageContent[],
    files?: { name: string; text: string }[],
    skills?: string[]
  ): Promise<void> {
    log.info('发送消息', {
      sessionId,
      text: text.trim().slice(0, 200),
      textLength: text.length,
      imageCount: images?.length ?? 0,
      fileCount: files?.length ?? 0,
      skillCount: skills?.length ?? 0
    })
    // 自动压缩：未压缩上下文接近模型窗口上限时静默摘要旧历史（失败不阻断对话）
    await this.autoCompressIfNeeded(sessionId)
    // 用户指定技能：读取其 SKILL.md 全文注入消息（不存在/停用/读取失败时跳过该技能）
    const skillBlocks = await Promise.all(
      (skills ?? []).map(async (id) => {
        try {
          // 停用技能不注入：与「停用 = 彻底不可用」语义一致（聊天框已过滤，此处兜底）
          const entry = listInstalledSkillsStore().find((s) => s.id === id)
          if (entry && !entry.enabled) return null
          const content = await readSkillFile(id, 'SKILL.md')
          return { type: 'text' as const, text: content, skill_name: id }
        } catch (err) {
          log.warn('跳过无法读取的技能', {
            sessionId,
            skill: id,
            error: err instanceof Error ? err.message : String(err)
          })
          return null
        }
      })
    )
    const agent = await this.manager.getOrCreateAgent(sessionId)
    // 新一轮 run：重置轮次计数与超限标记
    this.manager.resetRunState(sessionId)
    // 兜底：renderer 状态异常时防止向运行中的 Agent 重复 prompt（行为未定义）
    if (agent.signal) {
      log.warn('检测到向运行中的 Agent 重复发送消息，已拒绝', { sessionId })
      throw new Error('该会话正在生成中，请等待完成或先中止')
    }
    const blocks: (
      | ImageContent
      | { type: 'text'; text: string }
      | { type: 'text'; text: string; file_name: string }
      | { type: 'text'; text: string; skill_name: string }
    )[] = [
      ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ...skillBlocks.filter(
        (b): b is { type: 'text'; text: string; skill_name: string } => b !== null
      ),
      ...(files ?? []).map((f) => ({ type: 'text' as const, text: f.text, file_name: f.name })),
      ...(images ?? [])
    ]
    // user 消息立即落库（assistant/toolResult 在 message_end 落库）；
    // 图片先落盘为本地附件，content 只存 file 引用（避免 base64 撑爆数据库）
    const userMsg: AgentMessage = {
      role: 'user',
      content: blocks,
      timestamp: Date.now()
    }
    const dbMsg = await persistMessageImages(sessionId, userMsg)
    db.createMessage(toCreateMessageParams(sessionId, dbMsg))
    // 用户主动操作：刷新 last_active_at（会话列表置顶），并把更新广播给 renderer
    //（否则会话侧栏排序不会即时反映「发消息置顶」）。
    const touched = db.touchSession(sessionId)
    rendererClient.agentEvent.onSessionUpdate(touched)
    // 标题生成：仅首条用户消息触发（title 仍为默认时），与 assistant 回复并行
    void this.manager.generateTitle(sessionId, text)
    // 不 await：让 agent 在后台跑，事件通过 subscribe 推送
    void agent.prompt([userMsg]).catch((err) => {
      log.error('prompt 运行失败', { sessionId, error: err })
      // agent_end 已由事件桥推送（错误/中止均携带）时不补发，
      // 避免第二个无 error 的 agent_end 覆盖真实失败态（错误轮次不弹错、重试条丢失）。
      if (this.manager.hasRunEnded(sessionId)) return
      // 兜底：确保 renderer 收到结束信号解除 busy
      rendererClient.agentEvent.onEvent({
        sessionId,
        event: { type: 'agent_end', messages: agent.state.messages }
      })
      // 兜底路径也补一条失败通知（事件桥未推送 agent_end 时）
      void notifyAgentFinished({
        title: '任务出错',
        body: err instanceof Error ? err.message : String(err)
      })
    })
  }

  // ==================== 附件（剪贴板截图） ====================

  /** 读取剪贴板图片（截图粘贴场景）：返回 PNG base64；剪贴板无图片时返回 null。 */
  async readClipboardImage(): Promise<{ mimeType: string; base64: string } | null> {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    return { mimeType: 'image/png', base64: image.toPNG().toString('base64') }
  }

  /**
   * 解析聊天中附加的文档（docx / pdf / xlsx / pptx / csv）为 Markdown 文本。
   * 渲染层把文件字节传过来，主进程用 mdize 解析后返回文本，作为消息上下文发送。
   * 解析结果有大小上限（见 doc-parser.MAX_EXTRACT_CHARS），超长自动截断。
   */
  async parseDocumentFile(buffer: Uint8Array, filename: string): Promise<string> {
    return extractDocumentText(buffer, filename)
  }

  /** 设置页测试通知：发送一条测试桌面通知并返回结果。 */
  async testNotification(): Promise<{ success: boolean; error?: string }> {
    return notifyAgentFinished({ title: '测试通知', body: '通知功能正常工作！' })
  }

  async abort(sessionId: string): Promise<void> {
    const agent = this.manager.getAgent(sessionId)
    if (agent?.signal) {
      log.info('中止生成', { sessionId })
    }
    agent?.abort()
  }

  /**
   * 实时更新某会话的思考级别：直接改写内存 Agent 的 state.thinkingLevel
   *（每轮流式请求时读取，当前轮结束后下一轮生效），无需驱逐重建。
   * 会话行（session.thinking_level）由 renderer 侧 updateSession 写入；
   * 若 Agent 尚未创建，下次 createAgent 会从会话行读取新值。
   */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    if (!isThinkingLevel(level)) return
    const agent = this.manager.getAgent(sessionId)
    if (agent) {
      log.debug('更新思考级别', { sessionId, level })
      agent.state.thinkingLevel = level
    }
  }

  steer(sessionId: string, text: string): void {
    log.debug('steer', { sessionId, text: text.slice(0, 100) })
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now()
    }
    this.manager.getAgent(sessionId)?.steer(msg)
  }

  followUp(sessionId: string, text: string): void {
    log.debug('followUp', { sessionId, text: text.slice(0, 100) })
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now()
    }
    this.manager.getAgent(sessionId)?.followUp(msg)
  }

  async continue_(sessionId: string): Promise<void> {
    log.debug('continue', { sessionId })
    // 新一轮 run：重置轮次计数与超限标记
    this.manager.resetRunState(sessionId)
    await this.manager.getAgent(sessionId)?.continue()
  }

  /**
   * 重试上一次失败的对话：删除末尾失败 assistant、驱逐内存 agent、从 DB rehydrate
   *（transcript 末尾即失败的用户/工具结果消息），再 continue 重跑 assistant 回复。
   * 不产生重复用户消息。先同步清理后的 transcript 给 renderer，剔除残留旧气泡。
   */
  async retry(sessionId: string): Promise<void> {
    await this.manager.rerunAssistant(sessionId, (id) => this.pruneTrailingFailedAssistants(id))
  }

  /**
   * 重新生成最后一条 assistant 回复：删除末尾的 assistant 消息（无论成功/失败/中止）、
   * 驱逐内存 agent、从 DB rehydrate（末尾回到该 assistant 之前的 user/toolResult 消息），
   * 再 continue 重跑 assistant 回复。不产生重复用户消息。先同步清理后的 transcript 给
   * renderer，剔除旧 assistant 行。仅当末条为 assistant 时有效（UI 仅在此情形暴露该操作）。
   */
  async regenerate(sessionId: string): Promise<void> {
    await this.manager.rerunAssistant(sessionId, (id) => this.pruneLastAssistant(id))
  }

  /**
   * 重新生成图表（EChartsBlock「重新生成」按钮）：
   * 发起一次**独立** LLM 请求（不写入对话记录/transcript，不占用会话轮次），携带错误
   * 信息与原始配置让模型修正；成功后把新配置**就地替换**回原消息中的 ```echarts 块
   *（保留消息其余内容），再推 message_update 让 renderer 重新渲染。会话 agent 一并
   * 驱逐，使后续轮次的模型上下文也能读到修正后的配置。仅此一次请求，token 消耗最小。
   * 任一步失败抛错，由 renderer 提示（不改动原消息）。
   */
  async regenerateChart(
    sessionId: string,
    messageId: number,
    error: string,
    config: string
  ): Promise<void> {
    const model = this.manager.resolveAuxModel(sessionId)
    if (!model) throw new Error('无可用模型，请先在设置中添加模型')
    // 生成修正配置：模型「未输出配置」或「原样返回」都判定为未修正，带更强指令重试一次
    //（最多两次调用，控制 token 消耗）
    let newConfig: string | null = null
    for (let attempt = 0; attempt < 2 && !newConfig; attempt++) {
      const res = await completeText(
        CHART_REGEN_SYSTEM_PROMPT,
        buildFixPrompt(error, config, attempt > 0),
        model
      )
      this.recordChartFixUsage(sessionId, res)
      const extracted = extractEChartsConfig(res.text)
      if (extracted && !isSameConfig(extracted, config)) newConfig = extracted
    }
    if (!newConfig) throw new Error('模型未能生成可用的 ECharts 配置，请重试')
    const row = db.getMessage(messageId)
    if (!row) throw new Error('目标消息不存在或已被删除')
    const nextContent = replaceEChartsBlock(row.content, config, newConfig)
    const updated = db.updateMessage(messageId, { content: nextContent })
    // 驱逐该会话内存 agent：缓存 transcript 里的旧配置已过时，下一轮从 DB rehydrate 修正后内容
    await this.manager.evictSession(sessionId, '图表重新生成')
    log.info('图表已重新生成并就地替换', { sessionId, messageId })
    rendererClient.agentEvent.onEvent({
      sessionId,
      event: {
        type: 'message_end',
        // fromMessageRow 不携带 DB id，此处补上：renderer 的 data-mid/搜索定位依赖 id
        message: { ...fromMessageRow(updated), id: updated.id } as unknown as AgentMessage
      }
    })
  }

  /** 图表修正的独立补全计入 token 统计（复用 chat 口径，避免改 usage_logs 表结构）。 */
  private recordChartFixUsage(sessionId: string, res: CompleteTextResult): void {
    db.recordUsage({
      sessionId,
      kind: 'chat',
      provider: res.provider,
      model: res.model,
      promptTokens: res.usage.input,
      completionTokens: res.usage.output,
      cost: resolveAssistantCost(res.provider, res.usage, res.timestamp, res.usage.cost.total),
      timestamp: res.timestamp
    })
  }

  /**
   * 回收最后一条用户消息（失败的那条）：删除末尾失败 assistant + 该 user 消息、
   * 驱逐内存 agent。返回是否实际回收（仅当末尾是 user 消息时才回收，避免破坏
   * 工具调用中途失败的 transcript）。renderer 随后 reload 同步列表并回填输入框。
   */
  async recallLastUserMessage(sessionId: string): Promise<boolean> {
    this.pruneTrailingFailedAssistants(sessionId)
    const rows = db.listMessagesBySession(sessionId)
    const last = rows[rows.length - 1]
    if (!last || last.role !== 'user') {
      log.debug('回收最后一条用户消息：末尾非 user 消息，跳过', { sessionId })
      return false
    }
    db.deleteMessage(last.id)
    // 删除消息引用的本地附件（避免孤儿文件）
    for (const key of collectFileRefs(last.content)) {
      void deleteAttachmentFile(key)
    }
    await this.manager.evictSession(sessionId, '消息回收')
    log.info('已回收最后一条用户消息', { sessionId, messageId: last.id })
    return true
  }

  // ==================== 会话压缩 ====================

  /**
   * 自动压缩：发送消息前估算「未压缩上下文」的 token 量，达到模型窗口阈值时静默压缩。
   * - 触发时机：prompt() 入口（用户消息落库前），压缩后新建的 Agent 从压缩态 rehydrate
   * - 仅压缩空闲会话：运行中的 Agent 不能驱逐（会打断生成），本函数内跳过
   * - 估算包含「活跃消息 + 压缩摘要」：摘要过长也会触发压缩（走摘要浓缩），
   *   防止摘要本身无限增长最终撑爆模型窗口
   * - 失败只记日志，绝不阻断本次对话（下一轮再试）
   */
  private async autoCompressIfNeeded(sessionId: string): Promise<void> {
    try {
      if (db.getSetting<boolean>(SETTING_AUTO_COMPRESS_ENABLED) === false) return
      // 运行中的会话不自动压缩（evict 会 abort 正在进行的生成）
      const running = this.manager.getAgent(sessionId)
      if (running?.signal) return
      const session = db.getSession(sessionId)
      if (!session) return
      const contextWindow = this.manager.resolveAuxModel(sessionId)?.contextWindow ?? 0
      if (contextWindow <= 0) return
      const threshold = this.getCompressThreshold()
      const limit = (contextWindow * threshold) / 100
      const allRows = db.listMessagesBySession(sessionId)
      // 活跃窗口：压缩指针之后的消息，每次调用都会完整进入模型上下文
      const active = allRows.filter(
        (r) => session.compressLastIndex === null || r.id > session.compressLastIndex
      )
      const activeTokens = active.reduce((sum, r) => {
        const m = fromMessageRow(r)
        return sum + estimateTokens(extractMessageText((m as { content: unknown }).content))
      }, 0)
      const summaryTokens = estimateTokens(session.compressSummary ?? '')
      // 摘要超过容量上限也必须触发（压缩时浓缩），否则摘要持续吃掉上下文
      const summaryOversize = summaryTokens > contextWindow * SUMMARY_MAX_FRACTION
      if (activeTokens + summaryTokens < limit && !summaryOversize) return
      log.info('触发自动压缩', {
        sessionId,
        activeTokens,
        summaryTokens,
        contextWindow,
        threshold
      })
      const result = await this.compressSession(sessionId)
      if (result.compressed) {
        log.info('自动压缩完成', { sessionId })
      }
    } catch (err) {
      // 自动压缩失败不影响对话：仅记录，下一轮再试
      log.warn('自动压缩失败，已跳过', {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** 读取「自动压缩阈值」配置：settings 表 > 内置默认值（可设置下限 50%）。 */
  private getCompressThreshold(): number {
    const raw = db.getSetting<number>(SETTING_AUTO_COMPRESS_THRESHOLD)
    return typeof raw === 'number' && raw >= 50 && raw <= 100
      ? raw
      : DEFAULT_AUTO_COMPRESS_THRESHOLD
  }

  /** 当前会话上下文占用估算（手动压缩确认弹窗用）。 */
  getSessionContextUsage(sessionId: string): {
    contextWindow: number
    threshold: number
    summaryTokens: number
    activeTokens: number
  } {
    const session = db.getSession(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    const contextWindow = this.manager.resolveAuxModel(sessionId)?.contextWindow ?? 0
    const allRows = db.listMessagesBySession(sessionId)
    // 与 autoCompressIfNeeded 同口径：活跃消息 = 压缩指针之后的消息，摘要单独计
    const active = allRows.filter(
      (r) => session.compressLastIndex === null || r.id > session.compressLastIndex
    )
    const activeTokens = active.reduce((sum, r) => {
      const m = fromMessageRow(r)
      return sum + estimateTokens(extractMessageText((m as { content: unknown }).content))
    }, 0)
    const summaryTokens = estimateTokens(session.compressSummary ?? '')
    return { contextWindow, threshold: this.getCompressThreshold(), summaryTokens, activeTokens }
  }

  /**
   * 手动压缩会话历史（互斥入口）：同一会话同时只允许一个压缩在跑。
   * 压缩耗时较长（一次 LLM 摘要调用）且最终依赖乐观锁写入 compress_summary，
   * 并发压缩同一会话会让后写入方因版本号不匹配而失败。
   */
  async compressSession(sessionId: string): Promise<CompressResult> {
    if (this.compressLocks.has(sessionId)) {
      throw new Error('该会话正在压缩中，请稍候再试')
    }
    this.compressLocks.add(sessionId)
    try {
      return await this.compressSessionImpl(sessionId)
    } finally {
      this.compressLocks.delete(sessionId)
    }
  }

  /**
   * 手动压缩会话历史：将较早的消息摘要化，仅保留最近若干条。
   * - 自适应保留窗口：默认保留最近 COMPRESS_KEEP_COUNT 条；若保留窗口本身的
   *   token 量超过「阈值 × COMPRESS_HEADROOM」，向前多压几条（必要时一条不留），
   *   让压缩后窗口留出增长空间，避免每轮都触发压缩
   * - 已压缩过（compress_last_index 非空）时只摘要「压缩指针之后、保留窗口之前」的
   *   新增消息，摘要输入叠加旧摘要做增量浓缩；指针范围内无新增消息则直接拒绝，
   *   避免重复压缩同一批消息
   * - 摘要容量保护：摘要超过窗口的 SUMMARY_MAX_FRACTION 时强制「摘要浓缩」——
   *   即使没有新消息，也把旧摘要截断后交给模型输出更紧凑的版本，防止摘要无限
   *   增长最终撑爆模型窗口；压缩输入中的旧摘要 / 单条超大消息会先做「头+尾」
   *   截断，避免压缩调用本身溢出
   * - 经乐观锁写入 compress_summary / compress_last_index
   * - 驱逐内存中的 Agent 实例：下次访问时从 DB rehydrate（仅含压缩后消息 + 摘要）
   * 返回压缩结果；无新增可压缩内容时 compressed=false（非错误，UI 按普通提示展示）。
   */
  private async compressSessionImpl(sessionId: string): Promise<CompressResult> {
    const session = db.getSession(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    // 运行中的会话不允许压缩（驱逐会 abort 正在进行的生成）；UI 已禁用按钮，此处兜底竞态
    const running = this.manager.getAgent(sessionId)
    if (running?.signal) throw new Error('会话正在生成中，请等待完成后再压缩')
    const allRows = db.listMessagesBySession(sessionId)
    const auxModel = this.manager.resolveAuxModel(sessionId)
    if (!auxModel) throw new Error('无可用模型，无法生成压缩摘要')
    const contextWindow = auxModel.contextWindow ?? 0
    const threshold = this.getCompressThreshold()
    const limit = contextWindow > 0 ? (contextWindow * threshold) / 100 : Infinity
    const summary = session.compressSummary ?? ''
    const summaryOversize =
      contextWindow > 0 && estimateTokens(summary) > contextWindow * SUMMARY_MAX_FRACTION

    // 自适应保留窗口：默认保留最近 COMPRESS_KEEP_COUNT 条；若该窗口已超
    // 「阈值 × COMPRESS_HEADROOM」，则继续向前压，直到窗口落在目标以内
    let keepStart = Math.max(0, allRows.length - COMPRESS_KEEP_COUNT)
    if (Number.isFinite(limit)) {
      const target = limit * COMPRESS_HEADROOM
      let sum = 0
      for (let i = allRows.length - 1; i >= keepStart; i--) {
        const m = fromMessageRow(allRows[i])
        sum += estimateTokens(extractMessageText((m as { content: unknown }).content))
        if (sum > target) {
          keepStart = i + 1
          break
        }
      }
    }

    // 短会话且窗口未超限：无需压缩（消息太少，摘要收益有限）
    if (allRows.length <= COMPRESS_KEEP_COUNT && keepStart === 0 && !summaryOversize) {
      return { compressed: false, reason: '消息较少，无需压缩' }
    }

    let upToIndex: number | null = null
    let newToCompress: typeof allRows = []
    if (keepStart > 0) {
      upToIndex = allRows[keepStart - 1].id
      // 只摘要压缩窗口内尚未压缩（compressLastIndex 之后）的新消息
      newToCompress = allRows
        .slice(0, keepStart)
        .filter((r) => session.compressLastIndex === null || r.id > session.compressLastIndex)
    }
    // 指针范围内无新增且摘要未超限：无需压缩
    if (newToCompress.length === 0 && !summaryOversize) {
      return { compressed: false, reason: '没有需要压缩的新消息' }
    }
    log.info('压缩会话', {
      sessionId,
      total: allRows.length,
      kept: allRows.length - keepStart,
      newToCompress: newToCompress.length,
      summaryTokens: estimateTokens(summary),
      summaryOversize
    })

    // 构造待压缩的输入：此前摘要（超限时截断）+ 新增消息（单条过大时截断），供模型增量合并
    let summaryText = summary
    let note = ''
    if (summaryOversize) {
      // 摘要超容量上限：指示模型输出更紧凑的版本，打破「用户原话全量保留」的无限增长
      note +=
        '此前摘要已超出容量上限，请把新摘要压缩得更紧凑：关键事实/已做决定/待办事项逐条保留，' +
        '用户原话仅保留最近几条，更早的用户消息只保留一句话大意。'
    }
    const newText = newToCompress
      .map((r) => {
        const m = fromMessageRow(r)
        let text = extractMessageText((m as { content: unknown }).content)
        // 单条消息过大：截断为头尾片段，避免压缩调用本身溢出模型窗口
        if (contextWindow > 0 && estimateTokens(text) > contextWindow) {
          text = truncateMiddle(text, Math.floor(contextWindow * 0.6))
        }
        return `${m.role}: ${text}`
      })
      .join('\n')
    if (contextWindow > 0) {
      const inputBudget = contextWindow - COMPRESS_OUTPUT_BUDGET
      if (inputBudget > 0) {
        const newTokens = estimateTokens(newText)
        const maxSummaryTokens = Math.max(0, inputBudget - newTokens)
        if (estimateTokens(summaryText) > maxSummaryTokens) {
          summaryText = truncateMiddle(summaryText, maxSummaryTokens)
          note += '此前摘要过长，本次已截断（省略中间部分），请基于现有内容生成新摘要。'
        }
      }
    }
    const conversation = [
      note.trim(),
      ...(summaryText ? [`[此前摘要]\n${summaryText}`] : []),
      ...(newText ? [`[新增对话]\n${newText}`] : [])
    ]
      .filter(Boolean)
      .join('\n\n')

    const result = await completeText(COMPRESS_SYSTEM_PROMPT, conversation, auxModel)
    if (!result.text) throw new Error('压缩摘要生成失败')
    // 压缩摘要也是一次 LLM 调用，计入 token 统计（usage_logs.kind='compress'）
    db.recordUsage({
      sessionId,
      kind: 'compress',
      provider: result.provider,
      model: result.model,
      promptTokens: result.usage.input,
      completionTokens: result.usage.output,
      cost: resolveAssistantCost(
        result.provider,
        result.usage,
        result.timestamp,
        result.usage.cost.total
      ),
      timestamp: result.timestamp
    })

    // 仅在有新增压缩内容时推进压缩指针；纯摘要浓缩保持原指针，
    // 避免用更小的 upToIndex 覆盖指针、把已压缩的旧消息重新暴露为活跃
    const newUpToIndex = newToCompress.length > 0 ? upToIndex : session.compressLastIndex
    db.compressSession(sessionId, newUpToIndex!, result.text, session.compressVersion)
    log.info('压缩完成', { sessionId, summaryLength: result.text.length })

    // 驱逐内存 Agent（若在运行先 abort 并等其 idle），下次访问从 DB 重新 hydrate 压缩后状态
    await this.manager.evictSession(sessionId, '压缩完成')

    // 推送会话更新，renderer 可据此刷新
    const updated = db.getSession(sessionId)
    if (updated) rendererClient.agentEvent.onSessionUpdate(updated)
    return { compressed: true }
  }

  // ==================== 工具 / 权限 ====================

  /** 全部工具及其启用状态（renderer 工具开关 UI 用）。 */
  listTools(): ToolInfo[] {
    return listTools()
  }

  // ==================== 网页搜索（Tavily）配置 ====================

  /** Tavily API Key 配置状态（renderer 展示用，key 明文不跨进程回传）。 */
  getWebSearchConfig(): { hasKey: boolean } {
    return { hasKey: hasWebSearchApiKey() }
  }

  /** 保存 Tavily API Key（safeStorage 加密存储，覆盖旧值）。 */
  setWebSearchApiKey(key: string): void {
    setWebSearchApiKeyConfig(key)
    log.info('已保存 Tavily API Key')
  }

  /** 清除 Tavily API Key。 */
  clearWebSearchApiKey(): void {
    clearWebSearchApiKeyConfig()
    log.info('已清除 Tavily API Key')
  }

  /** 测试 Tavily 连通性：未传 key 用已保存的 key，否则用传入 key。 */
  async testWebSearch(key?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await testWebSearchConnection(key)
      log.info('Tavily 连通性测试通过')
      return { ok: true }
    } catch (err) {
      log.warn('Tavily 连通性测试失败', { error: err instanceof Error ? err.message : String(err) })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ==================== 技能搜索（Find Skill）配置 ====================

  /** 当前技能搜索数据源（renderer 设置页展示用）。 */
  getFindSkillConfig(): { source: FindSkillSource } {
    return { source: getFindSkillSource() }
  }

  /** 保存技能搜索数据源（settings 表持久化；工具执行时实时读取，无需驱逐 Agent）。 */
  setFindSkillSource(source: FindSkillSource): void {
    setFindSkillSourceConfig(source)
    log.info('已保存技能搜索数据源', { source })
  }

  /** 测试指定数据源的连通性（跑一次最小搜索）。 */
  async testFindSkill(source: FindSkillSource): Promise<{ ok: boolean; error?: string }> {
    try {
      await testFindSkillConnection(source)
      log.info('技能搜索连通性测试通过', { source })
      return { ok: true }
    } catch (err) {
      log.warn('技能搜索连通性测试失败', {
        source,
        error: err instanceof Error ? err.message : String(err)
      })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ==================== 工作目录配置 ====================

  /**
   * 当前生效的 Agent 工作目录（含回退逻辑：settings 配置 > 用户数据目录下 work 子目录）。
   * 系统提示「工作目录」行（仅对新会话）与 bash 默认 cwd 均以该值为准。
   */
  getWorkdir(): string {
    return resolveAgentWorkdir()
  }

  /**
   * 保存工作目录（settings 表持久化）。
   * 不改动已固化提示词快照（resolved_system_prompt）：已有消息的会话提示词保持原样，
   * 仅新会话首次创建 Agent 时按新目录生成；bash 默认 cwd 每次执行实时读取，立即生效。
   */
  setWorkdir(dir: string): void {
    const v = dir.trim()
    if (!v) return
    db.setSetting(SETTING_AGENT_WORKDIR, v)
    log.info('已保存 Agent 工作目录', { dir: v })
  }

  /** 弹系统目录选择框选工作目录，返回选中路径（用户取消返回 null）。 */
  async pickWorkdir(): Promise<string | null> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择 Agent 工作目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  }

  /**
   * 重新抓取用户 shell 环境（.zshrc/.bashrc）并更新缓存：修改 shell 配置后无需重启应用，
   * 点设置页的「重新读取」即可让 bash 子进程在下一次命令拿到新变量。
   */
  async refreshShellEnv(): Promise<{ ok: boolean; count: number; error?: string }> {
    try {
      const env = await refreshShellEnv()
      const count = Object.keys(env).length
      log.info('已重新读取 shell 环境', { count })
      return { ok: true, count }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn('重新读取 shell 环境失败', { error })
      return { ok: false, count: 0, error }
    }
  }

  // ==================== 已安装技能管理 ====================

  /** 已安装技能列表（renderer 技能管理页展示用）。 */
  listInstalledSkills(): InstalledSkill[] {
    return listInstalledSkillsStore()
  }

  /**
   * 启停技能：只更新 manifest 记录。
   * 技能信息由 Agent 通过 read_skill 动态发现，不注入系统提示，
   * 因此无需驱逐 Agent，不打断正在进行的对话，也不失效 LLM 前缀缓存。
   */
  async setSkillEnabled(id: string, enabled: boolean): Promise<InstalledSkill> {
    const entry = await setSkillEnabledStore(id, enabled)
    log.info('技能启停已更新', { id, enabled })
    return entry
  }

  /** 卸载技能：删除本地技能目录并从 manifest 移除（无需驱逐 Agent，即时生效）。 */
  async uninstallSkill(id: string): Promise<void> {
    await uninstallSkillStore(id)
    log.info('技能已卸载', { id })
  }

  /** 打开技能根目录（系统文件管理器）。 */
  async openSkillsDir(): Promise<void> {
    await openSkillsDirStore()
  }

  // ==================== 欢迎页建议 ====================

  /** 最近一批欢迎页建议（settings 持久化，跨会话/重启复用；无数据时返回空数组由 renderer 回退静态）。 */
  getWelcomeSuggestions(): string[] {
    return db.getSetting<string[]>(SETTING_WELCOME_SUGGESTIONS) ?? []
  }

  /**
   * 欢迎页「换一批」建议生成：按当前会话/默认模型生成 4 条开场建议。
   * 参考本地能力（启用技能/知识库/记忆/工作目录）让建议贴近实际可用工具，避免固定文案。
   * 成功后写入 settings 持久化（新会话直接复用）；失败抛错由 renderer 回退到静态建议。
   * 计入 usage_logs（kind='welcome'）；sessionId 为空（临时会话）时无归属，跳过记录。
   */
  async generateWelcomeSuggestions(sessionId: string | null): Promise<string[]> {
    const model = this.manager.resolveAuxModel(sessionId ?? '')
    if (!model) throw new Error('未选择模型，请在设置中添加模型后再试')
    const skills = listInstalledSkillsStore().filter((s) => s.enabled)
    const kbCount = db.listDocuments().length
    const memoryCount = db.listMemories().length
    const contextParts: string[] = [
      `当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `工作目录：${resolveAgentWorkdir()}`
    ]
    if (skills.length > 0)
      contextParts.push(
        `已启用技能：${skills
          .slice(0, 6)
          .map((s) => s.name)
          .join('、')}`
      )
    if (kbCount > 0) contextParts.push(`本地知识库文档：${kbCount} 个`)
    if (memoryCount > 0) contextParts.push(`长期记忆条目：${memoryCount} 条`)
    const res = await completeText(WELCOME_SUGGEST_SYSTEM_PROMPT, contextParts.join('\n'), model)
    const suggestions = res.text
      .split('\n')
      .map((line) => line.replace(/^[\s\d\-•.、]+/, '').trim())
      .filter(Boolean)
      .slice(0, 4)
    if (suggestions.length === 0) throw new Error('模型未生成有效建议')
    db.setSetting(SETTING_WELCOME_SUGGESTIONS, suggestions)
    if (sessionId) {
      db.recordUsage({
        sessionId,
        kind: 'welcome',
        provider: res.provider,
        model: res.model,
        promptTokens: res.usage.input,
        completionTokens: res.usage.output,
        cost: resolveAssistantCost(res.provider, res.usage, res.timestamp, res.usage.cost.total),
        timestamp: res.timestamp
      })
    }
    log.info('欢迎页建议已生成', { count: suggestions.length })
    return suggestions
  }

  /**
   * 回传权限确认结果。scope 决定放行作用域：
   * once=仅本次 / session=本会话放行 / always=加入持久白名单（仅 bash）/
   * batch=放行当前 + 自动放行同一条消息内剩余危险工具。
   */
  respondPermission(requestId: string, approved: boolean, scope: PermissionScope = 'once'): void {
    resolvePermission(requestId, approved, scope)
  }

  /** 回传计划审批结果（renderer 计划卡片「批准/拒绝」后调用，feedback 在拒绝时携带）。 */
  respondPlan(requestId: string, approved: boolean, feedback?: string): void {
    resolvePlanApproval(requestId, approved, feedback?.trim() ?? '')
  }

  /**
   * 回传 ask_user 提问的答案（renderer 问答卡片作答后调用）。
   * value：单选/输入为字符串，多选为字符串数组；用户跳过时为 null。
   */
  respondAskUser(requestId: string, value: string | string[] | null): void {
    resolveAskUser(requestId, value)
  }

  /** 当前 bash 持久白名单（权限弹窗点「总是允许」累积的命令列表）。 */
  listBashAllowlist(): string[] {
    return db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
  }

  /** 从 bash 持久白名单移除一条命令（不再免确认）。 */
  removeBashAllowlist(command: string): void {
    const list = db.getSetting<string[]>(SETTING_BASH_ALLOWLIST) ?? []
    const next = list.filter((rule) => rule !== command)
    db.setSetting(SETTING_BASH_ALLOWLIST, next)
    log.info('已从 bash 白名单移除', { command })
  }

  /** 驱逐内存中的 Agent 实例（设置变更后调用，使新设置在下一轮生效）。 */
  async evictSession(sessionId: string): Promise<void> {
    await this.manager.evictSession(sessionId, '设置变更')
  }

  /** 驱逐全部内存 Agent（MCP 工具集变更后调用）：下一轮创建时重新拉取内置 + MCP 工具。 */
  async evictAllSessions(): Promise<void> {
    await this.manager.evictAllSessions()
  }

  // ==================== 会话数据清理 ====================

  /**
   * 删除会话末尾连续的失败 assistant 消息（finishReason 为 error/aborted）。
   * errorMessage 不会落库（convert 层未存），故以 finishReason 列判定。
   * 用于 retry / recall 前清理，使 transcript 末尾回到失败的用户/工具结果消息。
   */
  private pruneTrailingFailedAssistants(sessionId: string): void {
    const rows = db.listMessagesBySession(sessionId)
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.role === 'assistant' && (r.finishReason === 'error' || r.finishReason === 'aborted')) {
        db.deleteMessage(r.id)
      } else {
        break
      }
    }
  }

  /**
   * 删除会话末尾的 assistant 消息（仅最后一条，不限 finishReason）。
   * 用于 regenerate 前清理：使 transcript 末尾回到该 assistant 之前的 user/toolResult 消息，
   * 随后 continue 重跑。与 pruneTrailingFailedAssistants 的区别：本方法删除成功/失败/中止
   * 的末条 assistant，而后者仅删 error/aborted 且连续向前回溯。
   */
  private pruneLastAssistant(sessionId: string): void {
    const rows = db.listMessagesBySession(sessionId)
    const last = rows[rows.length - 1]
    if (last && last.role === 'assistant') {
      db.deleteMessage(last.id)
    }
  }

  /** 渲染进程展示本地附件：读盘为 data URL（file: 引用）。 */
  async getAttachmentDataUrl(fileKey: string): Promise<string> {
    return readAttachmentDataUrl(fileKey)
  }
}
