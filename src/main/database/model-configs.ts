import type { DatabaseSync } from 'node:sqlite'
import type {
  CreateModelConfigParams,
  ModelConfig,
  ModelConfigRow,
  UpdateModelConfigParams
} from './types'
import { toModelConfig } from './utils'

/** 模型配置域 API（index.ts 组装进 db 门面）。 */
export interface ModelConfigsApi {
  createModelConfig(params: CreateModelConfigParams): ModelConfig
  listModelConfigs(): ModelConfig[]
  listModelConfigHasKeyIds(): string[]
  getModelConfig(id: string): ModelConfig | undefined
  updateModelConfig(id: string, params: UpdateModelConfigParams): ModelConfig
  deleteModelConfig(id: string): void
  getModelConfigApiKey(id: string): Uint8Array | undefined
  upsertModelConfigApiKey(id: string, encrypted: Uint8Array | null): void
}

/** 模型配置（model_configs CRUD）。 */
export function createModelConfigsApi(db: DatabaseSync): ModelConfigsApi {
  const api: ModelConfigsApi = {
    createModelConfig(params: CreateModelConfigParams): ModelConfig {
      const id = crypto.randomUUID()
      db.prepare(
        `INSERT INTO model_configs
          (id, display_name, source, preset_provider, api_format, base_url,
           model_id, context_window, max_tokens, multimodal, reasoning,
           pricing, api_key_encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        params.displayName,
        params.source,
        params.presetProvider ?? null,
        params.apiFormat,
        params.baseUrl ?? null,
        params.modelId,
        params.contextWindow,
        params.maxTokens,
        params.multimodal ? 1 : 0,
        params.reasoning ? 1 : 0,
        params.pricing ? JSON.stringify(params.pricing) : null,
        params.apiKeyEncrypted ?? null
      )
      return api.getModelConfig(id)!
    },

    /**
     * 列出全部模型配置（脱敏）：显式排除 api_key_encrypted 列，密文只在
     * getModelConfigApiKey 单独读取，避免每次列表查询都触碰密钥数据。
     */
    listModelConfigs(): ModelConfig[] {
      const rows = db
        .prepare(
          `SELECT id, display_name, source, preset_provider, api_format, base_url,
                  model_id, context_window, max_tokens, multimodal, reasoning,
                  pricing, created_at, updated_at
           FROM model_configs ORDER BY created_at ASC`
        )
        .all() as unknown as ModelConfigRow[]
      return rows.map((r) => toModelConfig(r, true))
    },

    /**
     * 批量查询已配置加密 key 的 config id（列表脱敏展示 hasApiKey 用）。
     * 与 listModelConfigs 配合：列表不读密文，key 存在性单独查。
     */
    listModelConfigHasKeyIds(): string[] {
      const rows = db
        .prepare('SELECT id FROM model_configs WHERE api_key_encrypted IS NOT NULL')
        .all() as { id: string }[]
      return rows.map((r) => r.id)
    },

    getModelConfig(id: string): ModelConfig | undefined {
      const row = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(id) as unknown as
        ModelConfigRow | undefined
      return row ? toModelConfig(row) : undefined
    },

    updateModelConfig(id: string, params: UpdateModelConfigParams): ModelConfig {
      const sets: string[] = []
      const values: (string | number | null | Uint8Array)[] = []
      if (params.displayName !== undefined) {
        sets.push('display_name = ?')
        values.push(params.displayName)
      }
      if (params.source !== undefined) {
        sets.push('source = ?')
        values.push(params.source)
      }
      if (params.presetProvider !== undefined) {
        sets.push('preset_provider = ?')
        values.push(params.presetProvider)
      }
      if (params.apiFormat !== undefined) {
        sets.push('api_format = ?')
        values.push(params.apiFormat)
      }
      if (params.baseUrl !== undefined) {
        sets.push('base_url = ?')
        values.push(params.baseUrl)
      }
      if (params.modelId !== undefined) {
        sets.push('model_id = ?')
        values.push(params.modelId)
      }
      if (params.contextWindow !== undefined) {
        sets.push('context_window = ?')
        values.push(params.contextWindow)
      }
      if (params.maxTokens !== undefined) {
        sets.push('max_tokens = ?')
        values.push(params.maxTokens)
      }
      if (params.multimodal !== undefined) {
        sets.push('multimodal = ?')
        values.push(params.multimodal ? 1 : 0)
      }
      if (params.reasoning !== undefined) {
        sets.push('reasoning = ?')
        values.push(params.reasoning ? 1 : 0)
      }
      if (params.pricing !== undefined) {
        sets.push('pricing = ?')
        values.push(params.pricing ? JSON.stringify(params.pricing) : null)
      }
      if (params.apiKeyEncrypted !== undefined) {
        sets.push('api_key_encrypted = ?')
        values.push(params.apiKeyEncrypted)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        values.push(Date.now())
        values.push(id)
        db.prepare(`UPDATE model_configs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      }
      return api.getModelConfig(id)!
    },

    deleteModelConfig(id: string): void {
      db.prepare('DELETE FROM model_configs WHERE id = ?').run(id)
    },

    /** 单独读取某 config 的加密 key 列。 */
    getModelConfigApiKey(id: string): Uint8Array | undefined {
      const row = db
        .prepare('SELECT api_key_encrypted FROM model_configs WHERE id = ?')
        .get(id) as unknown as { api_key_encrypted: Uint8Array | null } | undefined
      return row?.api_key_encrypted ?? undefined
    },

    /** 单独更新某 config 的加密 key 列（null = 清除）。 */
    upsertModelConfigApiKey(id: string, encrypted: Uint8Array | null): void {
      db.prepare(
        `UPDATE model_configs
         SET api_key_encrypted = ?, updated_at = ?
         WHERE id = ?`
      ).run(encrypted, Date.now(), id)
    }
  }
  return api
}
