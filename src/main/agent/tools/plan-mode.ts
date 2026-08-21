import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { rendererClient } from '../../utils/render-client'
import { createLogger } from '../../utils/log'
import { PERMISSION_TIMEOUT_MS } from '../types'
import type { PlanApprovalRequest } from '../types'

const log = createLogger('tool:plan_mode')

/**
 * 会话级计划模式状态：true 期间危险工具（bash/write/edit/install_skill）
 * 被 beforeToolCall 拦截（见 permission.ts），强制先提交计划获得批准。
 * 按单次 run 生效：agent_start 时清除（agent-manager 调用）。
 */
const sessionPlanMode = new Map<string, boolean>()

export function setPlanMode(sessionId: string, on: boolean): void {
  if (on) sessionPlanMode.set(sessionId, true)
  else sessionPlanMode.delete(sessionId)
}

export function isPlanMode(sessionId: string): boolean {
  return sessionPlanMode.has(sessionId)
}

/** 新一轮 run 开始时清除（计划模式按 run 生效，避免跨轮残留拦截）。 */
export function clearPlanMode(sessionId: string): void {
  sessionPlanMode.delete(sessionId)
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
  })
})

export interface EnterPlanDetails {
  /** 无 */
}

export interface ExitPlanDetails {
  approved: boolean
  requestId: string
}

/**
 * Plan Mode 工具（对标 Claude Code 的 EnterPlanMode / ExitPlanMode）：
 * - enter_plan_mode：进入计划模式，此后危险工具被拦截，Agent 只能规划
 * - exit_plan_mode：提交计划并挂起等待用户审批；批准后退出计划模式并放行执行，
 *   拒绝则保持计划模式，Agent 根据反馈调整后重新提交
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
      const payload: PlanApprovalRequest = {
        requestId,
        sessionId,
        title: p.title?.trim() || '计划',
        plan: p.plan
      }
      rendererClient.agentEvent.onPlanRequest(payload)
      log.info('提交计划待审批', {
        sessionId,
        requestId,
        title: payload.title,
        planLength: p.plan.length
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
        }, PERMISSION_TIMEOUT_MS)
        pending.set(requestId, {
          sessionId,
          resolve: (approved, feedback) => {
            clearTimeout(timer)
            pending.delete(requestId)
            if (approved) {
              // 批准：退出计划模式，放行后续执行
              setPlanMode(sessionId, false)
              log.info('计划已批准，退出计划模式', { sessionId, requestId })
              resolve({
                content: [{ type: 'text', text: '计划已获用户批准，现在开始按计划执行。' }],
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

  return [enterTool, exitTool]
}
