import type { AgentMessage } from '@earendil-works/pi-agent-core'

/**
 * 消息签名：role::timestamp::toolCallId。
 * 流式期间 message_update 就地替换最后一条同 role 消息，timestamp 不变 → 签名稳定。
 * store 合并（chat-events）与渲染层稳定 key（useStableMessageKeys）共用同一规则，
 * 避免两处各自实现导致失同步（签名变更会让流式替换失效 / key 抖动）。
 */
export function messageSignature(m: AgentMessage): string {
  const role = (m as { role?: string }).role ?? ''
  const ts = (m as { timestamp?: number }).timestamp ?? 0
  const toolCallId = (m as { toolCallId?: string }).toolCallId ?? ''
  return `${role}::${ts}::${toolCallId}`
}
