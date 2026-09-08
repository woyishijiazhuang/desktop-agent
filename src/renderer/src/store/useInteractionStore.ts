import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import { useChatStore } from './useChatStore'
import type {
  AskUserRequest,
  InteractionRequest,
  PermissionScope,
  PlanApprovalRequest,
  ToolPermissionRequest
} from '@main/agent/types'

/**
 * 统一「人工介入」队列（危险工具确认 / 计划审批 / 澄清提问 三合一）。
 * AgentEventService.onInteractionRequest 收到 main 推来的请求后入队：
 * - tool_permission：同时把对应工具卡片标记为 pending（等待确认）；
 * - plan_approval / ask_question：InteractionBar 按 kind 渲染对应面板。
 * 超时由 main 侧按请求携带的 expiresAt 统一处理（0 = 一直等待），renderer 用同一时间
 * 同步清理队列（权限卡片翻转为拒绝态），避免残留「等待确认」卡片与过期面板。
 * 回传仍走各自的 agent.respondPermission / respondPlan / respondAskUser（main 侧汇入
 * interaction.ts 统一注册表）。
 */
export const useInteractionStore = defineStore('interaction', () => {
  const queue = ref<InteractionRequest[]>([])
  /** 每条请求的超时定时器（requestId → { timer, sessionId, 卡片信息 }）。 */
  const timers = new Map<
    string,
    { timer: number; sessionId: string; toolCallId?: string; toolName?: string }
  >()

  function enqueue(req: InteractionRequest): void {
    queue.value.push(req)
    if (req.expiresAt > 0) {
      const delay = Math.max(0, req.expiresAt - Date.now())
      const info: { sessionId: string; toolCallId?: string; toolName?: string } = {
        sessionId: req.sessionId
      }
      if (req.kind === 'tool_permission') {
        info.toolCallId = req.toolCallId
        info.toolName = req.toolName
      }
      const timer = window.setTimeout(() => {
        timers.delete(req.requestId)
        remove(req.requestId)
        // 权限卡：到点 main 侧自动拒绝（错误 toolResult 随后到达），先本地翻转为拒绝态
        if (info.toolCallId && info.toolName) {
          useChatStore().setToolStatus(info.sessionId, info.toolCallId, {
            status: 'error',
            toolName: info.toolName
          })
        }
      }, delay)
      timers.set(req.requestId, { timer, ...info })
    }
  }

  function remove(requestId: string): void {
    const t = timers.get(requestId)
    if (t) {
      window.clearTimeout(t.timer)
      timers.delete(requestId)
    }
    queue.value = queue.value.filter((r) => r.requestId !== requestId)
  }

  /** 某会话待处理的交互（按到达顺序）。 */
  function pendingForSession(sessionId: string | null): InteractionRequest[] {
    if (!sessionId) return []
    return queue.value.filter((r) => r.sessionId === sessionId)
  }

  /** 某会话当前第一条交互（唯一决策面板；串行流下一次通常只有一个）。 */
  function currentForSession(sessionId: string | null): InteractionRequest | null {
    return pendingForSession(sessionId)[0] ?? null
  }

  /**
   * 回传危险工具确认结果。批准时把对应卡片补置为「执行中」：
   * pi-agent-core 的 tool_execution_start 早于 beforeToolCall 触发、且已被 onInteractionRequest
   * 覆盖为 pending，放行后不会重发，否则整个执行期间卡片一直停留在「等待确认」。
   */
  function respondPermission(
    req: ToolPermissionRequest,
    approved: boolean,
    scope: PermissionScope = 'once'
  ): void {
    void mainClient.agent.respondPermission(req.requestId, approved, scope)
    remove(req.requestId)
    if (approved) {
      // 仅当仍为 pending（或从未置位）时补置：避免异常时序下覆盖已到达的 completed/error
      const current = useChatStore().toolStatus[req.toolCallId]
      if (!current || current.status === 'pending') {
        useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
          status: 'running',
          toolName: req.toolName
        })
      }
    } else {
      useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
        status: 'error',
        toolName: req.toolName
      })
    }
  }

  /** 回传计划审批结果（feedback 在拒绝时携带）。 */
  function respondPlan(req: PlanApprovalRequest, approved: boolean, feedback: string): void {
    void mainClient.agent.respondPlan(req.requestId, approved, feedback)
    remove(req.requestId)
  }

  /** 回传澄清提问答案（value：单选/自由输入为字符串，多选为字符串数组，跳过为 null）。 */
  function respondAskUser(req: AskUserRequest, value: string | string[] | null): void {
    void mainClient.agent.respondAskUser(req.requestId, value)
    remove(req.requestId)
  }

  /** 会话结束（agent_end）时清理该会话残留的交互请求，权限卡翻转为拒绝态。 */
  function clearSession(sessionId: string): void {
    for (const req of pendingForSession(sessionId)) {
      if (req.kind === 'tool_permission') {
        useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
          status: 'error',
          toolName: req.toolName
        })
      }
      remove(req.requestId)
    }
  }

  return {
    queue,
    enqueue,
    remove,
    pendingForSession,
    currentForSession,
    respondPermission,
    respondPlan,
    respondAskUser,
    clearSession
  }
})
