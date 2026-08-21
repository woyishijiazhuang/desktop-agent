import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { PlanApprovalRequest } from '@main/agent/types'

/**
 * 计划审批状态：Agent 调用 exit_plan_mode 提交计划后，main 经
 * AgentEventService.onPlanRequest 推送到此处；PlanApprovalBar 展示计划文本与
 * 「批准/拒绝」按钮，回传 mainClient.agent.respondPlan 解除 agent 挂起。
 * 按会话最多一个待审批计划（一次只规划一件事），agent_end 时清理。
 */
export const usePlanStore = defineStore('plan', () => {
  const pendingBySession = ref<Record<string, PlanApprovalRequest>>({})

  function enqueue(req: PlanApprovalRequest): void {
    pendingBySession.value[req.sessionId] = req
  }

  /** 某会话当前待审批的计划（无则 null）。 */
  function forSession(sessionId: string | null): PlanApprovalRequest | null {
    if (!sessionId) return null
    return pendingBySession.value[sessionId] ?? null
  }

  /** 回传审批结果并移除待审批计划（feedback 在拒绝时携带）。 */
  function respond(sessionId: string, approved: boolean, feedback: string): void {
    const req = pendingBySession.value[sessionId]
    if (!req) return
    delete pendingBySession.value[sessionId]
    void mainClient.agent.respondPlan(req.requestId, approved, feedback)
  }

  /** 会话结束（agent_end）时清理残留的计划审批请求。 */
  function clearSession(sessionId: string): void {
    delete pendingBySession.value[sessionId]
  }

  return { pendingBySession, enqueue, forSession, respond, clearSession }
})
