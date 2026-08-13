import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { mainClient } from '../utils/main-client'
import type {
  ModelConfigSummary,
  CreateModelConfigInput,
  UpdateModelConfigInput,
  PresetProviderInfo,
  PresetModelInfo,
  ModelKey
} from '@main/agent/types'
import { SETTING_DEFAULT_MODEL, formatModelKey, parseModelKey } from '@main/agent/types'

/**
 * 模型配置状态：管理用户添加的 model_configs + 预置服务商元数据 + 「上次使用模型」。
 *
 * config 的加密 key 永远不进入渲染进程——renderer 只接触 ModelConfigSummary（脱敏）。
 * 增删改经 mainClient.modelConfig.* IPC，main 进程同步注册/注销运行时 provider。
 *
 * settings.defaultModel 语义从「全局默认」改为「上次使用模型」：新建会话沿用此项；
 * 无上次使用时不做「首个 config」自动回退，模型必须由用户显式选择。
 * 每个会话的 session.model 独立记录所选模型。
 */
export const useModelConfigsStore = defineStore('modelConfigs', () => {
  const configs = ref<ModelConfigSummary[]>([])
  const loading = ref(false)
  const presetProviders = ref<PresetProviderInfo[]>([])
  /** 上次使用的模型（读 settings.defaultModel）。新建会话沿用。 */
  const lastUsedModel = ref<ModelKey | null>(null)

  /** 加载全部已添加模型配置。 */
  async function load(): Promise<void> {
    loading.value = true
    try {
      configs.value = await mainClient.modelConfig.listModelConfigs()
    } finally {
      loading.value = false
    }
  }

  /** 加载预置服务商列表（AddModelDialog 用）。 */
  async function loadPresetProviders(): Promise<void> {
    presetProviders.value = await mainClient.modelConfig.listPresetProviders()
  }

  /** 从服务商 GET /models 在线拉取模型（模型列表唯一来源，全量替换内置 catalog）。 */
  async function listPresetModelsOnline(
    providerId: string,
    apiKey: string
  ): Promise<PresetModelInfo[]> {
    return mainClient.modelConfig.listPresetModelsOnline(providerId, apiKey)
  }

  /** 用某配置已存储的 key 在线拉取模型（编辑模式自动回显用）。 */
  async function listPresetModelsOnlineById(configId: string): Promise<PresetModelInfo[]> {
    return mainClient.modelConfig.listPresetModelsOnlineById(configId)
  }

  /** 创建模型配置。apiKey 非空时一并写入。返回新建 summary。 */
  async function create(
    input: CreateModelConfigInput,
    apiKey?: string
  ): Promise<ModelConfigSummary> {
    const summary = await mainClient.modelConfig.createModelConfig(input, apiKey)
    await load()
    return summary
  }

  /** 更新模型配置。apiKey: string=覆盖，null=清除，undefined=不动。 */
  async function update(id: string, patch: UpdateModelConfigInput): Promise<ModelConfigSummary> {
    const summary = await mainClient.modelConfig.updateModelConfig(id, patch)
    await load()
    return summary
  }

  /** 删除模型配置。 */
  async function remove(id: string): Promise<void> {
    await mainClient.modelConfig.deleteModelConfig(id)
    await load()
  }

  /** 测试某模型配置连通性。 */
  async function test(id: string): Promise<{ ok: boolean; error?: string }> {
    return mainClient.modelConfig.testModelConfig(id)
  }

  /** 加载「上次使用模型」。 */
  async function loadLastUsed(): Promise<void> {
    const raw = await mainClient.db.getSetting(SETTING_DEFAULT_MODEL)
    lastUsedModel.value = parseModelKey(raw as string | undefined)
  }

  /** 设置「上次使用模型」并写回 DB。 */
  async function setLastUsed(key: ModelKey): Promise<void> {
    await mainClient.db.setSetting(SETTING_DEFAULT_MODEL, formatModelKey(key))
    lastUsedModel.value = key
  }

  /** 是否已添加任一模型（启动引导用）。 */
  const hasModel = computed(() => configs.value.length > 0)

  /** 根据 ModelKey 查找对应 config summary。 */
  function findConfig(key: ModelKey | null): ModelConfigSummary | undefined {
    if (!key) return undefined
    return configs.value.find((c) => c.id === key.provider && c.modelId === key.id)
  }

  /**
   * 上次使用模型（若其配置仍存在）；无则返回 null。
   * 不做「首个 config」自动回退——模型必须由用户显式选择，新会话仅沿用上次使用。
   */
  function defaultModelKey(): ModelKey | null {
    if (lastUsedModel.value && findConfig(lastUsedModel.value)) return lastUsedModel.value
    return null
  }

  return {
    configs,
    loading,
    presetProviders,
    lastUsedModel,
    hasModel,
    load,
    loadPresetProviders,
    listPresetModelsOnline,
    listPresetModelsOnlineById,
    create,
    update,
    remove,
    test,
    loadLastUsed,
    setLastUsed,
    findConfig,
    defaultModelKey
  }
})
