import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../utils/log'
import type {
  Session,
  SessionRow,
  CreateSessionParams,
  UpdateSessionParams,
  ListSessionsOptions,
  ListSessionsResult
} from './types'
import { transaction, toSession } from './utils'

const log = createLogger('db')

/** 会话域 API（index.ts 组装进 db 门面）。 */
export interface SessionApi {
  createSession(params?: CreateSessionParams): Session
  getSession(id: string): Session | undefined
  listSessions(): Session[]
  /** 分页查询会话列表（游标分页；置顶会话仅在首页返回，后续页仅含非置顶切片）。 */
  listSessionsPaged(options?: ListSessionsOptions): ListSessionsResult
  /** 标题搜索（SQL LIKE 模糊匹配，分页模式下前端仅持有部分数据，须走后端查询）。 */
  searchSessions(query: string, limit?: number): Session[]
  listDeletedSessions(): Session[]
  updateSession(id: string, params: UpdateSessionParams): Session
  /** 清空全部会话的最终系统提示词快照（全局默认提示词变更后调用，使各会话下次重建时重新组装）。 */
  clearResolvedSystemPrompts(): void
  touchSession(id: string): Session
  deleteSession(id: string): void
  countTrashSessions(): number
  purgeTrash(): number
  purgeExpiredDeletedSessions(days: number): number
}

/** 会话 CRUD + 回收站清理。 */
export function createSessionsApi(db: DatabaseSync): SessionApi {
  const api: SessionApi = {
    createSession(params?: CreateSessionParams): Session {
      const id = crypto.randomUUID()
      db.prepare(
        `INSERT INTO sessions (id, title, model, thinking_level, system_prompt, parent_session_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        params?.title ?? '新会话',
        params?.model ?? null,
        params?.thinkingLevel ?? null,
        params?.systemPrompt ?? null,
        params?.parentSessionId ?? null
      )
      return api.getSession(id)!
    },

    getSession(id: string): Session | undefined {
      const row = db
        .prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL')
        .get(id) as unknown as SessionRow | undefined
      return row ? toSession(row) : undefined
    },

    /** 全部未删除会话，按置顶 → 最后用户活动时间倒序。 */
    listSessions(): Session[] {
      const rows = db
        .prepare(
          'SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY pinned DESC, last_active_at DESC'
        )
        .all() as unknown as SessionRow[]
      return rows.map((r) => toSession(r))
    },

    /**
     * 分页查询会话列表（游标分页）。
     * - 置顶会话始终全量返回且仅在首页（无游标）返回，后续页复用首页已加载的置顶项，避免重复
     * - 非置顶会话按 (last_active_at, id) 复合游标倒序分页
     * - 用 limit + 1 技巧判断 hasMore，避免额外 COUNT 查询
     */
    listSessionsPaged(options?: ListSessionsOptions): ListSessionsResult {
      const limit = options?.limit ?? 30
      const requestLimit = limit + 1

      const pinnedRows =
        options?.cursor === undefined
          ? (db
              .prepare(
                'SELECT * FROM sessions WHERE deleted_at IS NULL AND pinned = 1 ORDER BY last_active_at DESC, id DESC'
              )
              .all() as unknown as SessionRow[])
          : []

      const conditions = ['deleted_at IS NULL', 'pinned = 0']
      const values: (string | number)[] = []
      if (options?.cursor !== undefined && options?.cursorId) {
        // 复合游标：(last_active_at < cursor) OR (last_active_at = cursor AND id < cursorId)
        conditions.push('(last_active_at < ? OR (last_active_at = ? AND id < ?))')
        values.push(options.cursor, options.cursor, options.cursorId)
      }
      values.push(requestLimit)
      const normalRows = db
        .prepare(
          `SELECT * FROM sessions WHERE ${conditions.join(' AND ')}
           ORDER BY last_active_at DESC, id DESC LIMIT ?`
        )
        .all(...values) as unknown as SessionRow[]
      const hasMore = normalRows.length > limit
      const slicedRows = hasMore ? normalRows.slice(0, limit) : normalRows

      return {
        sessions: [...pinnedRows, ...slicedRows].map((r) => toSession(r)),
        hasMore
      }
    },

    /** 标题搜索（LIKE 模糊匹配，按最近活动倒序，默认最多 50 条）。 */
    searchSessions(query: string, limit = 50): Session[] {
      const rows = db
        .prepare(
          `SELECT * FROM sessions
           WHERE deleted_at IS NULL AND title LIKE ?
           ORDER BY last_active_at DESC, id DESC
           LIMIT ?`
        )
        .all(`%${query}%`, limit) as unknown as SessionRow[]
      return rows.map((r) => toSession(r))
    },

    /** 回收站中的会话（已软删除）。附件保留策略：软删期间文件保留，清空回收站/到期后清理。 */
    listDeletedSessions(): Session[] {
      const rows = db
        .prepare('SELECT * FROM sessions WHERE deleted_at IS NOT NULL')
        .all() as unknown as SessionRow[]
      return rows.map((r) => toSession(r))
    },

    updateSession(id: string, params: UpdateSessionParams): Session {
      const sets: string[] = []
      const values: (string | number | null)[] = []
      if (params.title !== undefined) {
        sets.push('title = ?')
        values.push(params.title)
      }
      if (params.status !== undefined) {
        sets.push('status = ?')
        values.push(params.status)
      }
      if (params.model !== undefined) {
        sets.push('model = ?')
        values.push(params.model)
      }
      if (params.thinkingLevel !== undefined) {
        sets.push('thinking_level = ?')
        values.push(params.thinkingLevel)
      }
      if (params.systemPrompt !== undefined) {
        sets.push('system_prompt = ?')
        values.push(params.systemPrompt)
        // 自定义提示词变更 → 已固化的最终提示词快照失效，下次构建重新组装
        //（避免 Agent 继续复用旧的固化提示词）。
        sets.push('resolved_system_prompt = ?')
        values.push(null)
      }
      if (params.resolvedSystemPrompt !== undefined) {
        sets.push('resolved_system_prompt = ?')
        values.push(params.resolvedSystemPrompt)
      }
      if (params.pinned !== undefined) {
        sets.push('pinned = ?')
        values.push(params.pinned ? 1 : 0)
      }
      if (params.archived !== undefined) {
        sets.push('archived = ?')
        values.push(params.archived ? 1 : 0)
      }
      // 用户主动操作：刷新排序键（置顶）。字段更新与 touch 解耦——标题自动生成等
      // 后台行为不 touch，避免流式/后台事件扰动会话列表排序。
      if (params.touch) {
        sets.push('last_active_at = ?')
        values.push(Date.now())
      }
      if (sets.length === 0) return api.getSession(id)!
      sets.push('updated_at = ?')
      values.push(Date.now())
      values.push(id)
      db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      return api.getSession(id)!
    },

    /**
     * 用户主动触碰会话（置顶会话列表）：仅刷新 last_active_at，不动业务字段。
     * 用于点击进入会话、发送消息等用户操作；后台流式/标题生成不调用。
     * 返回更新后的会话（renderer 据此同步列表排序）。
     */
    touchSession(id: string): Session {
      db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), id)
      return api.getSession(id)!
    },

    /** 清空全部会话的最终系统提示词快照（全局默认提示词变更后调用）。 */
    clearResolvedSystemPrompts(): void {
      db.prepare('UPDATE sessions SET resolved_system_prompt = NULL').run()
    },
    /**
     * 软删除会话：仅标记 deleted_at，数据进入回收站（仍可被手动清空/到期清理）。
     * 消息行保留，物理删除时由 ON DELETE CASCADE 一并清理。
     */
    deleteSession(id: string): void {
      db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
    },

    /** 回收站中的会话数量（已软删除、尚未物理删除）。 */
    countTrashSessions(): number {
      const row = db
        .prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE deleted_at IS NOT NULL')
        .get() as unknown as { cnt: number }
      return row.cnt
    },

    /** 物理删除全部软删除会话（清空回收站）。返回删除的会话数，消息由级联删除，FTS 索引先行清理。 */
    purgeTrash(): number {
      const count = transaction(db, () => {
        // messages 由 ON DELETE CASCADE 清除，FTS 索引无级联，须先删
        db.prepare(
          'DELETE FROM messages_fts WHERE rowid IN (SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.deleted_at IS NOT NULL)'
        ).run()
        const result = db.prepare('DELETE FROM sessions WHERE deleted_at IS NOT NULL').run() as {
          changes: number
        }
        return result.changes
      })
      // FTS5 DELETE 是逻辑删除（tombstone），optimize 合并段、回收 _data/_idx 物理空间
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
      return count
    },

    /**
     * 物理删除删除时间超过 days 天的软删除会话（到期清理，方案 B 兜底）。
     * 消息由 ON DELETE CASCADE 一并清理。
     */
    purgeExpiredDeletedSessions(days: number): number {
      return purgeSessionsBefore(db, Date.now() - days * 24 * 60 * 60 * 1000)
    }
  }
  return api
}

/** 物理删除删除时间早于 beforeMs（unix ms）的软删除会话。返回删除的会话数。 */
function purgeSessionsBefore(db: DatabaseSync, beforeMs: number): number {
  const count = transaction(db, () => {
    // 同上：级联删 messages 前先清 FTS 索引
    db.prepare(
      `DELETE FROM messages_fts WHERE rowid IN (
         SELECT m.id FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.deleted_at IS NOT NULL AND s.deleted_at < ?
       )`
    ).run(beforeMs)
    const result = db
      .prepare('DELETE FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .run(beforeMs) as { changes: number }
    if (result.changes > 0) {
      log.info('已清理过期软删除会话', {
        count: result.changes,
        before: new Date(beforeMs).toISOString()
      })
    }
    return result.changes
  })
  // FTS5 DELETE 是逻辑删除（tombstone），optimize 合并段、回收物理空间
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
  return count
}
