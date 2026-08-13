import { IpcService } from 'electron-ipc-service/renderer'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { useChatStore } from '../store/useChatStore'
import { usePermissionStore } from '../store/usePermissionStore'
import { useSessionStore } from '../store/useSessionStore'
import type { Session } from '@main/service/db-service'
import type { AgentEventPayload, PermissionRequest } from '@main/agent/types'

/**
 * Agent 事件接收服务：main 进程通过 rendererClient.agentEvent.* 推送事件到此处。
 * 沿用 UiService.windowStateChange 的 main→renderer 推送模式。
 */
export class AgentEventService extends IpcService {
  static override readonly namespace = 'agentEvent'

  /**
   * 流式 message_update 合并缓冲：本地大模型可每秒推送数百个 message_update，
   * 逐条应用会让 Vue 每事件 flush 一次重渲染（浏览器上限 60fps）。
   * 改为同一帧内只保留最新一条，经 rAF 每帧至多应用一次，渲染频率封顶在帧率。
   * 丢弃中间态安全：message_end / agent_end 均携带权威消息，最终态不失真。
   */
  #pendingUpdate: {
    sessionId: string
    event: Extract<AgentEvent, { type: 'message_update' }>
  } | null = null
  #rafId: number | null = null

  /** Agent 生命周期事件（agent_start/message_update/.../agent_end）。 */
  onEvent(payload: AgentEventPayload): void {
    const chat = useChatStore()
    // agent_end 前先清理该会话残留的权限请求：中止 run 时未响应的「等待确认」卡片
    // 不应残留，翻转为拒绝态后一并移出队列。
    if (payload.event.type === 'agent_end') {
      usePermissionStore().clearSession(payload.sessionId)
    }
    // 所有会话的事件都路由到对应状态容器（多会话并发：后台会话照常更新，
    // 侧边栏据此显示「生成中/失败」；切回时状态保留）。不再丢弃非当前会话事件。
    // 流式更新先进缓冲（仅当前会话渲染限频）；其余事件（message_end/agent_end/tool_*）
    // 前强制 flush，保证事件顺序与最终态正确（缓冲的中间态不会盖过后续权威消息）。
    if (payload.event.type === 'message_update') {
      // 当前会话的流式更新走 rAF 缓冲（限频渲染）；后台会话直接应用（不触发渲染）。
      if (payload.sessionId === chat.currentSessionId) {
        this.#bufferUpdate(payload.sessionId, payload.event)
      } else {
        chat.applyEvent(payload.sessionId, payload.event)
      }
      return
    }
    this.#flushUpdate()
    // agent_end 携带真实失败 error（中止不携带）时写入容器；当前会话由 ChatView
    // watch error 弹提示，后台会话仅侧边栏标红，切回后再提示。
    chat.applyEvent(payload.sessionId, payload.event, payload.error)
  }

  /** 缓冲最新一条 message_update，并通过 rAF 合并到当前帧应用。 */
  #bufferUpdate(sessionId: string, event: Extract<AgentEvent, { type: 'message_update' }>): void {
    this.#pendingUpdate = { sessionId, event }
    if (this.#rafId !== null) return
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null
      this.#flushUpdate()
    })
  }

  /** 应用缓冲中的流式更新（会话已切换则丢弃）。 */
  #flushUpdate(): void {
    const pending = this.#pendingUpdate
    this.#pendingUpdate = null
    if (!pending) return
    const chat = useChatStore()
    if (pending.sessionId !== chat.currentSessionId) return
    chat.applyEvent(pending.sessionId, pending.event)
  }

  /** 危险工具执行前的权限确认请求。入队 + 把对应工具卡片标记为「等待确认」。 */
  onPermissionRequest(req: PermissionRequest): void {
    usePermissionStore().enqueue(req)
    useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
      status: 'pending',
      toolName: req.toolName
    })
  }

  /**
   * 会话元数据更新（如标题自动生成后、压缩成功后）。
   * main 推送更新后的 Session，同步到会话列表，并同步压缩分界元信息到聊天容器。
   */
  onSessionUpdate(session: Session): void {
    void useSessionStore().upsertSession(session)
    useChatStore().updateCompress(session)
  }
}
