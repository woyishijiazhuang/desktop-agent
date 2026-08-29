import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { db } from '../../database'
import type { MemoryCategory } from '../../database'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:memory')

const CATEGORY_DESCRIPTION =
  '分类：general 通用 / preference 偏好 / fact 事实 / project 项目。默认 general。'

/** 单条记忆的行内展示（供 Agent 阅读）。 */
function formatMemory(m: {
  id: string
  content: string
  category: MemoryCategory
  source: string
}): string {
  return `[${m.id}] (${m.category}/${m.source}) ${m.content}`
}

const listParams = Type.Object({
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal('general'),
        Type.Literal('preference'),
        Type.Literal('fact'),
        Type.Literal('project')
      ],
      { description: '可选分类，不传则返回全部。' }
    )
  )
})

const addParams = Type.Object({
  content: Type.String({
    description:
      '记忆内容（简明、客观、第三人称，如「用户是后端开发者，偏好 Python」）。不超过 500 字。'
  }),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal('general'),
        Type.Literal('preference'),
        Type.Literal('fact'),
        Type.Literal('project')
      ],
      { description: CATEGORY_DESCRIPTION }
    )
  )
})

const updateParams = Type.Object({
  id: Type.String({ description: '目标记忆条目的 id（来自 list_memories 的 [id] 前缀）。' }),
  content: Type.Optional(Type.String({ description: '新的记忆内容。不传则只更新分类。' })),
  category: Type.Optional(
    Type.Union(
      [
        Type.Literal('general'),
        Type.Literal('preference'),
        Type.Literal('fact'),
        Type.Literal('project')
      ],
      { description: '新的分类。不传则保持不变。' }
    )
  )
})

const deleteParams = Type.Object({
  id: Type.String({ description: '要删除的记忆条目 id（来自 list_memories 的 [id] 前缀）。' })
})

export const listMemoriesTool: AgentTool<typeof listParams, { count: number }> = {
  name: 'list_memories',
  label: '查看记忆',
  description:
    '查看长期记忆中已保存的条目（用户的事实、偏好、进行中的项目等，跨会话保留）。可选按分类过滤。',
  parameters: listParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    let list = db.listMemories()
    if (p.category) {
      list = list.filter((m) => m.category === p.category)
    }
    const text = list.length === 0 ? '（暂无记忆条目）' : list.map(formatMemory).join('\n')
    log.debug('查看记忆', { count: list.length, category: p.category })
    return { content: [{ type: 'text', text }], details: { count: list.length } }
  }
}

export const addMemoryTool: AgentTool<typeof addParams, { id?: string }> = {
  name: 'add_memory',
  label: '添加记忆',
  description:
    '将一条值得长期记住的信息保存为记忆条目（例如用户的身份、偏好、重要约束，或持续进行的项目背景）。保存后后续新建的会话都会参考它。只在用户明确希望记住、或该信息对未来对话有稳定价值时调用，不要保存一次性、临时或可随时查证的信息。记忆总量有上限（30 条 / 3000 字），已满时需先 update_memory 精简或 delete_memory 删除后再添加。',
  parameters: addParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    try {
      const m = db.addMemory({
        content: p.content,
        category: p.category ?? 'general',
        // Agent 主动通过工具保存的记忆标记为自动来源（区别于用户在记忆面板手动添加）
        source: 'auto'
      })
      log.info('添加记忆', { id: m.id, category: m.category })
      return {
        content: [{ type: 'text', text: `已保存记忆：${m.content}。后续会话将自动参考它。` }],
        details: { id: m.id }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('添加记忆失败', { error: msg })
      return {
        content: [
          {
            type: 'text',
            text: `保存记忆失败：${msg}。请告知用户记忆已达上限，建议先 update_memory 精简过时条目，或 delete_memory 删除不再需要的条目后再添加。`
          }
        ],
        details: {}
      }
    }
  }
}

export const updateMemoryTool: AgentTool<typeof updateParams, { id: string }> = {
  name: 'update_memory',
  label: '更新记忆',
  description:
    '更新一条已存在的记忆条目（用 list_memories 获取 id 后再更新）。当记忆内容已过时、或用户明确纠正了此前记录的信息时调用。',
  parameters: updateParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const existing = db.getMemory(p.id)
    if (!existing) {
      return {
        content: [
          { type: 'text', text: `未找到 id 为 ${p.id} 的记忆条目，请先 list_memories 确认。` }
        ],
        details: { id: p.id }
      }
    }
    try {
      const m = db.updateMemory(p.id, {
        content: p.content?.trim() ? p.content : undefined,
        category: p.category
      })
      log.info('更新记忆', { id: m.id })
      return {
        content: [{ type: 'text', text: `已更新记忆：${m.content}` }],
        details: { id: m.id }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('更新记忆失败', { error: msg })
      return {
        content: [{ type: 'text', text: `更新记忆失败：${msg}` }],
        details: { id: p.id }
      }
    }
  }
}

export const deleteMemoryTool: AgentTool<typeof deleteParams, { id: string }> = {
  name: 'delete_memory',
  label: '删除记忆',
  description:
    '删除一条记忆条目（用 list_memories 获取 id 后再删除）。当记忆已失效、被用户明确否定或确认不再需要时调用。',
  parameters: deleteParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    if (!db.getMemory(p.id)) {
      return {
        content: [{ type: 'text', text: `未找到 id 为 ${p.id} 的记忆条目，可能已被删除。` }],
        details: { id: p.id }
      }
    }
    try {
      db.deleteMemory(p.id)
      log.info('删除记忆', { id: p.id })
      return { content: [{ type: 'text', text: `已删除记忆条目 ${p.id}` }], details: { id: p.id } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('删除记忆失败', { error: msg })
      return {
        content: [{ type: 'text', text: `删除记忆失败：${msg}` }],
        details: { id: p.id }
      }
    }
  }
}
