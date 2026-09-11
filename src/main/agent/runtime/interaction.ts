import { randomUUID } from 'node:crypto'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import type { InteractionKind } from '../types'
import { SETTING_PERMISSION_TIMEOUT_SEC, DEFAULT_PERMISSION_TIMEOUT_SEC } from '../types'

const log = createLogger('interaction')

/**
 * 统一「等用户」通道（危险工具确认 / 计划审批 / 澄清提问共用）。
 *
 * 三套机制此前各维护一份 pending map + 超时定时器 + abort 监听 + 会话清理，
 * 超时口径还不一致。本模块把这份机械逻辑收敛到一处：
 * - beginInteraction 统一注册挂起、统一超时（读取 permission.timeoutSec）、统一响应 abort；
 * - respondInteraction 统一回传（renderer 仍走各自的 respondPermission/Plan/AskUser 薄包装）；
 * - clearSessionInteractions 在 agent_end 收尾时统一解除残留挂起，杜绝 Promise 泄漏。
 * 各域的「结果语义」（超时=拒绝 / 跳过 / 拒绝）仍由调用方以 onTimeout/onAbort 提供。
 */

interface PendingEntry {
  sessionId: string
  kind: InteractionKind
  timer: ReturnType<typeof setTimeout> | null
  signal: AbortSignal | undefined
  onAbortListener: (() => void) | undefined
  /** 会话收尾/中止时的兜底结果工厂（kind 各自语义）。 */
  onAbort: () => unknown
  resolve: (value: unknown) => void
  ctx: unknown
}

const pending = new Map<string, PendingEntry>()

function cleanupEntry(entry: PendingEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (entry.signal && entry.onAbortListener) {
    entry.signal.removeEventListener('abort', entry.onAbortListener)
    entry.onAbortListener = undefined
  }
}

function resolveEntry(requestId: string, entry: PendingEntry, value: unknown): void {
  pending.delete(requestId)
  cleanupEntry(entry)
  entry.resolve(value)
}

export interface InteractionSlot<T> {
  requestId: string
  promise: Promise<T>
  /** 挂起期间登记的上下文（respond 处理读 ctx 记录放行规则）。 */
  ctx: unknown
}

export interface BeginInteractionOptions<T> {
  kind: InteractionKind
  sessionId: string
  /** 等待上限（毫秒）；0 = 一直等待。 */
  timeoutMs: number
  /** agent.run 中止信号：中止时按 onAbort 收尾，避免挂起的 Promise 泄漏。 */
  signal?: AbortSignal
  /** 供 respond 决策时读取的上下文（如权限请求的 tool/args/deny 信息）。 */
  ctx?: unknown
  /** 超时兜底结果（kind 各自语义：权限→拒绝、计划→拒绝、提问→跳过）。 */
  onTimeout: () => T
  /** 中止/会话收尾清理时的结果；缺省复用 onTimeout。 */
  onAbort?: () => T
}

/** 开启一次等待用户交互。返回 requestId 供推送 renderer 载荷；await promise 取回结果。 */
export function beginInteraction<T>(opts: BeginInteractionOptions<T>): InteractionSlot<T> {
  const { kind, sessionId, timeoutMs, signal, ctx } = opts
  const requestId = randomUUID()
  let resolveFn!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  const entry: PendingEntry = {
    sessionId,
    kind,
    timer: null,
    signal,
    onAbortListener: undefined,
    onAbort: opts.onAbort ?? opts.onTimeout,
    resolve: (value) => resolveFn(value as T),
    ctx
  }
  if (timeoutMs > 0) {
    entry.timer = setTimeout(() => {
      log.warn('交互等待超时', { sessionId, kind, requestId, timeoutMs })
      resolveEntry(requestId, entry, opts.onTimeout())
    }, timeoutMs)
  }
  if (signal) {
    const onAbort = (): void => resolveEntry(requestId, entry, (opts.onAbort ?? opts.onTimeout)())
    if (signal.aborted) {
      onAbort()
    } else {
      entry.onAbortListener = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
  pending.set(requestId, entry)
  return { requestId, promise, ctx }
}

/** 回传一次交互结果（renderer 的 respond* 薄包装最终都落到这里）。 */
export function respondInteraction(requestId: string, value: unknown): boolean {
  const entry = pending.get(requestId)
  if (!entry) {
    log.warn('收到未知交互回执', { requestId })
    return false
  }
  resolveEntry(requestId, entry, value)
  return true
}

/** 读取挂起条目登记的上下文（权限回执记录放行规则用）；未知 requestId 返回 undefined。 */
export function getInteractionCtx(requestId: string): unknown {
  return pending.get(requestId)?.ctx
}

/** 当前某会话挂起的交互数（日志/调试用）。 */
export function countSessionInteractions(sessionId: string): number {
  let n = 0
  for (const e of pending.values()) if (e.sessionId === sessionId) n++
  return n
}

/**
 * 解除某会话全部挂起交互（agent_end 收尾时调用，兜底防泄漏）。
 * 每个挂起按其 onAbort 语义收尾（权限→拒绝、计划→拒绝、提问→跳过）。
 */
export function clearSessionInteractions(sessionId: string, reason = '会话收尾'): void {
  for (const [requestId, entry] of pending) {
    if (entry.sessionId !== sessionId) continue
    log.warn('解除挂起交互', { sessionId, kind: entry.kind, requestId, reason })
    resolveEntry(requestId, entry, entry.onAbort())
  }
}

/** 交互等待上限（毫秒）：实时读 permission.timeoutSec，0 = 一直等待。 */
export function getInteractionTimeoutMs(): number {
  const v = db.getSetting<number>(SETTING_PERMISSION_TIMEOUT_SEC)
  const sec =
    typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? Math.floor(v)
      : DEFAULT_PERMISSION_TIMEOUT_SEC
  return sec * 1000
}
