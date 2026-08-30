import { rendererClient } from '../service/render-client'
import { createLogger } from '../utils/log'
import type { PlanProgress, PlanStepStatus } from './types'

const log = createLogger('planMode')

/**
 * 会话级计划模式状态：true 期间危险工具（bash/write/edit/install_skill）
 * 被 beforeToolCall 拦截（见 permission.ts），强制先提交计划获得批准。
 * 按单次 run 生效：agent_start 时清除（agent-manager 调用）。
 */
const sessionPlanMode = new Map<string, boolean>()

/**
 * 计划批准后本 run 内免确认的 bash 命令（词级前缀匹配，逻辑同持久白名单）。
 * 仅在计划批准时写入（exit_plan_mode），agent_start 时随计划模式一并清除；
 * 破坏性命令（deny 兜底）不受预批准覆盖，始终人工确认。
 */
const sessionPlanAllowedCommands = new Map<string, string[]>()

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

/** 新一轮 run 开始时清除（计划模式、预批准命令与执行进度均按 run 生效，避免跨轮残留）。 */
export function clearPlanMode(sessionId: string): void {
  sessionPlanMode.delete(sessionId)
  sessionPlanAllowedCommands.delete(sessionId)
  sessionPlanProgress.delete(sessionId)
}

/** 记录计划批准时预登记的免确认 bash 命令（覆盖式）。 */
export function setPlanAllowedPrompts(sessionId: string, commands: string[]): void {
  const clean = commands.map((c) => c.trim()).filter(Boolean)
  if (clean.length > 0) sessionPlanAllowedCommands.set(sessionId, clean)
}

/** 计划批准后本 run 内：命令是否命中预登记的免确认命令（词级前缀匹配）。 */
export function isPlanAllowedCommand(sessionId: string, command: string): boolean {
  const rules = sessionPlanAllowedCommands.get(sessionId)
  if (!rules || !command) return false
  const cmdWords = command.split(/\s+/).filter(Boolean)
  return rules.some((rule) => {
    const ruleWords = rule.split(/\s+/).filter(Boolean)
    if (cmdWords.length < ruleWords.length) return false
    for (let i = 0; i < ruleWords.length; i++) {
      if (cmdWords[i] !== ruleWords[i]) return false
    }
    return true
  })
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

/** 待审批计划：requestId → 决议回调。 */
interface PendingPlan {
  sessionId: string
  resolve: (approved: boolean, feedback: string) => void
}
const pending = new Map<string, PendingPlan>()

/** renderer 回传计划审批结果，解除 exit_plan_mode 的挂起。 */
export function resolvePlanApproval(requestId: string, approved: boolean, feedback: string): void {
  const req = pending.get(requestId)
  if (!req) {
    log.warn('收到未知计划审批回执', { requestId, approved })
    return
  }
  pending.delete(requestId)
  log.info('计划审批已回传', { sessionId: req.sessionId, requestId, approved })
  req.resolve(approved, feedback)
}

export interface PlanApprovalResult {
  approved: boolean
  feedback: string
  /** true = 审批超时自动拒绝（区别于用户主动拒绝，用于工具侧文案区分）。 */
  timedOut: boolean
}

/**
 * 挂起等待计划审批决议（exit_plan_mode 工具调用）。
 * 超时自动拒绝；批准/拒绝经 resolvePlanApproval 由 renderer 回传。
 */
export function waitForPlanApproval(
  requestId: string,
  sessionId: string,
  timeoutMs: number
): Promise<PlanApprovalResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      log.warn('计划审批超时，自动拒绝', { sessionId, requestId })
      resolve({ approved: false, feedback: '', timedOut: true })
    }, timeoutMs)
    pending.set(requestId, {
      sessionId,
      resolve: (approved, feedback) => {
        clearTimeout(timer)
        pending.delete(requestId)
        resolve({ approved, feedback, timedOut: false })
      }
    })
  })
}
