import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
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

const sessions = createSessionsApi(raw)
const messages = createMessagesApi(raw, { getSession: sessions.getSession })

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

  getDbPath(): string {
    return raw.location() ?? ''
  },

  close(): void {
    raw.close()
  }
}
