import { IpcService } from 'electron-ipc-service'
import { db } from '../database'
import {
  setConfigApiKey,
  clearConfigApiKey,
  registerModelConfig,
  unregisterModelConfig,
  ensureAllModelConfigsRegistered,
  listPresetProviders,
  listPresetModels,
  fetchPresetModelsOnline,
  getDecryptedApiKey,
  toSummary,
  toCreateParams,
  toUpdateParams,
  testModelConfig as runTestModelConfig,
  type ModelConfigSummary,
  type CreateModelConfigInput,
  type UpdateModelConfigInput,
  type PresetProviderInfo,
  type PresetModelInfo
} from './model-config'
import { getModelsInstance } from './models'
import { createLogger } from '../utils/log'
import { rendererClient } from '../service/render-client'

const log = createLogger('modelConfig')

/**
 * 模型配置服务：模型配置的增删改查 / API key 加密存取 / 连通性测试 / 预置服务商与模型列表。
 * 与 AgentService 分离，避免配置管理与对话生命周期耦合在同一类中。
 * 所有变更在 main 进程同步注册/注销运行时 provider（registerModelConfig / unregisterModelConfig）。
 */
export class ModelConfigService extends IpcService {
  static override readonly namespace = 'modelConfig'

  /** 全部已添加的模型配置（脱敏，无加密 key）。hasApiKey 单独批量查询。 */
  listModelConfigs(): ModelConfigSummary[] {
    ensureAllModelConfigsRegistered(getModelsInstance())
    const configs = db.listModelConfigs()
    const hasKey = new Set(db.listModelConfigHasKeyIds())
    return configs.map((c) => ({ ...toSummary(c), hasApiKey: hasKey.has(c.id) }))
  }

  /** 创建一条模型配置并注册到运行时。apiKey 非空时加密存入。 */
  createModelConfig(input: CreateModelConfigInput, apiKey?: string): ModelConfigSummary {
    ensureAllModelConfigsRegistered(getModelsInstance())
    const config = db.createModelConfig(toCreateParams(input))
    if (apiKey && apiKey.trim()) setConfigApiKey(config.id, apiKey.trim())
    registerModelConfig(getModelsInstance(), config)
    log.info('创建模型配置', {
      configId: config.id,
      displayName: input.displayName,
      modelId: input.modelId,
      source: input.source,
      hasApiKey: !!apiKey?.trim()
    })
    // 广播到全部窗口：首次启动在设置窗口添加模型后，聊天窗口立即刷新（hasModel 生效）。
    rendererClient.modelConfigSync.changed()
    return toSummary(db.getModelConfig(config.id)!)
  }

  /** 更新一条模型配置并重新注册。apiKey: string=覆盖，null=清除，undefined=不动。 */
  updateModelConfig(id: string, patch: UpdateModelConfigInput): ModelConfigSummary {
    ensureAllModelConfigsRegistered(getModelsInstance())
    db.updateModelConfig(id, toUpdateParams(patch))
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null) clearConfigApiKey(id)
      else if (patch.apiKey.trim()) setConfigApiKey(id, patch.apiKey.trim())
    }
    const fresh = db.getModelConfig(id)!
    unregisterModelConfig(getModelsInstance(), id)
    registerModelConfig(getModelsInstance(), fresh)
    log.info('更新模型配置', {
      configId: id,
      displayName: fresh.displayName,
      modelId: fresh.modelId,
      apiKeyAction:
        patch.apiKey === undefined ? 'unchanged' : patch.apiKey === null ? 'cleared' : 'updated'
    })
    rendererClient.modelConfigSync.changed()
    return toSummary(fresh)
  }

  /** 删除一条模型配置并从运行时注销。 */
  deleteModelConfig(id: string): void {
    ensureAllModelConfigsRegistered(getModelsInstance())
    const config = db.getModelConfig(id)
    unregisterModelConfig(getModelsInstance(), id)
    db.deleteModelConfig(id)
    log.info('删除模型配置', { configId: id, displayName: config?.displayName })
    rendererClient.modelConfigSync.changed()
  }

  /** 测试某模型配置的连通性（收到首个非 error 事件即判成功，8s 超时）。 */
  async testModelConfig(id: string): Promise<{ ok: boolean; error?: string }> {
    ensureAllModelConfigsRegistered(getModelsInstance())
    return runTestModelConfig(getModelsInstance(), id)
  }

  /** 预置服务商列表（AddModelDialog 服务商选择器用）。 */
  listPresetProviders(): PresetProviderInfo[] {
    return listPresetProviders()
  }

  /** 某预置服务商的模型列表（选服务商后列模型用）。 */
  listPresetModels(providerId: string): PresetModelInfo[] {
    return listPresetModels(providerId)
  }

  /** 从服务商 GET /models 在线拉取模型（解决 catalog 滞后）。apiKey 仅透传，不落库。 */
  async listPresetModelsOnline(providerId: string, apiKey: string): Promise<PresetModelInfo[]> {
    return fetchPresetModelsOnline(providerId, apiKey)
  }

  /** 用某配置已存储的 key 在线拉取模型（编辑模式自动回显用）。key 仅在内存读取，不落库。 */
  async listPresetModelsOnlineById(configId: string): Promise<PresetModelInfo[]> {
    const config = db.getModelConfig(configId)
    if (!config) throw new Error('模型配置不存在')
    if (config.source !== 'preset' || !config.presetProvider) {
      throw new Error('该配置不是预置服务商模型')
    }
    let apiKey: string
    try {
      apiKey = getDecryptedApiKey(configId)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : '无法读取已存储的 API Key')
    }
    return fetchPresetModelsOnline(config.presetProvider, apiKey)
  }
}
