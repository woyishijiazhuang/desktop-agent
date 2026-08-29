import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { rendererClient } from '../../utils/render-client'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { SETTING_PERMISSION_TIMEOUT_SEC, DEFAULT_PERMISSION_TIMEOUT_SEC } from '../types'
import type { AskUserOption, AskUserRequest } from '../types'

const log = createLogger('tool:ask_user')

/** 待回答的提问：requestId → 决议回调（value = null 表示用户跳过 / 超时）。 */
interface PendingAsk {
  sessionId: string
  resolve: (value: string | string[] | null) => void
}
const pending = new Map<string, PendingAsk>()

/** renderer 回传用户回答，解除 ask_user 的挂起。 */
export function resolveAskUser(requestId: string, value: string | string[] | null): void {
  const req = pending.get(requestId)
  if (!req) {
    log.warn('收到未知提问回执', { requestId })
    return
  }
  pending.delete(requestId)
  log.info('提问已回传', { sessionId: req.sessionId, requestId, value })
  req.resolve(value)
}

/** 会话结束（agent_end）时清理残留的挂起提问，避免 Promise 泄漏。 */
export function clearAskUserRequests(sessionId: string): void {
  for (const [requestId, req] of pending) {
    if (req.sessionId === sessionId) {
      pending.delete(requestId)
      log.info('会话结束，清理挂起提问', { sessionId, requestId })
      req.resolve(null)
    }
  }
}

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

      return new Promise((resolve) => {
        const timer =
          timeoutSec > 0
            ? setTimeout(() => {
                pending.delete(requestId)
                log.warn('提问超时，按跳过处理', { sessionId, requestId })
                resolve({
                  content: [
                    {
                      type: 'text',
                      text: '用户未在时限内回答，已跳过。请基于已有信息继续，必要时可再次提问。'
                    }
                  ],
                  details: { value: null, requestId }
                })
              }, timeoutSec * 1000)
            : null
        const finish = (value: string | string[] | null): void => {
          if (timer) clearTimeout(timer)
          pending.delete(requestId)
          if (value === null) {
            resolve({
              content: [
                { type: 'text', text: '用户跳过了该问题。请基于已有信息继续，必要时可再次提问。' }
              ],
              details: { value: null, requestId }
            })
          } else {
            const text = Array.isArray(value) ? value.join('、') : String(value)
            resolve({
              content: [{ type: 'text', text: `用户回答：${text}` }],
              details: { value, requestId }
            })
          }
        }
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              log.warn('提问已中断', { sessionId, requestId })
              finish(null)
            },
            { once: true }
          )
        }
        pending.set(requestId, { sessionId, resolve: finish })
      })
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
