import { createLogger } from '../../utils/log'
import { respondInteraction } from './interaction'

const log = createLogger('askUser')

/**
 * ask_user 提问回执（工具侧挂起经统一交互通道管理，见 tools/ask-user.ts 的 beginInteraction）。
 * renderer 作答后调 agent.respondAskUser 最终落到这里，解除 ask_user 的挂起。
 */
export function resolveAskUser(requestId: string, value: string | string[] | null): void {
  if (!respondInteraction(requestId, { value })) {
    log.warn('收到未知提问回执', { requestId })
  }
}
