import { computed, type ComputedRef } from 'vue'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { messageSignature } from '../utils/messageKey'

/**
 * 为无稳定 id 的 AgentMessage 列表生成稳定 key（纯渲染层映射，不污染 store）。
 *
 * pi-ai 的 Message 类型没有稳定 id 字段，仅有 timestamp（可能重复）/ toolCallId（toolResult）/
 * responseId?（assistant）。直接用数组索引作 key 会在流式更新/全量替换时导致组件重挂载，
 * 使流式 Markdown 渲染器无法做增量 diff。
 *
 * signature = role + '::' + timestamp + '::' + (toolCallId ?? '')。
 * 流式期间 message_update 就地替换最后一条同 role 消息，timestamp 不变 → signature 不变 →
 * key 不变 → Vue 仅 patch content prop，markstream 走增量渲染而非重挂载。
 * agent_end 全量替换权威 transcript 时，已存在的 signature 复用旧 id，避免末尾重挂载。
 */
export interface KeyedMessage {
  id: string
  message: AgentMessage
}

/** 生成短 id（无需第三方依赖）。 */
function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/**
 * @param messages 消息列表的 getter（传 () => props.messages 即可）
 * @returns 带稳定 id 的列表 computed
 *
 * 性能：流式热路径优化。流式期间 store 只替换末条消息（列表长度与引用不变、
 * 前缀元素引用不变），此时直接复用上一轮的 id 映射、仅重映射末条，把每 token
 * 的代价从 O(n) 的 signature 构建/对象分配降为 O(n) 引用比较（前缀校验保证
 * 正确性：任何非末条变化都会落入全量路径）。列表结构性变化（新增/删除/换数组）
 * 时走全量路径并修剪 cache，行为与原实现一致。
 */
export function useStableMessageKeys(messages: () => AgentMessage[]): ComputedRef<KeyedMessage[]> {
  // signature → id 的记忆表。每轮修剪未出现的条目，使缓存随当前列表收缩，避免跨会话无限增长。
  const cache = new Map<string, string>()
  // 上一轮映射结果（快速路径复用前缀）。
  let lastResult: KeyedMessage[] | null = null

  return computed(() => {
    const list = messages()

    // 快速路径：长度不变且前缀引用相同（即仅末条被流式替换）→ 复用前缀映射。
    if (
      lastResult &&
      lastResult.length === list.length &&
      list.length > 0 &&
      lastResult[lastResult.length - 1].message !== list[list.length - 1]
    ) {
      let prefixSame = true
      for (let i = 0; i < list.length - 1; i++) {
        if (lastResult[i].message !== list[i]) {
          prefixSame = false
          break
        }
      }
      if (prefixSame) {
        const msg = list[list.length - 1]
        const sig = messageSignature(msg)
        let id = cache.get(sig)
        if (!id) {
          id = uid()
          cache.set(sig, id)
        }
        const result = lastResult.slice()
        result[result.length - 1] = { id, message: msg }
        lastResult = result
        return result
      }
    }

    // 全量路径（原逻辑）
    const seen = new Set<string>()
    const result: KeyedMessage[] = list.map((message) => {
      const sig = messageSignature(message)
      seen.add(sig)
      let id = cache.get(sig)
      if (!id) {
        id = uid()
        cache.set(sig, id)
      }
      return { id, message }
    })
    for (const key of cache.keys()) {
      if (!seen.has(key)) cache.delete(key)
    }
    lastResult = result
    return result
  })
}
