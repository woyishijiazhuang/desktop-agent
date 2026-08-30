import { IpcService } from 'electron-ipc-service/renderer'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { useChatStore } from '../store/useChatStore'
import { usePermissionStore } from '../store/usePermissionStore'
import { usePlanStore } from '../store/usePlanStore'
import { useAskUserStore } from '../store/useAskUserStore'
import { useSessionStore } from '../store/useSessionStore'
import { useBackgroundStore } from '../store/useBackgroundStore'
import type { Session } from '@main/service/db-service'
import type {
  AgentEventPayload,
  PermissionRequest,
  PlanApprovalRequest,
  PlanProgress,
  AskUserRequest
} from '@main/agent/types'
import type { BackgroundSessionInfo } from '@main/agent/bash-session'

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

  /**
   * tool_execution_update 流式输出缓冲：key = `${sessionId}::${toolCallId}`，每 key 仅保留
   * 最近一帧的最新快照。bash 等工具每次推完整累计文本（替换语义），丢弃中间态安全，
   * 故同一帧内只保留最新一条、rAF 每帧至多应用一次即可（与 message_update 限频同思路）。
   */
  #pendingToolUpdate: Map<
    string,
    { sessionId: string; event: Extract<AgentEvent, { type: 'tool_execution_update' }> }
  > = new Map()
  #toolRafId: number | null = null

  /** Agent 生命周期事件（agent_start/message_update/.../agent_end）。 */
  onEvent(payload: AgentEventPayload): void {
    const chat = useChatStore()
    // agent_end 前先清理该会话残留的权限请求：中止 run 时未响应的「等待确认」卡片
    // 不应残留，翻转为拒绝态后一并移出队列。
    if (payload.event.type === 'agent_end') {
      usePermissionStore().clearSession(payload.sessionId)
      usePlanStore().clearSession(payload.sessionId)
      useAskUserStore().clearSession(payload.sessionId)
    }
    // 新一轮 run 开始：清除上一轮的计划执行进度（进度按 run 生命周期展示）。
    if (payload.event.type === 'agent_start') {
      usePlanStore().clearProgress(payload.sessionId)
    }
    // 流式工具输出：当前会话走 rAF 缓冲（每帧最多应用一次，防高频 IPC 逐条触发渲染）；
    // 后台会话直接应用（不触发渲染，与 message_update 处理一致）。
    if (payload.event.type === 'tool_execution_update') {
      if (payload.sessionId === chat.currentSessionId) {
        this.#bufferToolUpdate(payload.sessionId, payload.event)
      } else {
        this.#flushToolUpdates()
        chat.applyEvent(payload.sessionId, payload.event)
      }
      return
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
    this.#flushToolUpdates()
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

  /** 缓冲工具流式输出快照（每 key 只保留最新一条），并通过 rAF 合并到当前帧应用。 */
  #bufferToolUpdate(
    sessionId: string,
    event: Extract<AgentEvent, { type: 'tool_execution_update' }>
  ): void {
    this.#pendingToolUpdate.set(`${sessionId}::${event.toolCallId}`, { sessionId, event })
    if (this.#toolRafId !== null) return
    this.#toolRafId = requestAnimationFrame(() => {
      this.#toolRafId = null
      this.#flushToolUpdates()
    })
  }

  /** 把缓冲的工具流式快照应用到 store（每帧一次，替换语义故丢弃中间态安全）。 */
  #flushToolUpdates(): void {
    if (this.#pendingToolUpdate.size === 0) return
    const chat = useChatStore()
    const entries = [...this.#pendingToolUpdate.entries()]
    this.#pendingToolUpdate.clear()
    for (const [, { sessionId, event }] of entries) {
      chat.applyEvent(sessionId, event)
    }
  }

  /** 危险工具执行前的权限确认请求。入队 + 把对应工具卡片标记为「等待确认」。 */
  onPermissionRequest(req: PermissionRequest): void {
    usePermissionStore().enqueue(req)
    useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
      status: 'pending',
      toolName: req.toolName
    })
  }

  /** 计划审批请求（exit_plan_mode 提交计划后推送）：入队，PlanApprovalBar 据此展示。 */
  onPlanRequest(req: PlanApprovalRequest): void {
    usePlanStore().enqueue(req)
  }

  /** 计划执行进度推送（report_step 更新后推送）：PlanProgressBar 据此展示当前步骤。 */
  onPlanProgress(progress: PlanProgress): void {
    usePlanStore().setProgress(progress)
  }

  /** 澄清问题请求（ask_user 工具调用后推送）：入队，AskUserBar 据此展示。 */
  onAskUserRequest(req: AskUserRequest): void {
    useAskUserStore().enqueue(req)
  }

  /**
   * 会话元数据更新（如标题自动生成后、压缩成功后）。
   * main 推送更新后的 Session，同步到会话列表，并同步压缩分界元信息到聊天容器。
   */
  onSessionUpdate(session: Session): void {
    void useSessionStore().upsertSession(session)
    useChatStore().updateCompress(session)
  }

  /** 后台命令快照更新（main 在后台会话 启动/退出/终止 时推送全量列表）。 */
  onBackgroundSessions(sessions: BackgroundSessionInfo[]): void {
    useBackgroundStore().setSessions(sessions)
  }
}
