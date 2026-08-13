import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import type { Model, Api, MutableModels, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { db } from '../../database'
import type { ApiFormat, ModelConfig, ModelPricing } from '../../database'
import { createLogger } from '../../utils/log'
import { findBuiltinModel } from './preset-catalog'

const log = createLogger('modelConfig')

// ==================== api 工厂 ====================

function apiFactory(format: ApiFormat): ProviderStreams {
  if (format === 'anthropic-messages') return anthropicMessagesApi()
  return openAICompletionsApi()
}

// ==================== buildModel ====================

function buildCustomModel(config: ModelConfig): Model<Api> {
  const input: ('text' | 'image')[] = config.multimodal ? ['text', 'image'] : ['text']
  return {
    id: config.modelId,
    name: config.displayName,
    api: config.apiFormat,
    provider: config.id,
    baseUrl: config.baseUrl ?? '',
    reasoning: config.reasoning,
    input,
    cost: config.pricing
      ? baseCost(config.pricing)
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens
  }
}

/** 自定义定价的基准价（平时价），注入 pi-ai Model.cost 供其内部计算一致。 */
function baseCost(pricing: ModelPricing): Model<Api>['cost'] {
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead,
    cacheWrite: pricing.cacheWrite
  }
}

/**
 * 把一条 ModelConfig 构造为 pi-ai 的 Model<Api>。
 * - preset：用 builtin provider 的 catalog 模型作骨架（保留 cost/compat/thinkingLevelMap），
 *   覆盖 id/provider/baseUrl/contextWindow/maxTokens/input/name。自定义 model_id 不在 catalog
 *   时取该 provider 首个模型作骨架。
 * - custom：手动构造，cost 全 0，不设 compat（openai-completions 从 baseUrl auto-detect）。
 */
export function buildModel(config: ModelConfig): Model<Api> {
  const input: ('text' | 'image')[] = config.multimodal ? ['text', 'image'] : ['text']

  if (config.source === 'preset' && config.presetProvider) {
    const skeleton = findBuiltinModel(config.presetProvider, config.modelId)
    if (skeleton) {
      return {
        ...skeleton,
        id: config.modelId,
        name: config.displayName,
        provider: config.id,
        baseUrl: config.baseUrl ?? skeleton.baseUrl,
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        input,
        api: skeleton.api,
        // 自定义定价时以基准价覆盖 catalog 价（分时段倍率在落库时计算）。
        cost: config.pricing ? baseCost(config.pricing) : skeleton.cost
      }
    }
  }
  return buildCustomModel(config)
}

// ==================== 注册 / 注销 ====================

/**
 * 把一条 config 注册为 pi-ai provider（config.id 同时作 provider id）。
 * auth 用 envApiKeyAuth 占位（合法 ProviderAuth 即可）；请求时由 Agent 的 getApiKey
 * 回调注入 options.apiKey，与现有 builtin 流程一致。
 */
export function registerModelConfig(models: MutableModels, config: ModelConfig): void {
  models.setProvider(
    createProvider({
      id: config.id,
      name: config.displayName,
      baseUrl: config.baseUrl ?? undefined,
      auth: { apiKey: envApiKeyAuth(config.displayName, []) },
      models: [buildModel(config)],
      api: apiFactory(config.apiFormat)
    })
  )
  log.debug('注册模型 provider', {
    providerId: config.id,
    modelId: config.modelId,
    displayName: config.displayName,
    apiFormat: config.apiFormat
  })
}

/** 注册 DB 中全部 config。 */
export function registerAllModelConfigs(models: MutableModels): void {
  for (const config of db.listModelConfigs()) {
    registerModelConfig(models, config)
  }
}

/**
 * 惰性注册守卫：首次调用时把 DB 中全部 config 注册进运行时 Models 集合。
 * 同步、幂等（模块级标志，进程内只执行一次）；AgentService / ModelConfigService
 * 在所有读模型、列表的入口调用，确保集合已填充。后续单个 config 的增删改
 * 走 registerModelConfig / unregisterModelConfig 单独维护。
 */
let _configsRegistered = false
export function ensureAllModelConfigsRegistered(models: MutableModels): void {
  if (_configsRegistered) return
  registerAllModelConfigs(models)
  _configsRegistered = true
}

/** 注销某 config 对应的 provider。 */
export function unregisterModelConfig(models: MutableModels, id: string): void {
  models.deleteProvider(id)
  log.debug('注销模型 provider', { providerId: id })
}
