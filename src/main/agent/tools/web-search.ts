import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { getWebSearchApiKey } from './web-search-config'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:web_search')

/** Tavily Web Search API 端点。 */
const TAVILY_WEB_SEARCH_URL = 'https://api.tavily.com/search'

/** 单次返回条数上限（Tavily 单次最多 20，工具默认取前 10，避免上下文过大）。 */
const MAX_RESULTS_LIMIT = 10

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"查最新版文档的用法"）。请务必填写。'
    })
  ),
  query: Type.String({ description: '搜索关键词' }),
  max_results: Type.Optional(Type.Number({ description: '最大返回结果数，默认 5，最多 10' }))
})

interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchDetails {
  query: string
  count: number
}

/** Tavily 响应中单条网页结果的形状（只取用到的字段）。 */
interface TavilyResult {
  title?: string
  url?: string
  content?: string
}

/** Tavily Web Search 响应结构。 */
interface TavilyResponse {
  results?: TavilyResult[]
}

/**
 * 网页搜索工具：调用 Tavily Web Search API，返回标题/URL/摘要。
 * 需先在设置中配置 Tavily API Key（safeStorage 加密存储，执行时解密，明文不出 main 进程）。
 * 只读工具，可并行执行。
 */
export const webSearchTool: AgentTool<typeof params, WebSearchDetails> = {
  name: 'web_search',
  label: '网页搜索',
  description: '使用 Tavily 搜索网页，返回相关结果的标题、URL 和摘要。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    // 未配置 key 时抛错，引导用户在设置中配置
    const apiKey = getWebSearchApiKey()
    const max = Math.min(p.max_results ?? 5, MAX_RESULTS_LIMIT)
    const start = Date.now()
    log.info('网页搜索', { query: p.query, max })
    try {
      const res = await fetch(TAVILY_WEB_SEARCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: p.query,
          max_results: max,
          search_depth: 'basic',
          include_answer: false
        })
      })
      const body = (await res.json().catch(() => null)) as TavilyResponse | null
      // Tavily 业务错误：非 2xx（如 401 无效 key / 429 超额度 / 400 参数错误）或响应缺少 results 时视为失败
      if (!res.ok || !body || typeof body !== 'object' || !Array.isArray(body.results)) {
        const error = `搜索请求失败：${extractError(body, res.status)}`
        log.warn('网页搜索失败', { query: p.query, error, durationMs: Date.now() - start })
        throw new Error(error)
      }

      const results: SearchResult[] = body.results
        .map((r) => ({
          title: (r.title ?? '').trim(),
          url: (r.url ?? '').trim(),
          snippet: (r.content ?? '').trim()
        }))
        .filter((r) => r.title && r.url)
        .slice(0, max)

      log.info('网页搜索完成', {
        query: p.query,
        resultCount: results.length,
        durationMs: Date.now() - start
      })

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到与 "${p.query}" 相关的结果` }],
          details: { query: p.query, count: 0 }
        }
      }

      const text = results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
        .join('\n\n')

      return {
        content: [{ type: 'text', text }],
        details: { query: p.query, count: results.length }
      }
    } catch (err) {
      log.error('网页搜索异常', {
        query: p.query,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }
}

/**
 * 连通性测试：用给定 key（或已保存的 key）跑一次最小搜索。
 * 设置页「测试连接」按钮使用；验证失败抛错并附 Tavily 返回的错误信息。
 */
export async function testWebSearchConnection(key?: string): Promise<void> {
  const apiKey = key?.trim() || getWebSearchApiKey()
  const res = await fetch(TAVILY_WEB_SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: 'test',
      max_results: 1,
      search_depth: 'basic',
      include_answer: false
    })
  })
  const body = (await res.json().catch(() => null)) as TavilyResponse | null
  if (!res.ok || !body || typeof body !== 'object' || !Array.isArray(body.results)) {
    throw new Error(`连接失败：${extractError(body, res.status)}`)
  }
}

/**
 * 从 Tavily 错误响应提取可读详情。
 * Tavily（FastAPI 风格）错误体形如 { "detail": "..." }，优先取 detail，否则回退到 HTTP 状态码。
 */
function extractError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const detail = typeof b.detail === 'string' ? b.detail : ''
    if (detail) return detail
  }
  return `HTTP ${status}`
}
