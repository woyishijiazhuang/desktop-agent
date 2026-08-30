import { createLogger } from '../utils/log'

const log = createLogger('askUser')

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

export interface AskUserAnswer {
  value: string | string[] | null
  /** true = 超时自动跳过（区别于用户主动跳过，用于工具侧文案区分）。 */
  timedOut: boolean
}

/**
 * 挂起等待用户回答（ask_user 工具调用）。
 * timeoutMs = 0 表示一直等待；回答经 resolveAskUser 由 renderer 回传，或由会话清理/超时/中止解除。
 */
export function waitForAskUserAnswer(
  requestId: string,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<AskUserAnswer> {
  return new Promise((resolve) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(requestId)
            log.warn('提问超时，按跳过处理', { sessionId, requestId })
            resolve({ value: null, timedOut: true })
          }, timeoutMs)
        : null
    const finish = (value: string | string[] | null): void => {
      if (timer) clearTimeout(timer)
      pending.delete(requestId)
      resolve({ value, timedOut: false })
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
