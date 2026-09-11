import { rendererClient } from '../../infra/render-client'
import { createLogger } from '../../utils/log'
import { respondInteraction } from './interaction'
import type { PlanProgress, PlanStepStatus } from '../types'

const log = createLogger('planMode')

/**
 * 会话级计划模式状态：true 期间危险工具（bash/write/edit/install_skill）
 * 被 beforeToolCall 拦截（见 permission.ts），强制先提交计划获得批准。
 * 按单次 run 生效：agent_start 时清除（agent-manager 调用）。
 */
const sessionPlanMode = new Map<string, boolean>()

/**
 * 计划批准后的「本轮自动放行」标记：批准即视为本 run 内危险工具全放行
 * （破坏性 deny 兜底除外，仍强制人工确认）。agent_start 时随计划模式一并清除。
 */
const sessionPlanAutoAllow = new Map<string, boolean>()

/**
 * 已批准计划的执行进度（report_step 上报更新，展示用）。
 * 按 run 生命周期：agent_start 时随计划模式一并清除（见 clearPlanMode）；
 * run 结束后保留最终状态供回看，新一轮 run 开始时清除。
 */
const sessionPlanProgress = new Map<string, PlanProgress>()

export function setPlanMode(sessionId: string, on: boolean): void {
  if (on) sessionPlanMode.set(sessionId, true)
  else sessionPlanMode.delete(sessionId)
}

export function isPlanMode(sessionId: string): boolean {
  return sessionPlanMode.has(sessionId)
}

/** 新一轮 run 开始时清除（计划模式、本轮自动放行与执行进度均按 run 生效，避免跨轮残留）。 */
export function clearPlanMode(sessionId: string): void {
  sessionPlanMode.delete(sessionId)
  sessionPlanAutoAllow.delete(sessionId)
  sessionPlanProgress.delete(sessionId)
}

/** 计划获批准：登记本轮自动放行（run 内危险工具免逐条确认；deny 兜底除外）。 */
export function markPlanAutoAllow(sessionId: string): void {
  sessionPlanAutoAllow.set(sessionId, true)
}

/** 本轮是否已因计划批准而自动放行（permission 的 run 自动放行策略判定用）。 */
export function isPlanRunAutoAllow(sessionId: string): boolean {
  return sessionPlanAutoAllow.has(sessionId)
}

/** 从计划文本兜底解析步骤标题（Markdown 数字列表行，如 "1. 创建 xxx"）。 */
function parsePlanSteps(plan: string): string[] {
  return plan
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+[.、．)）]\s+/.test(line))
    .map((line) => line.replace(/^\d+[.、．)）]\s+/, '').trim())
    .filter(Boolean)
}

/** 深拷贝进度（renderer 按引用替换触发响应式，steps 数组需为新实例）。 */
function cloneProgress(p: PlanProgress): PlanProgress {
  return { ...p, steps: p.steps.map((s) => ({ ...s })) }
}

/**
 * 计划批准时播种执行进度：优先用模型提交的结构化 steps，缺失时从计划文本解析兜底。
 * 解析不出任何步骤时（如简单计划）不建立进度，进度条不展示。
 */
export function seedPlanProgress(
  sessionId: string,
  title: string,
  planText: string,
  steps: string[]
): void {
  const titles = steps.map((s) => s.trim()).filter(Boolean)
  const resolved = titles.length > 0 ? titles : parsePlanSteps(planText)
  if (resolved.length === 0) return
  const progress: PlanProgress = {
    sessionId,
    title,
    steps: resolved.map((t) => ({ title: t, status: 'pending' as PlanStepStatus }))
  }
  sessionPlanProgress.set(sessionId, progress)
  rendererClient.agentEvent.onPlanProgress(cloneProgress(progress))
}

/** 应用一次 report_step 上报；返回错误提示文本（null = 成功）。 */
export function applyReportStep(
  sessionId: string,
  stepIndex: number,
  status: PlanStepStatus
): string | null {
  const progress = sessionPlanProgress.get(sessionId)
  if (!progress) return '当前没有已批准的计划，进度上报已忽略。'
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= progress.steps.length) {
    return `步骤序号越界：${stepIndex}（共 ${progress.steps.length} 步，有效范围 0-${progress.steps.length - 1}），请核对后重新上报。`
  }
  progress.steps[stepIndex].status = status
  rendererClient.agentEvent.onPlanProgress(cloneProgress(progress))
  return null
}

/**
 * 本轮 run 结束时收尾进度（agent-manager 在 agent_end 调用）：
 * 正常完成 → 全部步骤标记完成；中止/失败 → 保留部分进度如实展示。
 */
export function finalizePlanProgress(sessionId: string, completed: boolean): void {
  const progress = sessionPlanProgress.get(sessionId)
  if (!progress) return
  if (completed) {
    for (const s of progress.steps) s.status = 'done'
  }
  rendererClient.agentEvent.onPlanProgress(cloneProgress(progress))
}

/**
 * renderer 回传计划审批结果，解除 exit_plan_mode 的挂起
 * （挂起注册在 interaction.ts，由 tools/plan-mode.ts 的 beginInteraction 管理）。
 */
export function resolvePlanApproval(requestId: string, approved: boolean, feedback: string): void {
  if (!respondInteraction(requestId, { approved, feedback })) {
    log.warn('收到未知计划审批回执', { requestId, approved })
  }
}
