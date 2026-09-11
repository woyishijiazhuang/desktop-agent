import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { rendererClient } from '../../infra/render-client'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import type { PlanApprovalRequest } from '../types'
import { setPlanMode, markPlanAutoAllow, seedPlanProgress, applyReportStep } from '../runtime/plan-mode'
import { beginInteraction, getInteractionTimeoutMs } from '../runtime/interaction'

const log = createLogger('tool:plan_mode')

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
  status: Type.Union([Type.Literal('in_progress'), Type.Literal('done')], {
    description: '上报的状态：开始执行该步骤填 in_progress，完成填 done'
  })
})

/** exit_plan_mode 等待结果（timedOut=true 区别于用户主动拒绝，文案用）。 */
type PlanOutcome = { approved: boolean; feedback: string; timedOut: boolean }

/**
 * Plan Mode 工具（对标 Claude Code 的 EnterPlanMode / ExitPlanMode）：
 * - enter_plan_mode：进入计划模式，此后危险工具被拦截，Agent 只能规划
 * - exit_plan_mode：提交计划并挂起等待用户审批；批准即视为本轮危险工具自动放行
 *   （破坏性 deny 兜底仍强制确认），拒绝则保持计划模式，Agent 根据反馈调整后重新提交
 * - report_step：已批准计划的执行进度上报（开始/完成某一步时调用），驱动前端进度条
 * 与 read_file / bash 家族同理按 Agent 会话绑定，故用工厂。
 * 审批挂起经统一交互通道（interaction.ts）管理。
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
      '将完整计划提交给用户审批（plan 参数）。用户批准后返回批准结果并退出计划模式（可开始执行，本轮危险操作不再逐条确认）；用户拒绝则返回反馈，需调整后重新调用本工具提交修改后的计划。',
    parameters: exitParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p, signal) {
      const timeoutMs = getInteractionTimeoutMs()
      const expiresAt = timeoutMs > 0 ? Date.now() + timeoutMs : 0
      const slot = beginInteraction<PlanOutcome>({
        kind: 'plan_approval',
        sessionId,
        timeoutMs,
        signal,
        onTimeout: () => ({ approved: false, feedback: '', timedOut: true }),
        onAbort: () => ({ approved: false, feedback: '', timedOut: true })
      })
      const payload: PlanApprovalRequest = {
        kind: 'plan_approval',
        requestId: slot.requestId,
        sessionId,
        title: p.title?.trim() || '计划',
        plan: p.plan,
        expiresAt
      }
      rendererClient.agentEvent.onInteractionRequest(payload)
      log.info('提交计划待审批', {
        sessionId,
        requestId: slot.requestId,
        title: payload.title,
        planLength: p.plan.length
      })
      const result = await slot.promise
      if (result.approved) {
        // 批准：退出计划模式 + 登记本轮自动放行（run 内危险工具免逐条确认，deny 兜底除外）；
        // 计划落库供回看/跨会话复用；播种执行进度供 report_step 驱动。
        setPlanMode(sessionId, false)
        markPlanAutoAllow(sessionId)
        if (p.plan.trim()) {
          try {
            const updated = db.updateSession(sessionId, { plan: p.plan.trim() })
            rendererClient.agentEvent.onSessionUpdate(updated)
          } catch (err) {
            log.error('计划落库失败', { sessionId, error: err })
          }
        }
        seedPlanProgress(sessionId, payload.title, p.plan, p.steps ?? [])
        log.info('计划已批准，本轮危险工具自动放行', { sessionId, requestId: slot.requestId })
        return {
          content: [
            {
              type: 'text',
              text: '计划已获用户批准，现在开始按计划执行。执行期间请用 report_step 上报进度：每开始一步调用 report_step(status="in_progress")，每完成一步调用 report_step(status="done")，stepIndex 从 0 开始对应提交计划时的步骤顺序。'
            }
          ],
          details: { approved: true, requestId: slot.requestId }
        }
      }
      // 拒绝：保持计划模式，Agent 调整后重新提交
      log.info('计划被拒绝，保持计划模式', { sessionId, requestId: slot.requestId })
      const text = result.timedOut
        ? '计划审批超时未响应，已自动拒绝。请重新调用 exit_plan_mode 提交计划，或放弃规划。'
        : `计划未获批准。用户反馈：${result.feedback || '（无）'}\n请根据反馈调整计划后重新调用 exit_plan_mode 提交修改后的计划，或放弃规划。`
      return {
        content: [{ type: 'text', text }],
        details: { approved: false, requestId: slot.requestId }
      }
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
