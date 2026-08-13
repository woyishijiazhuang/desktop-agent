import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../utils/log'
import type {
  ApiFormat,
  McpServerRow,
  Message,
  MessageMetadata,
  MessageRow,
  ModelConfig,
  ModelConfigRow,
  ModelConfigSource,
  ModelPricing,
  Session,
  SessionRow,
  SessionStatus
} from './types'

const log = createLogger('db')

/** 包裹事务，失败自动回滚 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 忽略 rollback 本身的错误
    }
    log.error('事务回滚', { error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

// -------- 行 → 对象映射 --------

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    status: row.status as SessionStatus,
    model: row.model,
    thinkingLevel: row.thinking_level,
    systemPrompt: row.system_prompt,
    resolvedSystemPrompt: row.resolved_system_prompt,
    parentSessionId: row.parent_session_id,
    compressSummary: row.compress_summary,
    compressLastIndex: row.compress_last_index,
    compressVersion: row.compress_version,
    deletedAt: row.deleted_at,
    pinned: !!row.pinned,
    archived: !!row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at
  }
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: JSON.parse(row.content) as unknown,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    model: row.model,
    provider: row.provider,
    finishReason: row.finish_reason,
    timestamp: row.timestamp,
    metadata: row.metadata ? (JSON.parse(row.metadata) as MessageMetadata) : null
  }
}

/** omitKey=true（列表查询）时密文列未 SELECT，置 null 避免携带密钥。 */
export function toModelConfig(row: ModelConfigRow, omitKey = false): ModelConfig {
  return {
    id: row.id,
    displayName: row.display_name,
    source: row.source as ModelConfigSource,
    presetProvider: row.preset_provider,
    apiFormat: row.api_format as ApiFormat,
    baseUrl: row.base_url,
    modelId: row.model_id,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    multimodal: !!row.multimodal,
    reasoning: !!row.reasoning,
    pricing: row.pricing ? (JSON.parse(row.pricing) as ModelPricing) : null,
    apiKeyEncrypted: omitKey ? null : row.api_key_encrypted,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** DB 行 → 对象（布尔列 / JSON 列还原）。 */
export function toMcpServer(row: McpServerRow): McpServerRow {
  return { ...row, enabled: Boolean(row.enabled) }
}

/** 本地时区的 YYYY-MM-DD 键（用量按天分组 / 补 0 用）。 */
export function localDayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
