import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { rendererClient } from '../../service/render-client'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { DEFAULT_PERMISSION_TIMEOUT_SEC } from '../types'
import type { PlanApprovalRequest } from '../types'
import {
  setPlanMode,
  setPlanAllowedPrompts,
  seedPlanProgress,
  applyReportStep,
  waitForPlanApproval
} from '../plan-mode'

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
  status: Type.Union([Type.Literal('in_progress'), Type.Literal('done')], {
    description: '上报的状态：开始执行该步骤填 in_progress，完成填 done'
  })
})

/**
 * Plan Mode 工具（对标 Claude Code 的 EnterPlanMode / ExitPlanMode）：
 * - enter_plan_mode：进入计划模式，此后危险工具被拦截，Agent 只能规划
 * - exit_plan_mode：提交计划并挂起等待用户审批；批准后退出计划模式并放行执行，
 *   拒绝则保持计划模式，Agent 根据反馈调整后重新提交
 * - report_step：已批准计划的执行进度上报（开始/完成某一步时调用），驱动前端进度条
 * 与 read_file / bash 家族同理按 Agent 会话绑定，故用工厂。
 * 会话级状态与审批回执见 ../plan-mode。
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
      const result = await waitForPlanApproval(
        requestId,
        sessionId,
        DEFAULT_PERMISSION_TIMEOUT_SEC * 1000
      )
      if (result.approved) {
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
        return {
          content: [
            {
              type: 'text',
              text: '计划已获用户批准，现在开始按计划执行。执行期间请用 report_step 上报进度：每开始一步调用 report_step(status="in_progress")，每完成一步调用 report_step(status="done")，stepIndex 从 0 开始对应提交计划时的步骤顺序。'
            }
          ],
          details: { approved: true, requestId }
        }
      }
      // 拒绝：保持计划模式，Agent 调整后重新提交
      log.info('计划被拒绝，保持计划模式', { sessionId, requestId })
      const text = result.timedOut
        ? '计划审批超时未响应，已自动拒绝。请重新调用 exit_plan_mode 提交计划，或放弃规划。'
        : `计划未获批准。用户反馈：${result.feedback || '（无）'}\n请根据反馈调整计划后重新调用 exit_plan_mode 提交修改后的计划，或放弃规划。`
      return {
        content: [{ type: 'text', text }],
        details: { approved: false, requestId }
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
