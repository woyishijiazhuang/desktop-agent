import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { rendererClient } from '../../service/render-client'
import { createLogger } from '../../utils/log'
import type { AskUserOption } from '../types'
import { beginInteraction, getInteractionTimeoutMs } from '../interaction'

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

/** ask_user 等待结果：value=null 时以 skipped 区分超时/中止与用户主动跳过（文案用）。 */
type AskOutcome = {
  value: string | string[] | null
  skipped: 'timeout' | 'abort' | 'manual' | null
}

/**
 * 澄清问题工具（对标 Claude Code 的 AskUserQuestion）：
 * 规划/执行阶段对不确定的需求点提问，挂起等待用户作答后继续。
 * 与 read_file / bash 家族同理按 Agent 会话绑定，故用工厂。
 * 挂起经统一交互通道（interaction.ts）管理：统一超时/中止/会话收尾。
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
      const options: AskUserOption[] = p.options ?? []
      const multiSelect = p.multiSelect ?? false
      const required = p.required ?? false
      const timeoutMs = getInteractionTimeoutMs()
      const expiresAt = timeoutMs > 0 ? Date.now() + timeoutMs : 0
      const slot = beginInteraction<AskOutcome>({
        kind: 'ask_question',
        sessionId,
        timeoutMs,
        signal,
        onTimeout: () => ({ value: null, skipped: 'timeout' }),
        onAbort: () => ({ value: null, skipped: 'abort' })
      })
      rendererClient.agentEvent.onInteractionRequest({
        kind: 'ask_question',
        requestId: slot.requestId,
        sessionId,
        question: p.question,
        options,
        multiSelect,
        required,
        expiresAt
      })
      log.info('提问待用户回答', {
        sessionId,
        requestId: slot.requestId,
        hasOptions: options.length > 0
      })

      const outcome = await slot.promise
      if (outcome.value === null) {
        const text =
          outcome.skipped === 'timeout'
            ? '用户未在时限内回答，已跳过。请基于已有信息继续，必要时可再次提问。'
            : outcome.skipped === 'abort'
              ? '提问已中断。'
              : '用户跳过了该问题。请基于已有信息继续，必要时可再次提问。'
        return {
          content: [{ type: 'text', text }],
          details: { value: null, requestId: slot.requestId }
        }
      }
      const text = Array.isArray(outcome.value) ? outcome.value.join('、') : String(outcome.value)
      return {
        content: [{ type: 'text', text: `用户回答：${text}` }],
        details: { value: outcome.value, requestId: slot.requestId }
      }
    }
  }
}
