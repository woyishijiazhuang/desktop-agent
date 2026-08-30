import type { DatabaseSync } from 'node:sqlite'
import type {
  CreateMessageParams,
  ListMessagesOptions,
  Message,
  MessageRow,
  MessageSearchHit,
  MessageSearchRow,
  UpdateMessageParams
} from './types'
import { toMessage, transaction } from './utils'
import { extractSearchableText, makeSnippet, toFtsIndexText, toFtsMatchQuery } from './fts'

/** 消息域 API（index.ts 组装进 db 门面）。 */
export interface MessageApi {
  createMessage(params: CreateMessageParams): Message
  getMessage(id: number): Message | undefined
  listMessagesBySession(sessionId: string, options?: ListMessagesOptions): Message[]
  updateMessage(id: number, params: UpdateMessageParams): Message
  deleteMessage(id: number): void
  deleteMessagesBySession(sessionId: string): void
  searchMessages(query: string, limit?: number): MessageSearchHit[]
}

/** 消息 CRUD + 全文搜索。压缩/分叉/上下文重建见会话域（./sessions）。 */
export function createMessagesApi(db: DatabaseSync): MessageApi {
  const api: MessageApi = {
    createMessage(params: CreateMessageParams): Message {
      return transaction(db, () => {
        const result = db
          .prepare(
            `INSERT INTO messages
              (session_id, role, content, tool_call_id, tool_name,
               model, provider, finish_reason,
               timestamp, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            params.sessionId,
            params.role,
            JSON.stringify(params.content ?? null),
            params.toolCallId ?? null,
            params.toolName ?? null,
            params.model ?? null,
            params.provider ?? null,
            params.finishReason ?? null,
            Date.now(),
            params.metadata ? JSON.stringify(params.metadata) : null
          ) as { lastInsertRowid: number | bigint }

        const messageId = Number(result.lastInsertRowid)

        // 同步全文搜索索引（FTS5 不自动跟随，须在同一事务内维护）
        const ftsText = toFtsIndexText(
          [extractSearchableText(params.content), params.toolName ?? ''].join('\n')
        )
        db.prepare('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)').run(messageId, ftsText)

        // 同步更新会话的 updated_at（用于会话列表排序）
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
          Date.now(),
          params.sessionId
        )

        return api.getMessage(messageId)!
      })
    },

    getMessage(id: number): Message | undefined {
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
        MessageRow | undefined
      return row ? toMessage(row) : undefined
    },

    listMessagesBySession(sessionId: string, options?: ListMessagesOptions): Message[] {
      const conditions = ['session_id = ?']
      const values: (string | number)[] = [sessionId]
      if (options?.afterId !== undefined) {
        conditions.push('id > ?')
        values.push(options.afterId)
      } else if (options?.beforeId !== undefined) {
        conditions.push('id < ?')
        values.push(options.beforeId)
      }
      // 分页模式（指定 limit）：按 id DESC 取最后 limit 条再反转，保证返回恒为 ASC；
      // 未指定 limit 维持原全量 ASC 行为（压缩增量加载 / 会话上下文重建）。
      const sql = options?.limit
        ? `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`
        : `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY id ASC`
      if (options?.limit) values.push(options.limit)
      const rows = db.prepare(sql).all(...values) as unknown as MessageRow[]
      const list = rows.map((r) => toMessage(r))
      return options?.limit ? list.reverse() : list
    },

    updateMessage(id: number, params: UpdateMessageParams): Message {
      return transaction(db, () => {
        const sets: string[] = []
        const values: (string | number | null)[] = []
        if (params.content !== undefined) {
          sets.push('content = ?')
          values.push(JSON.stringify(params.content))
        }
        if (params.finishReason !== undefined) {
          sets.push('finish_reason = ?')
          values.push(params.finishReason)
        }
        if (params.metadata !== undefined) {
          sets.push('metadata = ?')
          values.push(params.metadata === null ? null : JSON.stringify(params.metadata))
        }
        if (sets.length === 0) return api.getMessage(id)!
        values.push(id)
        db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values)

        // 内容更新时同步重写全文搜索索引
        if (params.content !== undefined) {
          const row = db.prepare('SELECT tool_name FROM messages WHERE id = ?').get(id) as
            { tool_name: string | null } | undefined
          const ftsText = toFtsIndexText(
            [extractSearchableText(params.content), row?.tool_name ?? ''].join('\n')
          )
          db.prepare('UPDATE messages_fts SET text = ? WHERE rowid = ?').run(ftsText, id)
        }

        return api.getMessage(id)!
      })
    },

    deleteMessage(id: number): void {
      transaction(db, () => {
        db.prepare('DELETE FROM messages WHERE id = ?').run(id)
        // 同步删除全文搜索索引行
        db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id)
      })
      // FTS5 DELETE 是逻辑删除（tombstone），optimize 合并段、回收 _data/_idx 物理空间
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
    },

    deleteMessagesBySession(sessionId: string): void {
      transaction(db, () => {
        // 先删索引（基于删除前的 messages 取 id），再删消息行
        db.prepare(
          'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)'
        ).run(sessionId)
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      })
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
    },

    /**
     * 全文搜索消息文本（用户问题 / 助手回复 / 思考过程 / 工具参数与结果）。
     * 预筛走 FTS5 索引（messages_fts，2-gram 化，见 toFtsIndexText），
     * JS 层再解析 content 提取真实文本精确过滤，并生成匹配片段。
     * 返回按消息 id 倒序（新消息优先）的命中列表。
     */
    searchMessages(query: string, limit = 50): MessageSearchHit[] {
      const trimmed = query.trim()
      if (!trimmed) return []
      const match = toFtsMatchQuery(trimmed)
      if (!match) return []
      const rows = db
        .prepare(
          `SELECT m.id, m.session_id, s.title AS session_title, m.role, m.content,
                  m.tool_name, m.timestamp
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_id
           WHERE s.deleted_at IS NULL AND messages_fts MATCH ?
           ORDER BY m.id DESC
           LIMIT ?`
        )
        .all(match, limit) as unknown as MessageSearchRow[]

      const needle = trimmed.toLowerCase()
      const hits: MessageSearchHit[] = []
      for (const row of rows) {
        let content: unknown
        try {
          content = JSON.parse(row.content)
        } catch {
          content = row.content
        }
        // 工具名单独拼接（toolResult 的 tool_name 落列，不在 content 里）
        const text = [extractSearchableText(content), row.tool_name ?? ''].join('\n')
        const idx = text.toLowerCase().indexOf(needle)
        if (idx < 0) continue
        hits.push({
          messageId: row.id,
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          role: row.role,
          timestamp: row.timestamp,
          snippet: makeSnippet(text, idx, trimmed.length)
        })
      }
      return hits
    }
  }
  return api
}
