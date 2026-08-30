import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import { mainClient } from '../utils/main-client'
import { extractUserText, type FileTextBlock, type SkillTextBlock } from '../utils/messageText'
import { useModelConfigsStore } from './useModelConfigsStore'
import { useSessionStore } from './useSessionStore'
import { useSettingsStore } from './useSettingsStore'
import { applyChatEvent, mergeTranscript } from '../service/chat-events'
import type { ToolStatus, SessionChatState } from '../service/chat-events'
import type { ModelKey, ThinkingLevel } from '@main/agent/types'
import { formatModelKey, isThinkingLevel, parseModelKey } from '@main/agent/types'
import type { Message as DbMessage } from '@main/database'

// 重新导出容器与工具状态类型，保持既有 import 路径（如 ToolCallCard）不变。
export type { ToolStatus, SessionChatState } from '../service/chat-events'

/** 会话滚动锚点：锚定到消息行（mid）+ 该行相对视口顶部的偏移（offset）。 */
export interface ScrollAnchor {
  mid: number
  offset: number
}

/** 临时态虚拟会话的容器 key（currentSessionId 为 null 时视图代理指向它）。 */
const EPHEMERAL_KEY = '__ephemeral__'

/** 发送时携带的附件（ChatInput 收集，image 直接作为多模态 block 发送）。 */
export interface ComposerAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  size: number
  /** image：data URL（渲染预览用） */
  dataUrl?: string
  mimeType?: string
  /** image：base64（无 data: 前缀，发送时构造 ImageContent） */
  base64?: string
  /** file：纯文本 / 文档解析后的文本内容 */
  text?: string
}

/** 从附件列表提取可发送的图片 block（图片且带完整 base64/mimeType）。 */
function toImageBlocks(attachments?: ComposerAttachment[]): ImageContent[] {
  if (!attachments) return []
  return attachments
    .filter((a) => a.kind === 'image' && a.mimeType && a.base64)
    .map((a) => ({ type: 'image', data: a.base64!, mimeType: a.mimeType! }) satisfies ImageContent)
}

/**
 * 当前会话聊天状态：按会话容器化存储 + 视图代理。
 *
 * 多会话同时进行：`sessions` 按 sessionId 存每会话的实时状态，AgentEventService
 * 收到任意会话的事件都路由到对应容器（不再丢弃非当前会话）；聊天区组件仍通过
 * 原有的同名字段（messages / isBusy / ...）读取「当前会话」视图，实现零改动。
 *
 * 会话排序稳定性：发消息（main 侧 touchSession）置顶；切换会话不 touch（避免点击即重排），
 * 重命名/换模型等偏好操作也不 touch。后台流式落库、自动标题生成不 touch，
 * 多会话并行时列表不会来回争夺第一名。
 */
export const useChatStore = defineStore('chat', () => {
  const currentSessionId = ref<string | null>(null)
  const sessions = reactive<Record<string, SessionChatState>>({})

  /**
   * loadSession 请求序号：会话异步加载期间用户可能又切到别的会话 / 新建临时对话，
   * 用序号判断「我仍是最近一次请求」，防止在途加载落地时覆盖最新的目标会话。
   */
  let sessionRequestSeq = 0

  /**
   * 会话滚动锚点缓存：sessionId → { mid: 视口顶部可见的消息 id, offset: 该行相对视口顶部的偏移 }。
   * 仅存内存（应用运行期间有效），切换会话/路由离开时由 MessageList 保存、进入时恢复，
   * 避免切回长会话总是落在最底部。不落库：滚动位置是瞬时 UI 状态，重启后从底部开始
   * 是常规行为。
   *
   * 用「消息 id + 视口偏移」而非像素/距底部距离：会话内容含延迟渲染卡片
   * （echarts / markstream / monaco，进入视口才渲染），内容高度会异步变化，
   * 任何基于 scrollHeight 的像素位置都会失真；锚定到具体消息行则不受其下方内容
   * 高度变化的影响。
   */
  const sessionScrollAnchors = new Map<string, ScrollAnchor>()

  /** 记录某会话的滚动锚点。 */
  function saveSessionScroll(sessionId: string, anchor: ScrollAnchor): void {
    sessionScrollAnchors.set(sessionId, anchor)
  }

  /** 读取某会话上次保存的滚动锚点；未保存过返回 undefined（调用方默认落底）。 */
  function getSessionScroll(sessionId: string): ScrollAnchor | undefined {
    return sessionScrollAnchors.get(sessionId)
  }

  /** 视图指针：当前会话容器；临时态（currentSessionId=null）指向虚拟容器。 */
  const current = computed<SessionChatState | null>(() => {
    const id = currentSessionId.value ?? EPHEMERAL_KEY
    return sessions[id] ?? null
  })

  function createEmptyState(): SessionChatState {
    return {
      messages: [],
      isBusy: false,
      error: null,
      toolStatus: {},
      lastTurnFailed: false,
      prefillText: '',
      hasMore: false,
      oldestLoadedId: null,
      loadingOlder: false,
      hydrated: false,
      pendingJumpMessageId: null,
      currentModelKey: null,
      thinkingLevel: 'medium',
      compressLastIndex: null,
      compressSummary: null
    }
  }

  /** 读取某会话的状态容器（不存在返回 undefined）。侧边栏状态指示用。 */
  function sessionState(id: string): SessionChatState | undefined {
    return sessions[id]
  }

  /** 确保某会话存在状态容器（事件/发送时惰性创建）。 */
  function ensureState(id: string): SessionChatState {
    let s = sessions[id]
    if (!s) {
      s = createEmptyState()
      sessions[id] = s
    }
    return s
  }

  /** 移除某会话的状态容器（会话删除后清理，防内存泄漏）。 */
  function removeSessionState(id: string): void {
    delete sessions[id]
    // 顺带清理滚动锚点缓存，避免删除会话的占位残留
    sessionScrollAnchors.delete(id)
  }

  // ==================== 视图代理（对外字段名保持不变，组件零改动） ====================

  const messages = computed<AgentMessage[]>(() => current.value?.messages ?? [])
  const isBusy = computed(() => current.value?.isBusy ?? false)
  const error = computed<string | null>(() => current.value?.error ?? null)
  const toolStatus = computed<Record<string, ToolStatus>>(() => current.value?.toolStatus ?? {})
  const lastTurnFailed = computed(() => current.value?.lastTurnFailed ?? false)
  const hasMore = computed(() => current.value?.hasMore ?? false)
  const oldestLoadedId = computed<number | null>(() => current.value?.oldestLoadedId ?? null)
  const loadingOlder = computed(() => current.value?.loadingOlder ?? false)
  const pendingJumpMessageId = computed<number | null>(
    () => current.value?.pendingJumpMessageId ?? null
  )
  const currentModelKey = computed<ModelKey | null>(() => current.value?.currentModelKey ?? null)
  const currentThinkingLevel = computed<ThinkingLevel>(
    () => current.value?.thinkingLevel ?? 'medium'
  )
  const compressLastIndex = computed<number | null>(() => current.value?.compressLastIndex ?? null)
  const compressSummary = computed<string | null>(() => current.value?.compressSummary ?? null)
  /** writable：ChatInput 消费后写回当前会话容器。 */
  const prefillText = computed({
    get: () => current.value?.prefillText ?? '',
    set: (v: string) => {
      if (current.value) current.value.prefillText = v
    }
  })

  // ==================== 历史加载 ====================

  /** 历史消息分页：每页条数（首屏只加载最近一页，向上滚动加载更早）。 */
  const PAGE_SIZE = 30

  /**
   * 从历史消息推导「上一轮是否失败」，用于加载后恢复「重试/编辑」条显隐。
   *
   * 仅当末条为 assistant 且 finishReason='error' 时视为失败。
   * 不把「末条为 user / toolResult」判为失败：该形态既可能是真实失败（空错误载体被
   * isEmptyErrorCarrier 过滤未落库），也可能是用户中止 / 运行中 / 应用重启中断，
   * 仅凭行数据无法区分——一旦如此判定，会话在重新读取库（切换/强制重载/重启）后
   * 会把已经处理过的失败卡片“复活”。实时失败状态由 agent_end 事件驱动
   *（applyChatEvent），重读库只恢复明确落库的失败。
   */
  function deriveLastTurnFailed(rows: DbMessage[]): boolean {
    if (rows.length === 0) return false
    const last = rows[rows.length - 1]
    return last.role === 'assistant' && last.finishReason === 'error'
  }

  /**
   * 历史消息规整为展示形状：toolResult 行的 isError / details 落在 metadata，提到顶层，
   * 使切换/重载会话后与 agent_end 推来的 AgentMessage 形状一致
   *（MessageItem / ToolCallCard 直接读 message.isError、message.details，无需兼容两套形状）。
   */
  function toDisplayMessage(row: DbMessage): DbMessage & { isError?: boolean; details?: unknown } {
    if (row.role !== 'toolResult') return row
    const meta = (row.metadata ?? {}) as { isError?: boolean; details?: unknown }
    return { ...row, isError: meta.isError ?? false, details: meta.details }
  }

  /**
   * 从历史 toolResult 行推导工具执行状态（持久化）：toolCallId → completed/error。
   * 运行中（running）状态仅当前轮存在、不落库，故历史中无 running。
   */
  function deriveToolStatus(rows: DbMessage[]): Record<string, ToolStatus> {
    const map: Record<string, ToolStatus> = {}
    for (const row of rows) {
      if (row.role !== 'toolResult' || !row.toolCallId) continue
      const meta = (row.metadata ?? {}) as { isError?: boolean }
      map[row.toolCallId] = {
        status: meta.isError ? 'error' : 'completed',
        toolName: row.toolName ?? ''
      }
    }
    return map
  }

  /**
   * 将 DB 历史加载进某会话容器（不改变 currentSessionId）。
   * 惰性初始化兜底：事件流可能抢先于首次加载把消息推进容器（后台会话），
   * 此时用 mergeTranscript 合并而非覆盖，避免丢失流式中消息。
   * 幂等：hydrated 后直接返回。
   */
  async function hydrateState(sessionId: string): Promise<void> {
    const state = ensureState(sessionId)
    if (state.hydrated) return
    state.hydrated = true
    const [page, session] = await Promise.all([
      mainClient.db.listMessagesBySession(sessionId, { limit: PAGE_SIZE + 1 }),
      mainClient.db.getSession(sessionId)
    ])
    // 分页窗口取「最近的 PAGE_SIZE 条」：listMessagesBySession(limit) 返回最后 limit 条的
    // ASC 列表，多出的第 PAGE_SIZE+1 条（窗口最旧那条）只用于判定 hasMore。
    // 注意切分方向：此前 slice(0, PAGE_SIZE) 保留的是窗口最旧的 N 条、丢掉最新一条
    // assistant 回复，导致 UI 缺末条消息，且 deriveLastTurnFailed 取到倒数第二条
    //（常为 toolResult）而误判「上一轮失败」。
    const rows = page.length > PAGE_SIZE ? page.slice(page.length - PAGE_SIZE) : page
    state.hasMore = page.length > PAGE_SIZE
    state.oldestLoadedId = rows.length > 0 ? (rows[0] as { id: number }).id : null
    const dbMessages = rows.map(toDisplayMessage) as unknown as AgentMessage[]
    state.messages =
      state.messages.length > 0 ? mergeTranscript(state.messages, dbMessages) : dbMessages
    // 失败状态从历史消息推导（不依赖内存）：见 deriveLastTurnFailed。
    state.lastTurnFailed = deriveLastTurnFailed(rows)
    // 工具执行状态从历史 toolResult 行推导（持久化）：见 deriveToolStatus。
    state.toolStatus = deriveToolStatus(rows)
    const sessionKey = parseModelKey(session?.model ?? null)
    state.currentModelKey = sessionKey ?? useModelConfigsStore().defaultModelKey()
    // 思考级别：会话级 > 上次使用（settings 加载时已校验合法性）
    state.thinkingLevel = isThinkingLevel(session?.thinkingLevel)
      ? session.thinkingLevel
      : useSettingsStore().lastUsedThinkingLevel
    // 压缩分界元信息：消息列表据此渲染「以上已压缩」分界卡片
    state.compressLastIndex = session?.compressLastIndex ?? null
    state.compressSummary = session?.compressSummary ?? null
  }

  /**
   * 切换当前会话并加载其历史。
   * 已初始化（hydrated）的容器直接复用：切回运行中的会话不重置 busy / 消息 / 工具状态。
   * force=true 时强制从 DB 重载（recall 删除消息等场景）。
   * 容器已有消息（事件流抢先进入，如 renderer 重载后 main 仍在后台流式）时不整体清空，
   * hydrateState 会用 mergeTranscript 合并，避免丢正在流式的内容。
   */
  async function loadSession(sessionId: string, force = false): Promise<void> {
    const state = ensureState(sessionId)
    if (state.hydrated && !force) {
      currentSessionId.value = sessionId
      return
    }
    const seq = ++sessionRequestSeq
    if (force || state.messages.length === 0) {
      // 首次进入 / 强制重载：清空容器状态后从 DB 加载（避免残留旧数据）
      Object.assign(state, createEmptyState(), { hydrated: false })
    }
    // 未初始化会话：先加载历史再切换 currentSessionId。若先切换，加载瞬间 messages
    // 为空，MessageList 会闪回欢迎页再弹出内容（切换会话时明显闪烁）。加载期间用户
    // 又切到别的会话/新建临时对话时 seq 被抢占，本加载放弃落地。
    await hydrateState(sessionId)
    if (seq === sessionRequestSeq) currentSessionId.value = sessionId
  }

  /**
   * 向上加载更早的历史消息：以 oldestLoadedId 为边界取前一页，prepend 到列表头部。
   * 滚动锚定由 MessageList 负责（加载前记录滚动距离，nextTick 后恢复），
   * 保证用户在阅读历史时不会被内容插入顶出当前视口。
   * 会话切换防护：await 返回后若已切换会话则丢弃结果，避免旧页错插进新会话。
   */
  async function loadMoreMessages(): Promise<void> {
    const state = current.value
    if (!state || state.loadingOlder || !state.hasMore || state.oldestLoadedId == null) return
    const sessionId = currentSessionId.value
    if (!sessionId) return
    state.loadingOlder = true
    try {
      const page = await mainClient.db.listMessagesBySession(sessionId, {
        beforeId: state.oldestLoadedId,
        limit: PAGE_SIZE + 1
      })
      if (currentSessionId.value !== sessionId) return
      // 向上加载更早历史：同样保留「离当前窗口最近」的 PAGE_SIZE 条（末尾切片），
      // 避免把与窗口相邻的消息切掉造成列表空隙。
      const rows = page.length > PAGE_SIZE ? page.slice(page.length - PAGE_SIZE) : page
      state.hasMore = page.length > PAGE_SIZE
      if (rows.length > 0) state.oldestLoadedId = (rows[0] as { id: number }).id
      // 合并新增 toolResult 行的工具状态（key 为 toolCallId，与旧状态 merge 安全）
      Object.assign(state.toolStatus, deriveToolStatus(rows))
      state.messages = [
        ...(rows.map(toDisplayMessage) as unknown as AgentMessage[]),
        ...state.messages
      ]
    } finally {
      state.loadingOlder = false
    }
  }

  // ==================== 临时态 / 会话切换 ====================

  /**
   * 搜索跳转：切换会话并定位到命中消息。
   * - 目标消息已在当前加载窗口（含实时流）：仅发定位信号，不重载，避免打断。
   * - 目标不在窗口：按目标消息加载一个包含它的窗口（目标前 PAGE_SIZE-1 条 + 目标起
   *   后 PAGE_SIZE 条），滚动定位由 MessageList 消费 pendingJumpMessageId 完成。
   * 定位后 hasMore 由「目标之前是否还有更多」决定，用户可继续向上翻页加载更早历史。
   */
  async function jumpToMessage(sessionId: string, messageId: number): Promise<void> {
    // 抢占在途 loadSession 落地：跳转目标会话以本流程为准
    sessionRequestSeq++
    currentSessionId.value = sessionId
    const state = ensureState(sessionId)
    if (state.hydrated && state.messages.some((m) => (m as { id?: number }).id === messageId)) {
      state.pendingJumpMessageId = messageId
      return
    }
    const [older, session, fromTarget] = await Promise.all([
      mainClient.db.listMessagesBySession(sessionId, {
        beforeId: messageId,
        limit: PAGE_SIZE - 1
      }),
      mainClient.db.getSession(sessionId),
      mainClient.db.listMessagesBySession(sessionId, {
        afterId: messageId - 1,
        limit: PAGE_SIZE
      })
    ])
    const rows = [...older, ...fromTarget]
    Object.assign(state, createEmptyState(), { hydrated: false })
    state.messages = rows.map(toDisplayMessage) as unknown as AgentMessage[]
    state.hasMore = older.length === PAGE_SIZE - 1
    state.oldestLoadedId = rows.length > 0 ? (rows[0] as { id: number }).id : null
    state.lastTurnFailed = deriveLastTurnFailed(rows)
    state.toolStatus = deriveToolStatus(rows)
    const sessionKey = parseModelKey(session?.model ?? null)
    state.currentModelKey = sessionKey ?? useModelConfigsStore().defaultModelKey()
    state.thinkingLevel = isThinkingLevel(session?.thinkingLevel)
      ? session.thinkingLevel
      : useSettingsStore().lastUsedThinkingLevel
    state.compressLastIndex = session?.compressLastIndex ?? null
    state.compressSummary = session?.compressSummary ?? null
    state.hydrated = true
    state.pendingJumpMessageId = messageId
  }

  /** 消费搜索跳转定位信号（MessageList 滚动完成后调用）。 */
  function clearPendingJump(): void {
    if (current.value) current.value.pendingJumpMessageId = null
  }

  /**
   * 更新压缩分界元信息：main 侧压缩成功后经 onSessionUpdate 推送新 Session，
   * 此方法同步当前会话容器，使分界卡片移动到新压缩点。非当前会话无需处理
   *（切回时 hydrateState / jumpToMessage 会从 Session 重新读取）。
   */
  function updateCompress(session: {
    id: string
    compressLastIndex: number | null
    compressSummary: string | null
  }): void {
    if (session.id !== currentSessionId.value) return
    const state = sessions[session.id]
    if (!state) return
    state.compressLastIndex = session.compressLastIndex
    state.compressSummary = session.compressSummary
  }

  /**
   * 进入临时空对话：currentSessionId 置空，重置虚拟容器，不写库。
   * 首条消息发送时由 send 落库创建会话（虚拟容器整体迁移到新会话）。
   * currentModelKey 仅预选「上次使用」模型（无则空）；未选择模型时 send 会拦截发送。
   */
  function enterEphemeral(): void {
    // 抢占在途 loadSession 落地：新建临时对话不受半路切换影响
    sessionRequestSeq++
    currentSessionId.value = null
    sessions[EPHEMERAL_KEY] = {
      ...createEmptyState(),
      hydrated: true,
      currentModelKey: useModelConfigsStore().defaultModelKey(),
      thinkingLevel: useSettingsStore().lastUsedThinkingLevel
    }
  }

  /**
   * 切换当前会话的模型：更新该会话容器的 currentModelKey + 「上次使用」；会话已落库时
   * 额外写回 session.model（touch 置顶）并驱逐内存 Agent，使新模型下一轮生效。
   * 临时态（sessionId 为 null）仅更新内存 + lastUsed，待首条消息 send 落库时带入。
   */
  async function selectModel(key: ModelKey): Promise<void> {
    if (current.value) current.value.currentModelKey = key
    await useModelConfigsStore().setLastUsed(key)
    const sessionId = currentSessionId.value
    if (!sessionId) return
    await mainClient.db.updateSession(sessionId, { model: formatModelKey(key), touch: true })
    await useSessionStore().refreshSession(sessionId)
    await mainClient.agent.evictSession(sessionId)
  }

  /**
   * 切换当前会话的思考级别：更新容器 + 会话行（不 touch 置顶，属轻量偏好），
   * 并实时同步内存 Agent（state.thinkingLevel 下一轮生效，无需驱逐重建）。
   * 同时写回「上次使用思考级别」：新建会话继承（与模型 lastUsed 语义一致）。
   * 临时态（sessionId 为 null）仅更新内存 + 上次使用，首条消息 send 落库时带入。
   */
  async function selectThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (current.value) current.value.thinkingLevel = level
    await useSettingsStore().setLastUsedThinkingLevel(level)
    const sessionId = currentSessionId.value
    if (!sessionId) return
    await mainClient.db.updateSession(sessionId, { thinkingLevel: level })
    await useSessionStore().refreshSession(sessionId)
    await mainClient.agent.setThinkingLevel(sessionId, level)
  }

  /**
   * 发送一条用户消息：乐观加入 + 调 main 跑 agent（流式回复经事件回传）。
   * 可携带附件：图片 block 作为多模态输入；文件附件内容独立成块（带 file_name，
   * UI 按文件卡片渲染，正文只保留用户输入）。
   * 可携带指定技能：技能块带 skill_name 标记（main 侧读取 SKILL.md 全文注入模型，
   * UI 按技能卡片渲染）。技能单次生效，发送后由调用方清空选择。
   * 临时空对话（currentSessionId 为 null）时，先落库创建会话（带当前所选模型）再发送。
   * 创建前同步置 busy 上锁，防止 await 期间二次发送产生重复会话。
   * 发送是用户主动操作：main 侧会 touchSession 置顶该会话。
   */
  async function send(
    text: string,
    attachments?: ComposerAttachment[],
    skills?: string[]
  ): Promise<void> {
    const trimmed = text.trim()
    const images = toImageBlocks(attachments)
    // 用户正文 + 指定技能块 + 文件内容块 + 图片 block（顺序：正文 → 技能 → 文件 → 图片）
    const userBlocks: (
      FileTextBlock | SkillTextBlock | { type: 'text'; text: string } | ImageContent
    )[] = [
      ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
      ...(skills ?? []).map((id) => ({ type: 'text' as const, text: '', skill_name: id })),
      ...(attachments ?? [])
        .filter((a): a is ComposerAttachment & { text: string } => a.kind === 'file' && !!a.text)
        .map((a) => ({ type: 'text' as const, text: a.text, file_name: a.name })),
      ...images
    ]
    if (current.value?.isBusy || userBlocks.length === 0) return
    // 未选择模型：拦截发送并提示（新对话必须显式选择模型后才可发送）
    if (!current.value?.currentModelKey) {
      if (current.value) current.value.error = '请先选择模型'
      return
    }
    let sessionId = currentSessionId.value
    if (!sessionId) {
      // 临时态：虚拟容器置 busy 上锁（防并发二次创建）
      ensureState(EPHEMERAL_KEY).isBusy = true
      try {
        const sessionStore = useSessionStore()
        const session = await sessionStore.createSession({
          model: current.value?.currentModelKey
            ? formatModelKey(current.value.currentModelKey)
            : undefined,
          thinkingLevel: current.value?.thinkingLevel
        })
        sessionId = session.id
        // 临时态迁移为真实会话：抢占在途 loadSession 落地
        sessionRequestSeq++
        currentSessionId.value = sessionId
        sessionStore.currentSessionId = sessionId
        // 虚拟容器迁移为新会话容器（保留临时态内存状态），标记已初始化（无需重载 DB）
        const ephemeral = sessions[EPHEMERAL_KEY]
        delete sessions[EPHEMERAL_KEY]
        sessions[sessionId] = ephemeral ?? createEmptyState()
        sessions[sessionId].hydrated = true
      } catch (err) {
        ensureState(EPHEMERAL_KEY).isBusy = false
        ensureState(EPHEMERAL_KEY).error = err instanceof Error ? err.message : String(err)
        return
      }
    }
    const state = ensureState(sessionId)
    const userMsg: AgentMessage = {
      role: 'user',
      content: userBlocks,
      timestamp: Date.now()
    }
    state.messages.push(userMsg)
    state.isBusy = true
    state.error = null
    state.lastTurnFailed = false
    const files = userBlocks.filter(
      (b): b is FileTextBlock => b.type === 'text' && 'file_name' in b
    )
    try {
      await mainClient.agent.prompt(
        sessionId,
        trimmed,
        images.length > 0 ? images : undefined,
        files.length > 0 ? files.map((f) => ({ name: f.file_name, text: f.text })) : undefined,
        skills && skills.length > 0 ? skills : undefined
      )
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      state.isBusy = false
    }
  }

  /** 中止当前运行。 */
  function abort(): void {
    if (!currentSessionId.value) return
    void mainClient.agent.abort(currentSessionId.value)
  }

  /** 清除错误提示。 */
  function clearError(): void {
    if (current.value) current.value.error = null
  }

  /** 重试上一轮失败的对话：main 侧清理失败 assistant + 重跑，事件流自动回传。 */
  async function retry(): Promise<void> {
    const sessionId = currentSessionId.value
    if (!sessionId) return
    await mainClient.agent.retry(sessionId)
  }

  /** 重新生成最后一条 assistant 回复：main 侧删除末条 assistant + 重跑，事件流自动回传。 */
  async function regenerate(): Promise<void> {
    const sessionId = currentSessionId.value
    if (!sessionId) return
    await mainClient.agent.regenerate(sessionId)
  }

  /**
   * 重新生成图表（EChartsBlock「重新生成」按钮）：main 侧发起独立 LLM 请求（不写入对话
   * 记录），成功后把新配置就地替换回原消息的 echarts 块，事件流自动回传刷新。
   */
  async function regenerateChart(
    sessionId: string,
    messageId: number,
    error: string,
    config: string
  ): Promise<void> {
    await mainClient.agent.regenerateChart(sessionId, messageId, error, config)
  }

  /**
   * 回收最后一条失败的用户消息：删除该消息（DB + 列表），文本回填输入框供编辑重发。
   * 仅当末尾是 user 消息时才回收（main 侧判定）；否则只 reload 同步列表。
   */
  async function recallLastMessage(): Promise<void> {
    const sessionId = currentSessionId.value
    if (!sessionId) return
    const state = ensureState(sessionId)
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user')
    const text = lastUser ? extractUserText(lastUser.content) : ''
    const ok = await mainClient.agent.recallLastUserMessage(sessionId)
    await loadSession(sessionId, true)
    if (ok && text) state.prefillText = text
  }

  /**
   * 从某条用户消息开启新分支：main 侧把该消息（不含）之前的全部历史复制到新会话
   *（继承模型/思考级别等配置，记录 parentSessionId），前端选中新会话并把该条
   * 用户消息文本回填输入框，供用户改写后重发 → 新分支产生。
   * 源会话不受影响（复制而非截断）。
   */
  async function forkFromMessage(messageId: number): Promise<void> {
    const sourceSessionId = currentSessionId.value
    if (!sourceSessionId) return
    // 从当前容器提取目标 user 消息文本（分支点之后即被新会话丢弃，须回填供改写）
    const target = current.value?.messages.find(
      (m) => (m as { id?: number }).id === messageId && m.role === 'user'
    )
    const text = target ? extractUserText((target as { content: unknown }).content) : ''
    const session = await mainClient.db.forkSession(sourceSessionId, messageId)
    const sessionStore = useSessionStore()
    sessionStore.sessions.unshift(session)
    // 侧栏高亮立即切换；聊天内容由 loadSession 先加载历史再切换，避免闪回欢迎页
    sessionStore.currentSessionId = session.id
    await loadSession(session.id)
    if (text) ensureState(session.id).prefillText = text
  }

  // ==================== 事件应用（任意会话） ====================

  /**
   * 处理 main 推来的 Agent 事件，更新**事件所属会话**的容器（不再限当前会话）。
   * - 当前会话：流式实时渲染（message_update 由 AgentEventService 做 rAF 缓冲）
   * - 后台会话：只更新容器数据（侧边栏状态指示据此展示），不触发渲染
   * error：agent_end 携带的真实失败信息（中止不携带）。写入容器供侧边栏标错 + 切回时提示。
   * 状态变更本身由纯函数 applyChatEvent 完成（见 chat-events.ts），此处负责容器定位与惰性初始化。
   */
  function applyEvent(sessionId: string, event: AgentEvent, error?: string): void {
    const state = ensureState(sessionId)
    // 惰性初始化兜底：事件先于任何 loadSession 到达（从未进入的后台会话）
    if (!state.hydrated && state.messages.length === 0) {
      void hydrateState(sessionId)
    }
    applyChatEvent(state, event, error)
  }

  /**
   * 显式设置某会话某工具调用的状态（权限确认场景用）：
   * - pending：收到 onPermissionRequest 时置位，使对应工具卡片渲染「等待确认」；
   * - running：批准后由 usePermissionStore.respond 补置（tool_execution_start 早于
   *   权限拦截发出、且已被 pending 覆盖，放行后不会重发）；
   * - error：用户拒绝 / 超时自动拒绝后置位，使卡片从「等待确认」翻转为拒绝态。
   */
  function setToolStatus(sessionId: string, toolCallId: string, status: ToolStatus): void {
    const state = ensureState(sessionId)
    state.toolStatus[toolCallId] = status
  }

  return {
    currentSessionId,
    // 视图代理
    messages,
    isBusy,
    error,
    toolStatus,
    currentModelKey,
    currentThinkingLevel,
    compressLastIndex,
    compressSummary,
    lastTurnFailed,
    prefillText,
    hasMore,
    oldestLoadedId,
    loadingOlder,
    pendingJumpMessageId,
    // 容器访问
    sessionState,
    removeSessionState,
    // 滚动锚点缓存
    saveSessionScroll,
    getSessionScroll,
    // 动作
    loadSession,
    loadMoreMessages,
    jumpToMessage,
    clearPendingJump,
    updateCompress,
    enterEphemeral,
    selectModel,
    selectThinkingLevel,
    send,
    abort,
    clearError,
    retry,
    regenerate,
    regenerateChart,
    recallLastMessage,
    forkFromMessage,
    applyEvent,
    setToolStatus
  }
})
