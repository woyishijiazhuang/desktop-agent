import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { rendererClient } from '../../service/render-client'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { SETTING_PERMISSION_TIMEOUT_SEC, DEFAULT_PERMISSION_TIMEOUT_SEC } from '../types'
import type { AskUserOption, AskUserRequest } from '../types'
import { waitForAskUserAnswer } from '../ask-user'

const log = createLogger('tool:ask_user')

const askParams = Type.Object({
  question: Type.String({
    description:
      '要问用户的问题。用简洁明确的话描述需要确认的信息（例如「这个改动希望覆盖哪些平台？」）。'
  }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ description: '选项显示文本（简短）' }),
        value: Type.String({ description: '选项值（模型需要的信息，通常与 label 相同或更简洁）' })
      }),
      {
        description: '预置选项（可选）。提供后用户可点选，无需逐字输入；不提供则用户自由输入。'
      }
    )
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: '是否允许多选（默认 false）。仅对选项生效。' })
  ),
  required: Type.Optional(
    Type.Boolean({ description: '是否必答（默认 false）。true 时用户必须作答才能继续。' })
  )
})

export interface AskUserDetails {
  value: string | string[] | null
  requestId: string
}

/**
 * 澄清问题工具（对标 Claude Code 的 AskUserQuestion）：
 * 规划/执行阶段对不确定的需求点提问，挂起等待用户作答后继续。
 * 与 read_file / bash 家族同理按 Agent 会话绑定，故用工厂。
 * 会话级挂起/回执见 ../ask-user。
 */
export function createAskUserTool(sessionId: string): AgentTool<typeof askParams, AskUserDetails> {
  return {
    name: 'ask_user',
    label: '询问用户',
    description:
      '向用户提问以澄清需求或确认关键决策。在需求模糊、有多个可行方案、或改动影响面不确定时使用（例如进入计划模式规划前、提交计划前确认关键取舍）。提供 options 选项让用户点选，比自由输入更快。注意：仅在确实需要用户输入时使用，不要滥用。',
    parameters: askParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p, signal) {
      const requestId = randomUUID()
      const options: AskUserOption[] = p.options ?? []
      const multiSelect = p.multiSelect ?? false
      const required = p.required ?? false
      // 超时实时读取设置（秒 → ms）：0 = 一直等待，不设超时兜底。
      const timeoutSec = readAskTimeoutSec()
      const expiresAt = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : 0
      const payload: AskUserRequest = {
        requestId,
        sessionId,
        question: p.question,
        options,
        multiSelect,
        required,
        expiresAt
      }
      rendererClient.agentEvent.onAskUserRequest(payload)
      log.info('提问待用户回答', { sessionId, requestId, hasOptions: options.length > 0 })

      const answer = await waitForAskUserAnswer(
        requestId,
        sessionId,
        timeoutSec > 0 ? timeoutSec * 1000 : 0,
        signal
      )
      if (answer.value === null) {
        const text = answer.timedOut
          ? '用户未在时限内回答，已跳过。请基于已有信息继续，必要时可再次提问。'
          : '用户跳过了该问题。请基于已有信息继续，必要时可再次提问。'
        return {
          content: [{ type: 'text', text }],
          details: { value: null, requestId }
        }
      }
      const text = Array.isArray(answer.value) ? answer.value.join('、') : String(answer.value)
      return {
        content: [{ type: 'text', text: `用户回答：${text}` }],
        details: { value: answer.value, requestId }
      }
    }
  }
}

/** 读取提问超时设置（与工具确认共用同一配置；非法/未配置回退默认；0 = 一直等待）。 */
function readAskTimeoutSec(): number {
  const v = db.getSetting<number>(SETTING_PERMISSION_TIMEOUT_SEC)
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : DEFAULT_PERMISSION_TIMEOUT_SEC
}
