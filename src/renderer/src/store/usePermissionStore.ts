import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import { useChatStore } from './useChatStore'
import type { PermissionRequest, PermissionScope } from '@main/agent/types'
import { PERMISSION_TIMEOUT_MS } from '@main/agent/types'

/**
 * 危险工具权限确认队列。
 * AgentEventService.onPermissionRequest 收到 main 推来的请求后入队，并把对应工具卡片
 * 标记为 pending（等待确认）；用户在卡片上操作后调 mainClient.agent.respondPermission 回传。
 * scope='batch'（允许本批全部）在 main 侧以「同一条 assistant 消息」为边界自动放行剩余工具，
 * renderer 无需跟踪该状态；进入下一条消息即失效。超时（main 侧同一常量自动拒绝）后从
 * 队列移除并翻转为拒绝态，避免残留「等待确认」卡片。
 */
export const usePermissionStore = defineStore('permission', () => {
  const pending = ref<PermissionRequest[]>([])
  /** 每条请求的超时定时器（requestId → timer），响应或超时时清理。 */
  const timers = new Map<string, number>()

  function enqueue(req: PermissionRequest): void {
    // 同一工具调用不会重复入队（每次工具调用只触发一次 beforeToolCall）
    pending.value.push(req)
    timers.set(
      req.requestId,
      window.setTimeout(() => {
        // 与 main 侧超时自动拒绝对齐：移除请求 + 卡片翻转为拒绝态（错误 toolResult 会随后到达）
        remove(req.requestId)
        useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
          status: 'error',
          toolName: req.toolName
        })
      }, PERMISSION_TIMEOUT_MS)
    )
  }

  function remove(requestId: string): void {
    const timer = timers.get(requestId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(requestId)
    }
    pending.value = pending.value.filter((r) => r.requestId !== requestId)
  }

  /** 某会话待确认的请求（PermissionBar 批量操作条用）。 */
  function pendingForSession(sessionId: string | null): PermissionRequest[] {
    if (!sessionId) return []
    return pending.value.filter((r) => r.sessionId === sessionId)
  }

  /**
   * 回传单条请求的确认结果；批准时把对应卡片置为「执行中」，拒绝时翻转为拒绝态。
   * 批准后必须补置 running：pi-agent-core 的 tool_execution_start 早于 beforeToolCall
   * 触发、且已被 onPermissionRequest 覆盖为 pending，放行后不会重发，否则整个执行
   * 期间卡片一直停留在「等待确认」。
   */
  function respond(
    req: PermissionRequest,
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

  /** 批量回传某会话的全部待确认请求（「全部允许 / 全部拒绝」）。 */
  function respondAll(
    sessionId: string | null,
    approved: boolean,
    scope: PermissionScope = 'once'
  ): void {
    for (const req of pendingForSession(sessionId)) {
      respond(req, approved, scope)
    }
  }

  /**
   * 会话结束（agent_end：中止 / 超时后）时清理该会话残留的待确认请求。
   * 正常情况下请求在确认后即被移除；残留说明请求未获响应（如用户中止了 run），
   * 此时把对应卡片翻转为拒绝态，避免「等待确认」卡片残留到超时。
   */
  function clearSession(sessionId: string): void {
    for (const req of pendingForSession(sessionId)) {
      remove(req.requestId)
      useChatStore().setToolStatus(req.sessionId, req.toolCallId, {
        status: 'error',
        toolName: req.toolName
      })
    }
  }

  return {
    pending,
    enqueue,
    remove,
    pendingForSession,
    respond,
    respondAll,
    clearSession
  }
})
