import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { PlanApprovalRequest, PlanProgress } from '@main/agent/types'

/**
 * 计划审批与执行进度状态：
 * - 审批：Agent 调用 exit_plan_mode 提交计划后，main 经 onPlanRequest 推送，PlanApprovalBar 展示；
 *   批准/拒绝回传 mainClient.agent.respondPlan 解除 agent 挂起。
 * - 进度：计划批准后 main 经 onPlanProgress 推送步骤状态（report_step 更新驱动），
 *   顶部细状态条 PlanProgressBar 据此展示「进行到第几步」。agent_start 清除（新一轮 run），
 *   agent_end 保留最终状态供回看。
 */
export const usePlanStore = defineStore('plan', () => {
  const pendingBySession = ref<Record<string, PlanApprovalRequest>>({})
  const progressBySession = ref<Record<string, PlanProgress>>({})

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

  /** 会话结束（agent_end）时清理残留的计划审批请求（进度保留，供回看最终状态）。 */
  function clearSession(sessionId: string): void {
    delete pendingBySession.value[sessionId]
  }

  /** 接收计划执行进度推送（report_step 更新后 main 全量推送）。 */
  function setProgress(progress: PlanProgress): void {
    progressBySession.value[progress.sessionId] = progress
  }

  /** 某会话当前计划执行进度（无则 null）。 */
  function progressForSession(sessionId: string | null): PlanProgress | null {
    if (!sessionId) return null
    return progressBySession.value[sessionId] ?? null
  }

  /** 新一轮 run 开始时清除该会话的进度（agent_start 触发）。 */
  function clearProgress(sessionId: string): void {
    delete progressBySession.value[sessionId]
  }

  return {
    pendingBySession,
    progressBySession,
    enqueue,
    forSession,
    respond,
    clearSession,
    setProgress,
    progressForSession,
    clearProgress
  }
})
