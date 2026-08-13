import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../utils/log'
import type {
  Memory,
  MemoryCategory,
  MemoryRow,
  MemorySource,
  CreateMemoryParams,
  UpdateMemoryParams
} from './types'
import { transaction } from './utils'
import { toFtsIndexText, toFtsMatchQuery } from './fts'

const log = createLogger('db')

const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['general', 'preference', 'fact', 'project']

/**
 * 记忆总量硬上限（cookie 语义：小而可控，保证「会话创建时全量注入」不撑大系统提示词）。
 * 写入（新增/更新）时超限即拒绝，提示用户先删除或精简。
 */
export const MEMORY_MAX_ITEMS = 30
export const MEMORY_MAX_TOTAL_CHARS = 3000
export const MEMORY_MAX_ENTRY_CHARS = 200

function isCategory(v: unknown): v is MemoryCategory {
  return typeof v === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(v)
}

function isSource(v: unknown): v is MemorySource {
  return v === 'manual' || v === 'auto'
}

/** 记忆域 API（index.ts 组装进 db 门面）。 */
export interface MemoryApi {
  listMemories(): Memory[]
  getMemory(id: string): Memory | undefined
  addMemory(params: CreateMemoryParams): Memory
  updateMemory(id: string, params: UpdateMemoryParams): Memory
  deleteMemory(id: string): void
  deleteAllMemories(): number
  /** 记忆管理页全文搜索（FTS5 预筛 + JS 精确过滤，与消息搜索同模式）。 */
  searchMemories(query: string, limit?: number): Memory[]
}

/** 记忆 CRUD + 全文搜索。 */
export function createMemoriesApi(db: DatabaseSync): MemoryApi {
  const api: MemoryApi = {
    listMemories(): Memory[] {
      const rows = db
        .prepare('SELECT * FROM memories ORDER BY updated_at DESC')
        .all() as unknown as MemoryRow[]
      return rows.map(toMemory)
    },

    getMemory(id: string): Memory | undefined {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as
        MemoryRow | undefined
      return row ? toMemory(row) : undefined
    },

    addMemory(params: CreateMemoryParams): Memory {
      const content = params.content.trim()
      if (!content) throw new Error('记忆内容不能为空')
      if (content.length > MEMORY_MAX_ENTRY_CHARS)
        throw new Error(`单条记忆不能超过 ${MEMORY_MAX_ENTRY_CHARS} 字`)
      const all = api.listMemories()
      if (all.length >= MEMORY_MAX_ITEMS)
        throw new Error(`记忆总量已达上限（${MEMORY_MAX_ITEMS} 条），请先删除或精简后再添加`)
      const totalChars = all.reduce((sum, m) => sum + m.content.length, 0)
      if (totalChars + content.length > MEMORY_MAX_TOTAL_CHARS)
        throw new Error(
          `记忆总字数已达上限（${MEMORY_MAX_TOTAL_CHARS} 字），请先删除或精简后再添加`
        )
      return transaction(db, () => {
        const id = randomUUID()
        const category = isCategory(params.category) ? params.category : 'general'
        const source = isSource(params.source) ? params.source : 'manual'
        const now = Date.now()
        db.prepare(
          `INSERT INTO memories (id, content, category, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, content, category, source, now, now)
        db.prepare('INSERT INTO memories_fts (rowid, text) VALUES (?, ?)').run(
          rowidKey(id),
          toFtsIndexText(content)
        )
        return api.getMemory(id)!
      })
    },

    updateMemory(id: string, params: UpdateMemoryParams): Memory {
      const existing = api.getMemory(id)
      if (!existing) throw new Error('记忆不存在')
      if (params.content !== undefined) {
        const content = params.content.trim()
        if (!content) throw new Error('记忆内容不能为空')
        if (content.length > MEMORY_MAX_ENTRY_CHARS)
          throw new Error(`单条记忆不能超过 ${MEMORY_MAX_ENTRY_CHARS} 字`)
        const totalChars = api.listMemories().reduce((sum, m) => sum + m.content.length, 0)
        if (totalChars - existing.content.length + content.length > MEMORY_MAX_TOTAL_CHARS)
          throw new Error(`记忆总字数已达上限（${MEMORY_MAX_TOTAL_CHARS} 字），请先精简后再更新`)
      }
      return transaction(db, () => {
        const sets: string[] = []
        const values: (string | number)[] = []
        if (params.content !== undefined) {
          const content = params.content.trim()
          if (!content) throw new Error('记忆内容不能为空')
          sets.push('content = ?')
          values.push(content)
        }
        if (params.category !== undefined) {
          if (!isCategory(params.category)) throw new Error(`非法的记忆分类: ${params.category}`)
          sets.push('category = ?')
          values.push(params.category)
        }
        if (sets.length === 0) return api.getMemory(id)!
        sets.push('updated_at = ?')
        values.push(Date.now())
        values.push(id)
        db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values)

        // 内容更新时同步重写全文搜索索引
        if (params.content !== undefined) {
          const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as
            | {
                content: string
              }
            | undefined
          db.prepare('UPDATE memories_fts SET text = ? WHERE rowid = ?').run(
            toFtsIndexText(row?.content ?? ''),
            rowidKey(id)
          )
        }
        return api.getMemory(id)!
      })
    },

    deleteMemory(id: string): void {
      transaction(db, () => {
        db.prepare('DELETE FROM memories WHERE id = ?').run(id)
        db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowidKey(id))
      })
      // FTS5 DELETE 是逻辑删除（tombstone），optimize 合并段、回收 _data/_idx 物理空间
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize')")
    },

    deleteAllMemories(): number {
      const count = transaction(db, () => {
        const before = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c
        db.prepare('DELETE FROM memories').run()
        db.prepare('DELETE FROM memories_fts').run()
        log.info('清空全部记忆', { count: before })
        return before
      })
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize')")
      return count
    },

    searchMemories(query: string, limit = 50): Memory[] {
      const trimmed = query.trim()
      if (!trimmed) return []
      const match = toFtsMatchQuery(trimmed)
      if (!match) return []
      // FTS5 rowid 是 id 的 FNV-1a 整数哈希（TEXT id 无法与 INTEGER rowid 直接 JOIN，
      // 亲和性规则下永不相等），故先取命中 rowid 集合，再在 JS 层按 rowidKey 还原比对。
      const rowids = (
        db
          .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?')
          .all(match) as unknown as {
          rowid: number
        }[]
      ).map((r) => r.rowid)
      if (rowids.length === 0) return []
      const rowidSet = new Set(rowids)
      // 记忆总量已被硬上限约束（条目数/总字数均受限），全量过滤开销可忽略。
      // FTS5 2-gram AND 匹配为粗筛，JS 层再做子串精确过滤（与消息搜索同模式）。
      return api
        .listMemories()
        .filter((m) => rowidSet.has(rowidKey(m.id)))
        .filter((m) => m.content.toLowerCase().includes(trimmed.toLowerCase()))
        .slice(0, limit)
    }
  }
  return api
}

// ==================== 行映射 / FTS rowid 辅助 ====================

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    category: isCategory(row.category) ? row.category : 'general',
    source: isSource(row.source) ? row.source : 'manual',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * FTS5 虚拟表的 rowid 必须为整数：memories.id 是 UUID 字符串，
 * 用 FNV-1a 哈希映射到 53 位正整数，保证同一 id 稳定映射、碰撞概率可忽略。
 */
function rowidKey(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
