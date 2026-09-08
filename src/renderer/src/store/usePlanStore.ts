import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PlanProgress } from '@main/agent/types'

/**
 * 计划执行进度状态（仅展示用途）：
 * 计划批准后 main 经 onPlanProgress 推送步骤状态（report_step 更新驱动），
 * 顶部细状态条 PlanProgressBar 据此展示「进行到第几步」。
 * agent_start 清除（新一轮 run），agent_end 保留最终状态供回看。
 * 计划「审批请求」本身已并入统一交互队列（useInteractionStore，kind='plan_approval'）。
 */
export const usePlanStore = defineStore('plan', () => {
  const progressBySession = ref<Record<string, PlanProgress>>({})

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

  return { progressBySession, setProgress, progressForSession, clearProgress }
})
