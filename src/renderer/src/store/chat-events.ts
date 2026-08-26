import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { ModelKey, ThinkingLevel } from '@main/agent/types'

/**
 * 工具执行状态（ToolCallCard 展示用）。
 * pending = 权限确认中（renderer 收到 onPermissionRequest 时置位，卡片上渲染确认按钮）；
 * running/completed/error 由 tool_execution_start/end 事件驱动。
 */
export interface ToolStatus {
  status: 'pending' | 'running' | 'completed' | 'error'
  toolName: string
  result?: unknown
  /**
   * 执行中的流式输出快照（tool_execution_update，bash 等工具每次推完整累计文本，替换语义）。
   * 仅 running 期间有值；tool_execution_end 覆盖 status 时随旧对象一起丢弃，由终态结果接管。
   */
  stream?: string
}

/**
 * 单个会话的实时聊天状态（多会话并发的核心数据结构）。
 * 每个会话独立维护消息流 / busy / 工具状态 / 错误，互不干扰：
 * 后台会话继续跑，事件照常更新其容器；切回时状态直接复用，不重置。
 */
export interface SessionChatState {
  messages: AgentMessage[]
  isBusy: boolean
  error: string | null
  /** 工具调用实时状态，key = toolCallId */
  toolStatus: Record<string, ToolStatus>
  /** 上一轮是否失败（真实错误，非中止）。控制「重试 / 编辑」操作条的显隐。 */
  lastTurnFailed: boolean
  /** 一次性回填文本：recall 把失败消息文本塞回输入框时设置，ChatInput 消费后清空。 */
  prefillText: string
  /** 历史消息分页：每页条数（首屏只加载最近一页，向上滚动加载更早）。 */
  hasMore: boolean
  /** 已加载最旧一条消息的 DB id（向上加载的分页边界）。 */
  oldestLoadedId: number | null
  /** 是否正在向上加载（防并发 + 控制哨兵 loading 文案）。 */
  loadingOlder: boolean
  /** 是否已从 DB 加载首屏窗口（切回时据此避免重复加载/重置运行中状态）。 */
  hydrated: boolean
  /** 搜索跳转定位信号：目标消息 DB id，MessageList 消费后滚动定位 + 高亮并清空。 */
  pendingJumpMessageId: number | null
  /** 该会话生效的模型键（session.model → 上次使用；无则空，须用户显式选择）。 */
  currentModelKey: ModelKey | null
  /** 该会话生效的思考级别（session.thinkingLevel → 上次使用；'off' = 关闭思考）。 */
  thinkingLevel: ThinkingLevel
  /** 压缩分界：最后一个被压缩的消息 DB id（id <= 此值的消息已被摘要化，仅进入模型上下文前被摘要替代）。 */
  compressLastIndex: number | null
  /** 压缩摘要全文（分界卡片展开时展示）。 */
  compressSummary: string | null
}

/** 消息签名：role::timestamp::toolCallId。同一消息在流式更新期间 timestamp 不变，
 *  故签名稳定（与 renderer 侧 useStableMessageKeys 保持一致）。 */
function signatureOf(m: AgentMessage): string {
  return `${(m as { role?: string }).role}::${(m as { timestamp?: number }).timestamp}::${
    (m as { toolCallId?: string }).toolCallId ?? ''
  }`
}

/**
 * 合并 agent_end 权威 transcript 到当前列表，保证 UI 始终显示会话的完整历史。
 *
 * 背景：压缩会话的 Agent 内存态只含压缩保留的最近消息（getSessionContext 按
 * compressLastIndex 过滤），agent_end 推来的 transcript 因此被裁剪；若直接全量替换，
 * 压缩前的旧消息会从界面消失。而 loadSession / 压缩后刷新显示的是 DB 全量（压缩
 * 不删除旧消息，仅推进指针），两者必须一致：压缩只影响发送给模型的上下文，
 * 不隐藏用户的聊天记录。
 *
 * 分页适配：列表可能是「最近一页」而非全量。uncompressed 长会话的 transcript 是
 * 完整历史，可能早于窗口起点；若按旧逻辑「匹配 transcript 首条，无重合即全量替换」，
 * 会把全部历史重新塞回窗口、破坏分页边界。故重合点改为「窗口内第一条出现在
 * transcript 中的消息」（窗口与 transcript 共享最新消息，重合必存在），并截取
 * transcript 从重合点起的那段，只替换尾部、保留窗口内更早的分页历史。
 *
 * 算法：取窗口内首个与 transcript 有签名交集的消息位置 idx，保留其之前的旧消息，
 * 之后拼接 transcript 从重合点（splitIn）起的内容。
 * - 未压缩：窗口[0] 即重合点 → 尾部以 transcript 为准，早于窗口的 transcript 部分被剔除
 * - 压缩后运行：窗口内首个重合即 transcript 起点 → 压缩前旧消息继续展示，尾部更新
 * - retry / regenerate：transcript 是清理后的权威历史 → 残留气泡被正确移除
 * 完全无交集（异常）时退化为直接使用 transcript。
 */
export function mergeTranscript(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  if (incoming.length === 0) return current
  const incomingSigs = new Set(incoming.map(signatureOf))
  const idx = current.findIndex((m) => incomingSigs.has(signatureOf(m)))
  if (idx < 0) return incoming
  const overlap = signatureOf(current[idx])
  const splitIn = incoming.findIndex((m) => signatureOf(m) === overlap)
  return [...current.slice(0, idx), ...incoming.slice(splitIn)]
}

/**
 * 应用单个 Agent 事件到会话状态容器（纯函数，无副作用）。
 * - message_update / message_end 按签名匹配替换对应消息（流式更新 / finalize）
 * - agent_end 用 mergeTranscript 合并权威 transcript 并落 busy / 失败标记
 * - error 为 agent_end 携带的真实失败信息（中止不携带）
 * 惰性初始化（hydrateState）等副作用由调用方（useChatStore.applyEvent）负责。
 */
export function applyChatEvent(state: SessionChatState, event: AgentEvent, error?: string): void {
  switch (event.type) {
    case 'agent_start':
      state.isBusy = true
      state.error = null
      break
    case 'message_start': {
      // 推入新消息（assistant + toolResult）；user 已在 send 时乐观加入
      const msg = event.message
      if (msg.role === 'assistant' || msg.role === 'toolResult') {
        state.messages.push(msg)
      }
      break
    }
    case 'message_update':
    case 'message_end': {
      // 将最新版本替换到目标消息上。
      // 优先按 DB id 精确替换：agent 内存消息的 timestamp 与 DB 落库 timestamp 可能不一致
      //（流式期间以 agent 时间记，落库用 Date.now()），仅按签名（role::timestamp）匹配会把
      // 「携带 id 的权威替换」（如图表重新生成推回的更新）漏掉，导致 UI 不刷新。
      // 普通流式事件消息不带 id，走原签名路径，行为不变。
      const msg = event.message
      const msgId = (msg as { id?: number }).id
      let matched = false
      if (msgId !== undefined) {
        for (let i = state.messages.length - 1; i >= 0 && !matched; i--) {
          if ((state.messages[i] as { id?: number }).id === msgId) {
            state.messages[i] = msg
            matched = true
          }
        }
      }
      if (!matched) {
        const sig = signatureOf(msg)
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (signatureOf(state.messages[i]) === sig) {
            state.messages[i] = msg
            break
          }
        }
      }
      break
    }
    case 'tool_execution_start':
      // key 级赋值（不整体替换 toolStatus 对象）：Vue 按 key 追踪依赖，
      // 仅使用该 toolCallId 的卡片重渲染，而非整列表一起刷新。
      state.toolStatus[event.toolCallId] = { status: 'running', toolName: event.toolName }
      break
    case 'tool_execution_update': {
      // 流式输出快照（替换语义，bash 每次推完整累计文本）：写入 stream 供卡片执行中实时展示。
      // 仅在 running/pending 期间接收；结束后由 tool_execution_end + toolResult 终态接管。
      const text = extractToolPartialText(event.partialResult)
      if (!text) break
      const cur = state.toolStatus[event.toolCallId]
      if (cur && cur.status !== 'running' && cur.status !== 'pending') break
      state.toolStatus[event.toolCallId] = {
        status: cur?.status ?? 'running',
        toolName: cur?.toolName ?? event.toolName,
        stream: text
      }
      break
    }
    case 'tool_execution_end':
      state.toolStatus[event.toolCallId] = {
        status: event.isError ? 'error' : 'completed',
        toolName: event.toolName,
        result: event.result
      }
      break
    case 'agent_end':
      // 合并权威 transcript 而非全量替换：压缩会话的 transcript 被裁剪（Agent 内存态
      // 只含压缩保留的最近消息），直接替换会让压缩前的旧消息从界面消失。合并后
      // 无论压缩与否 UI 始终显示完整历史，与 loadSession 的 DB 全量保持一致。
      state.messages = mergeTranscript(state.messages, event.messages)
      state.isBusy = false
      // 真实失败 → 容器记 error + 标记失败（侧边栏红点；切回当前会话时由视图 watch 弹提示）。
      // 中止（aborted）main 侧不携带 error，落入成功分支，不打扰。
      if (error) {
        state.error = error
        state.lastTurnFailed = true
      } else {
        state.lastTurnFailed = false
      }
      break
    default:
      // 其余事件（turn_start/turn_end 等）无 UI 状态可更新
      break
  }
}

/** 从 tool_execution_update 的 partialResult（AgentToolResult）提取全部文本（当前仅 text 块）。 */
function extractToolPartialText(partial: unknown): string {
  if (!partial || typeof partial !== 'object') return ''
  const content = (partial as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: string }).text === 'string'
    )
    .map((b) => b.text)
    .join('')
}
