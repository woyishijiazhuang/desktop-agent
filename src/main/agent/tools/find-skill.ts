import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { listInstalledSkills, slugToId } from '../skills-store'
import {
  DEFAULT_FIND_SKILL_SOURCE,
  FIND_SKILL_SOURCE_LABELS,
  type FindSkillSource,
  SETTING_FIND_SKILL_SOURCE
} from '../types'

const log = createLogger('tool:find_skill')

/** 字节 Find Skill（findskill.com）API 端点，keyword 查询参数须用 query= 才真正过滤。 */
const BYTE_SKILLS_URL = 'https://skills.volces.com/v1/skills'

/** 腾讯 SkillHub API 端点，无需鉴权，keyword 为分词搜索。 */
const TENCENT_SKILLS_URL = 'https://api.skillhub.cn/api/skills'

/** 单次返回条数上限。 */
const MAX_RESULTS_LIMIT = 10

/** 搜索结果内存缓存 TTL（同关键词短时间内重复搜索直接命中，减少外部请求）。 */
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000

/** 搜索结果内存缓存：key = `${source}:${query}`，进程内共享。 */
const searchCache = new Map<string, { items: SkillItem[]; expires: number }>()

function getCachedSearch(source: string, query: string): SkillItem[] | undefined {
  const hit = searchCache.get(`${source}:${query}`)
  if (!hit) return undefined
  if (Date.now() > hit.expires) {
    searchCache.delete(`${source}:${query}`)
    return undefined
  }
  return hit.items
}

function setCachedSearch(source: string, query: string, items: SkillItem[]): void {
  searchCache.set(`${source}:${query}`, { items, expires: Date.now() + SEARCH_CACHE_TTL_MS })
}

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"帮用户找个处理 PDF 的技能"）。请务必填写。'
    })
  ),
  query: Type.String({
    description: '搜索关键词（可用中英文，如「PDF 处理」「周报」「数据分析」）'
  }),
  max_results: Type.Optional(Type.Number({ description: '最大返回结果数，默认 5，最多 10' }))
})

/** 归一化后的技能条目（两个数据源统一结构，供展示）。 */
interface SkillItem {
  name: string
  description: string
  downloads: number
  installs?: number
  homepage?: string
  slug?: string
  source?: string
}

/** 字节 Find Skill 响应中的单条技能（只取用到的字段）。 */
interface ByteSkill {
  Name?: string
  Slug?: string
  Description?: string
  DownloadCount?: number
  SourceType?: string
  SourceRepo?: string
  Metadata?: { DisplayDescription?: string }
}

/** 字节 Find Skill 响应结构。 */
interface ByteResponse {
  Skills?: ByteSkill[]
}

/** 腾讯 SkillHub 响应中的单条技能（只取用到的字段）。 */
interface TencentSkill {
  name?: string
  description_zh?: string
  description?: string
  downloads?: number
  installs?: number
  slug?: string
  homepage?: string
  category?: string
}

/** 腾讯 SkillHub 响应结构。 */
interface TencentResponse {
  code?: number
  data?: { skills?: TencentSkill[] }
}

/**
 * 技能搜索工具：在可选的 Skill 平台（字节 Find Skill / 腾讯 SkillHub）搜索可复用的 AI Agent 技能。
 * 数据源在设置页切换（settings 表持久化），执行时实时读取，切换后下一轮立即生效。
 * 两个平台均开放公开 API、无需鉴权；只读工具，可并行执行。
 */
export const findSkillTool: AgentTool<
  typeof params,
  { query: string; count: number; source: FindSkillSource }
> = {
  name: 'find_skill',
  label: '技能搜索',
  description:
    '搜索可复用的 AI Agent 技能（Skill）。支持字节 Find Skill 与腾讯 SkillHub 两个平台（设置中切换），返回名称、用途说明、下载量与详情页。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const source = getFindSkillSource()
    const max = Math.min(p.max_results ?? 5, MAX_RESULTS_LIMIT)
    const start = Date.now()
    log.info('技能搜索', { query: p.query, source, max })
    try {
      // 缓存命中直接复用（5 分钟 TTL）；未命中走实时请求并回填
      const cached = getCachedSearch(source, p.query)
      const items =
        cached ??
        (source === 'byte' ? await searchByteSkills(p.query) : await searchTencentSkills(p.query))
      if (!cached) setCachedSearch(source, p.query, items)
      const results = items.slice(0, max)
      // 本地安装状态：按 slug 归一化后匹配 manifest，标注已安装/已停用，避免 Agent 对本地技能无谓重装或困惑
      const localSkills = new Map(listInstalledSkills().map((s) => [s.id, s]))
      log.info('技能搜索完成', {
        query: p.query,
        source,
        resultCount: results.length,
        durationMs: Date.now() - start
      })

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `在${FIND_SKILL_SOURCE_LABELS[source]}未找到与 "${p.query}" 相关的技能，可换关键词重试。`
            }
          ],
          details: { query: p.query, count: 0, source }
        }
      }

      const text = results
        .map((r, i) => {
          const lines = [
            `${i + 1}. ${r.name}`,
            r.description ? `   用途：${r.description}` : '',
            r.slug ? `   标识：${r.slug}` : ''
          ]
          // 本地状态标注：帮助 Agent 判断是否已安装/停用，避免重复安装后读取失败
          if (r.slug) {
            const local = localSkills.get(slugToId(r.slug))
            if (local) lines.push(`   本地状态：${local.enabled ? '已安装' : '已安装（已停用）'}`)
          }
          if (typeof r.installs === 'number')
            lines.push(`   安装：${r.installs} · 下载：${r.downloads}`)
          else lines.push(`   下载：${r.downloads}`)
          if (r.source) lines.push(`   来源：${r.source}`)
          if (r.homepage) lines.push(`   详情：${r.homepage}`)
          return lines.filter(Boolean).join('\n')
        })
        .join('\n\n')

      return {
        content: [
          {
            type: 'text',
            text: `在${FIND_SKILL_SOURCE_LABELS[source]}中找到 ${results.length} 个相关技能：\n\n${text}`
          }
        ],
        details: { query: p.query, count: results.length, source }
      }
    } catch (err) {
      log.error('技能搜索异常', {
        query: p.query,
        source,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }
}

/** 字节 Find Skill：GET /v1/skills?query=<keyword>（注意必须用 query 参数，keyword 参数不过滤）。 */
async function searchByteSkills(query: string): Promise<SkillItem[]> {
  const url = new URL(BYTE_SKILLS_URL)
  url.searchParams.set('query', query)
  const res = await fetch(url)
  const body = (await res.json().catch(() => null)) as ByteResponse | null
  if (!res.ok || !body || typeof body !== 'object' || !Array.isArray(body.Skills)) {
    throw new Error(`Find Skill 请求失败：${extractError(body, res.status)}`)
  }
  return body.Skills.map((s) => ({
    name: s.Name || s.Slug || '未命名技能',
    description: s.Metadata?.DisplayDescription || s.Description || '',
    downloads: s.DownloadCount ?? 0,
    slug: s.Slug,
    source: s.SourceType ? `${s.SourceType}${s.SourceRepo ? `/${s.SourceRepo}` : ''}` : undefined
  })).filter((s) => s.name)
}

/** 腾讯 SkillHub：GET /api/skills?keyword=<keyword>&sortBy=score。 */
async function searchTencentSkills(query: string): Promise<SkillItem[]> {
  const url = new URL(TENCENT_SKILLS_URL)
  url.searchParams.set('keyword', query)
  url.searchParams.set('sortBy', 'score')
  url.searchParams.set('pageSize', String(MAX_RESULTS_LIMIT))
  const res = await fetch(url)
  const body = (await res.json().catch(() => null)) as TencentResponse | null
  if (!res.ok || !body || body.code !== 0 || !body.data || !Array.isArray(body.data.skills)) {
    throw new Error(`SkillHub 请求失败：${extractError(body, res.status)}`)
  }
  return body.data.skills
    .map((s) => ({
      name: s.name || s.slug || '未命名技能',
      description: s.description_zh || s.description || '',
      downloads: s.downloads ?? 0,
      installs: s.installs ?? 0,
      homepage: s.homepage || (s.slug ? `https://skillhub.cn/skills/${s.slug}` : undefined),
      slug: s.slug,
      source: s.category
    }))
    .filter((s) => s.name)
}

/**
 * 连通性测试：用指定数据源跑一次最小搜索。
 * 设置页「测试连接」按钮使用；验证失败抛错并附平台返回的错误信息。
 */
export async function testFindSkillConnection(source: FindSkillSource): Promise<void> {
  const items = source === 'byte' ? await searchByteSkills('PDF') : await searchTencentSkills('PDF')
  if (items.length === 0) throw new Error('连接成功但未搜索到技能')
}

/**
 * 读取当前技能搜索数据源（settings 表持久化，非法值回退默认）。
 * 工具执行时实时调用，设置页切换后无需驱逐 Agent 即下一轮生效。
 */
export function getFindSkillSource(): FindSkillSource {
  const v = db.getSetting<FindSkillSource>(SETTING_FIND_SKILL_SOURCE)
  return v === 'byte' || v === 'tencent' ? v : DEFAULT_FIND_SKILL_SOURCE
}

/** 保存技能搜索数据源（覆盖旧值）。 */
export function setFindSkillSourceConfig(source: FindSkillSource): void {
  if (source !== 'byte' && source !== 'tencent') throw new Error('未知的技能搜索数据源')
  db.setSetting(SETTING_FIND_SKILL_SOURCE, source)
  log.info('已切换技能搜索数据源', { source })
}

/** 从错误响应提取可读详情，回退到 HTTP 状态码。 */
function extractError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const detail = typeof b.detail === 'string' ? b.detail : ''
    const message = typeof b.message === 'string' ? b.message : ''
    const msg = detail || message
    if (msg) return msg
  }
  return `HTTP ${status}`
}
