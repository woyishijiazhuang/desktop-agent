import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { db } from '../../database'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:search-messages')

const searchParams = Type.Object({
  query: Type.String({
    description: '搜索关键词，用于在历史会话消息中查找相关内容。'
  }),
  limit: Type.Optional(
    Type.Number({ description: '返回结果条数，默认 10，最大 30。' })
  )
})

export const searchMessagesTool: AgentTool<typeof searchParams, { hits: number }> = {
  name: 'search_messages',
  label: '搜索历史消息',
  description:
    '在当前工作区的会话历史中搜索关键词，返回相关对话片段。当用户询问之前讨论过的内容、寻找历史决策记录、或需要回顾过往对话时使用。不搜索已删除的会话。',
  parameters: searchParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const limit = Math.max(1, Math.min(p.limit ?? 10, 30))
    const hits = db.searchMessages(p.query, limit)

    if (hits.length === 0) {
      return {
        content: [{ type: 'text', text: '（未找到相关历史消息）' }],
        details: { hits: 0 }
      }
    }

    const lines = hits.map((h, i) => {
      const time = new Date(h.timestamp).toLocaleString('zh-CN')
      const role = h.role === 'user' ? '用户' : h.role === 'assistant' ? '助手' : h.role
      return `${i + 1}. [${h.sessionTitle}] ${role} (${time})\n${h.snippet}`
    })

    const text = `[历史消息搜索结果 · 共 ${hits.length} 条]\n${lines.join('\n\n')}`
    log.debug('搜索历史消息', { query: p.query, hits: hits.length })
    return { content: [{ type: 'text', text }], details: { hits: hits.length } }
  }
}
