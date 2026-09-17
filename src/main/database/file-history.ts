import type { DatabaseSync } from 'node:sqlite'

/** 文件变更状态：applied=已落盘可撤销；undone=已撤销；superseded=因整批回退被连带作废；
 *  skipped=未记录快照（二进制/超限/读取失败，undo_error 存原因）；failed=预留（写入失败不落行）。 */
export type FileChangeStatus = 'applied' | 'undone' | 'superseded' | 'failed' | 'skipped'

/** file_change_log 行：write_file / edit_file 每次成功落盘一条（供用户撤销）。 */
export interface FileChangeRow {
  id: number
  sessionId: string
  /** 关联 toolResult 消息（工具卡片按 toolCallId 查询撤销状态）。 */
  toolCallId: string | null
  toolName: string
  /** 绝对路径（写入时的原样）。 */
  path: string
  /** 操作前内容 sha256；null = 本次为新建文件。 */
  beforeHash: string | null
  /** 操作后内容 sha256（撤销前乐观锁校验基准）。 */
  afterHash: string
  bytes: number
  status: FileChangeStatus
  undoError: string | null
  createdAt: number
}

export interface InsertFileChangeParams {
  sessionId: string
  toolCallId: string
  toolName: string
  path: string
  beforeHash: string | null
  afterHash: string
  bytes: number
  status: FileChangeStatus
  undoError?: string | null
}

/** 文件变更历史域 API（index.ts 组装进 db 门面）。 */
export interface FileHistoryApi {
  insertFileChange(params: InsertFileChangeParams): number
  getFileChange(id: number): FileChangeRow | undefined
  listFileChangesBySession(sessionId: string): FileChangeRow[]
  updateFileChangeStatus(id: number, status: FileChangeStatus, undoError?: string | null): void
  /** 同 path 是否存在 id 更大且仍 applied 的记录（单条撤销的 superseded 检查，跨会话：文件全局共享）。 */
  hasAppliedFileChangeAfter(path: string, id: number): boolean
  /** 仍被撤销链引用的全部 before_hash（blob GC 存活集：含 undone/superseded 行——
   *  会话级回退的目标可能是已被单条撤销过的首条记录，只保 applied 会误删仍需的快照）。 */
  listReferencedBeforeHashes(): Set<string>
}

interface FileChangeDbRow {
  id: number
  session_id: string
  tool_call_id: string | null
  tool_name: string
  path: string
  before_hash: string | null
  after_hash: string
  bytes: number
  status: FileChangeStatus
  undo_error: string | null
  created_at: number
}

function toRow(r: FileChangeDbRow): FileChangeRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    path: r.path,
    beforeHash: r.before_hash,
    afterHash: r.after_hash,
    bytes: r.bytes,
    status: r.status,
    undoError: r.undo_error,
    createdAt: r.created_at
  }
}

/** 文件变更历史读写（表结构见 schema.ts 的 file_change_log，设计见 docs/file-undo-design.md）。 */
export function createFileHistoryApi(db: DatabaseSync): FileHistoryApi {
  return {
    insertFileChange(params) {
      const result = db
        .prepare(
          `INSERT INTO file_change_log
             (session_id, tool_call_id, tool_name, path, before_hash, after_hash, bytes, status, undo_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.sessionId,
          params.toolCallId,
          params.toolName,
          params.path,
          params.beforeHash,
          params.afterHash,
          params.bytes,
          params.status,
          params.undoError ?? null
        )
      return Number(result.lastInsertRowid)
    },

    getFileChange(id) {
      const row = db.prepare('SELECT * FROM file_change_log WHERE id = ?').get(id) as unknown as
        | FileChangeDbRow
        | undefined
      return row ? toRow(row) : undefined
    },

    listFileChangesBySession(sessionId) {
      const rows = db
        .prepare('SELECT * FROM file_change_log WHERE session_id = ? ORDER BY id')
        .all(sessionId) as unknown as FileChangeDbRow[]
      return rows.map(toRow)
    },

    updateFileChangeStatus(id, status, undoError) {
      db.prepare('UPDATE file_change_log SET status = ?, undo_error = ? WHERE id = ?').run(
        status,
        undoError ?? null,
        id
      )
    },

    hasAppliedFileChangeAfter(path, id) {
      const row = db
        .prepare(
          "SELECT 1 FROM file_change_log WHERE path = ? AND id > ? AND status = 'applied' LIMIT 1"
        )
        .get(path, id)
      return row !== undefined
    },

    listReferencedBeforeHashes() {
      const rows = db
        .prepare('SELECT DISTINCT before_hash FROM file_change_log WHERE before_hash IS NOT NULL')
        .all() as unknown as { before_hash: string }[]
      return new Set(rows.map((r) => r.before_hash))
    }
  }
}
