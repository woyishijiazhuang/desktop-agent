import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { createLogger } from '../utils/log'
import { initSchema } from './schema'
import { createSessionsApi } from './sessions'
import { createMessagesApi } from './messages'
import { createMemoriesApi } from './memory'
import { createModelConfigsApi } from './model-configs'
import { createMcpServersApi } from './mcp-servers'
import { createUsageApi } from './usage'
import { createSettingsApi } from './settings'
import { createKnowledgeApi } from './knowledge'
import { createWorkspacesApi } from './workspaces'

// 重新导出类型，保持既有 import 路径（如 '../database'）不变。
export * from './types'

// ==================== 数据库核心 ====================

/** 回收站保留期（天）：删除的会话超过该天数后，在应用启动时被物理清除。 */
export const DELETED_SESSION_RETENTION_DAYS = 30

const log = createLogger('db')

const dbPath = path.join(app.getPath('userData'), 'data.db')
const raw = new DatabaseSync(dbPath, {
  enableForeignKeyConstraints: true,
  timeout: 5000
})
// WAL 模式：读写并发不互锁（agent 落库与 UI 读取并行），并减少 fsync 次数。
raw.exec('PRAGMA journal_mode = WAL')
initSchema(raw)

// ==================== 工作区迁移 ====================
// 存量会话此前无 workdir 概念：读取旧全局设置 agent.workdir（无则 userData/work）回填全部空串会话，
// 并确保至少存在一个工作区行（默认工作区，供启动时开窗）。幂等：仅回填空串行、仅空表时建默认行。
// 旧设置项在 P3 替换解析链路时移除（见 agent/workdir.ts 的 resolveSessionWorkdir）。
function resolveDefaultWorkdir(): string {
  const row = raw.prepare("SELECT value FROM settings WHERE key = 'agent.workdir'").get() as
    { value: string } | undefined
  const dir = row ? (JSON.parse(row.value) as string) : path.join(app.getPath('userData'), 'work')
  mkdirSync(dir, { recursive: true })
  return dir
}

function defaultWorkspaceName(workdir: string): string {
  const parts = workdir.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last || workdir
}

/** 缺省工作区目录（createSession 未指定 workdir 时回退；迁移期读旧全局设置）。 */
export { resolveDefaultWorkdir }

{
  const legacyWorkdir = resolveDefaultWorkdir()
  const backfilled = raw
    .prepare("UPDATE sessions SET workdir = ? WHERE workdir = ''")
    .run(legacyWorkdir)
  const hasWorkspace = raw.prepare('SELECT 1 FROM workspaces LIMIT 1').get()
  if (!hasWorkspace) {
    raw
      .prepare(
        'INSERT INTO workspaces (workdir, name, last_opened_at, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(legacyWorkdir, defaultWorkspaceName(legacyWorkdir), Date.now(), Date.now())
  }
  // 旧全局设置已由 workspaces 表 + sessions.workdir 取代，直接移除（不保留兼容代码）
  raw.prepare("DELETE FROM settings WHERE key = 'agent.workdir'").run()
  if (backfilled.changes > 0 || !hasWorkspace) {
    log.info('工作区迁移完成', {
      workdir: legacyWorkdir,
      backfilledSessions: backfilled.changes
    })
  }
}

const messages = createMessagesApi(raw)
const sessions = createSessionsApi(raw, {
  getMessage: messages.getMessage,
  listMessagesBySession: messages.listMessagesBySession,
  resolveDefaultWorkdir
})

// 方案 B 兜底：应用启动时物理清理超过保留期（30 天）的回收站数据。
const purged = sessions.purgeExpiredDeletedSessions(DELETED_SESSION_RETENTION_DAYS)
log.info('数据库已打开', {
  path: dbPath,
  purgedExpiredSessions: purged
})

/** 数据库单例（按领域分组的 API 门面）。 */
export const db = {
  ...sessions,
  ...messages,
  ...createMemoriesApi(raw),
  ...createModelConfigsApi(raw),
  ...createMcpServersApi(raw),
  ...createUsageApi(raw),
  ...createSettingsApi(raw),
  ...createKnowledgeApi(raw),
  ...createWorkspacesApi(raw),

  getDbPath(): string {
    return raw.location() ?? ''
  },

  close(): void {
    raw.close()
  }
}
