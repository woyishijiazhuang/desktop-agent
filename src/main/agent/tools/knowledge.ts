import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { db } from '../../database'
import { embedTexts, embeddingCost, embeddingModelKey, resolveKbEmbedding } from '../embedding'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:knowledge')

const searchParams = Type.Object({
  query: Type.String({
    description: '检索问题或关键词，应与用户意图的核心内容相关，越长越具体检索越准。'
  }),
  limit: Type.Optional(Type.Number({ description: '返回结果条数，默认 8，最大 20。' }))
})

export const searchKnowledgeTool: AgentTool<typeof searchParams, { hits: number }> = {
  name: 'search_knowledge',
  label: '检索知识库',
  description:
    '在本地文档知识库中检索与查询相关的内容片段。当用户问题涉及已导入的文档（产品文档、技术资料、个人笔记、研究报告等）时优先调用；检索结果包含来源文档与小节标题，请基于检索到的内容回答，并在必要时注明来源。知识库中无相关内容时返回空结果。',
  parameters: searchParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const limit = Math.max(1, Math.min(p.limit ?? 8, 20))
    const embedding = resolveKbEmbedding()

    // 仅当存在可用向量时嵌入查询（避免无向量场景白费一次 embedding 调用）。
    let queryVector: Float32Array | null = null
    let vectorModel: string | null = null
    if (embedding) {
      const key = embeddingModelKey(embedding)
      if (db.hasVectors(key)) {
        try {
          const res = await embedTexts([p.query], embedding)
          queryVector = res.vectors[0] ?? null
          vectorModel = key
          db.recordEmbeddingUsage({
            configId: embedding.configId,
            model: embedding.modelId,
            tokens: res.tokens,
            cost: embeddingCost(res.tokens, embedding.inputPricePerM)
          })
        } catch (err) {
          log.warn('查询向量化失败，退化为关键词检索', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    const hits = db.searchKnowledge(p.query, { limit, queryVector, vectorModel })
    const useVector = queryVector !== null
    if (hits.length === 0) {
      return {
        content: [{ type: 'text', text: '（知识库中未检索到相关内容）' }],
        details: { hits: 0 }
      }
    }
    const lines = hits.map(
      (h, i) => `${i + 1}. 《${h.docTitle}》${h.title ? ` · ${h.title}` : ''}\n${h.content}`
    )
    const text = `[知识库检索结果 · ${useVector ? '语义' : '关键词'}匹配]\n${lines.join('\n\n')}`
    log.debug('知识库检索工具', { query: p.query, hits: hits.length, useVector })
    return { content: [{ type: 'text', text }], details: { hits: hits.length } }
  }
}
