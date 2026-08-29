import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { rendererClient } from '../../utils/render-client'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { DEFAULT_PERMISSION_TIMEOUT_SEC } from '../types'
import type { PlanApprovalRequest, PlanProgress, PlanStepStatus } from '../types'

const log = createLogger('tool:plan_mode')

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
function setPlanAllowedPrompts(sessionId: string, commands: string[]): void {
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
function seedPlanProgress(
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
function applyReportStep(
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

const enterParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次进入计划模式的目的，会直接展示给用户浏览（例如"先规划重构方案"）。请务必填写。'
    })
  )
})

const exitParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次提交计划的目的，会直接展示给用户浏览（例如"提交重构计划供审阅"）。请务必填写。'
    })
  ),
  title: Type.Optional(
    Type.String({ description: '计划标题（可选，简短概括本次计划，默认"计划"）' })
  ),
  plan: Type.String({
    description:
      '完整计划文本：分步骤、可执行（含涉及的关键文件/命令）、标明每步产出，供用户审阅后批准'
  }),
  steps: Type.Optional(
    Type.Array(
      Type.String({
        description: '各步骤的一句话标题（如 "创建工具函数并导出"、"运行测试验证"）'
      }),
      {
        description:
          '结构化的步骤标题列表（可选）：批准后按此顺序向用户展示执行进度，每步执行时用 report_step 上报状态。未提供时按计划文本中的数字列表行（如 "1. xxx"）自动解析。'
      }
    )
  ),
  allowedPrompts: Type.Optional(
    Type.Array(
      Type.String({
        description:
          '计划中预登记、批准后执行阶段免确认的 bash 命令（完整命令或前缀，如 "pnpm test"）。'
      }),
      {
        description:
          '计划中预登记的 bash 命令（可选）：批准后本 run 执行阶段直接放行，减少重复确认；破坏性命令不受影响，仍需人工确认。'
      }
    )
  )
})

export interface EnterPlanDetails {
  /** 无 */
}

export interface ExitPlanDetails {
  approved: boolean
  requestId: string
}

export interface ReportStepDetails {
  stepIndex: number
  status: 'in_progress' | 'done'
}

const reportStepParams = Type.Object({
  stepIndex: Type.Number({
    description: '步骤序号（从 0 开始，对应提交计划时 steps 列表的下标）'
  }),
  status: Type.Union(
    [Type.Literal('in_progress'), Type.Literal('done')],
    { description: '上报的状态：开始执行该步骤填 in_progress，完成填 done' }
  )
})

/**
 * Plan Mode 工具（对标 Claude Code 的 EnterPlanMode / ExitPlanMode）：
 * - enter_plan_mode：进入计划模式，此后危险工具被拦截，Agent 只能规划
 * - exit_plan_mode：提交计划并挂起等待用户审批；批准后退出计划模式并放行执行，
 *   拒绝则保持计划模式，Agent 根据反馈调整后重新提交
 * - report_step：已批准计划的执行进度上报（开始/完成某一步时调用），驱动前端进度条
 * 与 read_file / bash 家族同理按 Agent 会话绑定，故用工厂。
 */
export function createPlanModeTools(sessionId: string): AgentTool[] {
  const enterTool: AgentTool<typeof enterParams, EnterPlanDetails> = {
    name: 'enter_plan_mode',
    label: '进入计划模式',
    description:
      '进入计划模式：此模式下 bash / write_file / edit_file 等操作会被拦截。请先分析任务、输出详细分步计划，再调用 exit_plan_mode 提交计划等待用户批准。适合需要先规划再动手的复杂任务；简单任务无需调用。',
    parameters: enterParams,
    executionMode: 'sequential',
    async execute() {
      setPlanMode(sessionId, true)
      log.info('进入计划模式', { sessionId })
      return {
        content: [
          {
            type: 'text',
            text: '已进入计划模式。请分析任务并输出分步计划，然后用 exit_plan_mode 提交计划等待用户批准；批准前不会执行任何命令或写入操作。'
          }
        ],
        details: {}
      }
    }
  }

  const exitTool: AgentTool<typeof exitParams, ExitPlanDetails> = {
    name: 'exit_plan_mode',
    label: '提交计划',
    description:
      '将完整计划提交给用户审批（plan 参数）。用户批准后返回批准结果并退出计划模式（可开始执行）；用户拒绝则返回反馈，需调整后重新调用本工具提交修改后的计划。',
    parameters: exitParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p) {
      const requestId = randomUUID()
      const allowedPrompts = p.allowedPrompts ?? []
      const payload: PlanApprovalRequest = {
        requestId,
        sessionId,
        title: p.title?.trim() || '计划',
        plan: p.plan,
        allowedPrompts
      }
      rendererClient.agentEvent.onPlanRequest(payload)
      log.info('提交计划待审批', {
        sessionId,
        requestId,
        title: payload.title,
        planLength: p.plan.length,
        allowedPromptsCount: allowedPrompts.length
      })
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          log.warn('计划审批超时，自动拒绝', { sessionId, requestId })
          resolve({
            content: [
              {
                type: 'text',
                text: '计划审批超时未响应，已自动拒绝。请重新调用 exit_plan_mode 提交计划，或放弃规划。'
              }
            ],
            details: { approved: false, requestId }
          })
        }, DEFAULT_PERMISSION_TIMEOUT_SEC * 1000)
        pending.set(requestId, {
          sessionId,
          resolve: (approved, feedback) => {
            clearTimeout(timer)
            pending.delete(requestId)
            if (approved) {
              // 批准：退出计划模式，放行后续执行；计划落库供回看/跨会话复用；
              // 预登记命令在本 run 内免确认（agent_start 时随计划模式一并清除）。
              setPlanMode(sessionId, false)
              setPlanAllowedPrompts(sessionId, allowedPrompts)
              if (p.plan.trim()) {
                try {
                  const updated = db.updateSession(sessionId, { plan: p.plan.trim() })
                  rendererClient.agentEvent.onSessionUpdate(updated)
                } catch (err) {
                  log.error('计划落库失败', { sessionId, error: err })
                }
              }
              // 播种执行进度：模型提交的结构化 steps 优先，缺失时解析计划文本兜底。
              seedPlanProgress(sessionId, payload.title, p.plan, p.steps ?? [])
              log.info('计划已批准，退出计划模式', {
                sessionId,
                requestId,
                allowedPromptsCount: allowedPrompts.length
              })
              resolve({
                content: [
                  {
                    type: 'text',
                    text: '计划已获用户批准，现在开始按计划执行。执行期间请用 report_step 上报进度：每开始一步调用 report_step(status="in_progress")，每完成一步调用 report_step(status="done")，stepIndex 从 0 开始对应提交计划时的步骤顺序。'
                  }
                ],
                details: { approved: true, requestId }
              })
            } else {
              // 拒绝：保持计划模式，Agent 调整后重新提交
              log.info('计划被拒绝，保持计划模式', { sessionId, requestId })
              resolve({
                content: [
                  {
                    type: 'text',
                    text: `计划未获批准。用户反馈：${feedback || '（无）'}\n请根据反馈调整计划后重新调用 exit_plan_mode 提交修改后的计划，或放弃规划。`
                  }
                ],
                details: { approved: false, requestId }
              })
            }
          }
        })
      })
    }
  }

  const reportStepTool: AgentTool<typeof reportStepParams, ReportStepDetails> = {
    name: 'report_step',
    label: '上报步骤进度',
    description:
      '在执行已批准的计划时，向用户上报当前执行进度：每开始一步调用一次（status="in_progress"），每完成一步调用一次（status="done"）。stepIndex 对应 exit_plan_mode 提交计划时 steps 列表的下标（从 0 开始），请按步骤顺序逐步上报。仅在有已批准计划时有效；无计划时调用会被忽略。',
    parameters: reportStepParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p) {
      const error = applyReportStep(sessionId, p.stepIndex, p.status)
      if (error !== null) {
        return {
          content: [{ type: 'text', text: error }],
          details: { stepIndex: p.stepIndex, status: p.status }
        }
      }
      const label = p.status === 'done' ? '完成' : '进行中'
      return {
        content: [
          {
            type: 'text',
            text: `已上报步骤 ${p.stepIndex + 1} 状态为「${label}」。`
          }
        ],
        details: { stepIndex: p.stepIndex, status: p.status }
      }
    }
  }

  return [enterTool, exitTool, reportStepTool]
}
