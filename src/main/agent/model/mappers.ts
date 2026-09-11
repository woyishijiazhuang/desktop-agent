import type {
  ApiFormat,
  CreateModelConfigParams,
  ModelConfig,
  ModelConfigSource,
  ModelPricing,
  UpdateModelConfigParams
} from '../../database'

/**
 * 脱敏的模型配置（不含加密 key），所有跨进程序列化的 config 都用此形态。
 */
export interface ModelConfigSummary {
  id: string
  displayName: string
  source: ModelConfigSource
  presetProvider: string | null
  apiFormat: ApiFormat
  baseUrl: string | null
  modelId: string
  contextWindow: number
  maxTokens: number
  multimodal: boolean
  reasoning: boolean
  /** 自定义定价（null = 沿用 catalog / 0） */
  pricing: ModelPricing | null
  hasApiKey: boolean
  /** unix ms 时间戳（与 DB 统一格式）。 */
  createdAt: number
  updatedAt: number
}

/**
 * 创建模型配置的输入（renderer → main）。apiKey 单独传，不混在 config 字段里。
 */
export interface CreateModelConfigInput {
  displayName: string
  source: ModelConfigSource
  presetProvider?: string | null
  apiFormat: ApiFormat
  baseUrl?: string | null
  modelId: string
  contextWindow: number
  maxTokens: number
  multimodal: boolean
  reasoning: boolean
  /** 自定义定价（null = 沿用 catalog / 0） */
  pricing?: ModelPricing | null
  apiKey?: string
}

/**
 * 更新模型配置的输入。apiKey: string=覆盖，null=清除，undefined=不动。
 */
export interface UpdateModelConfigInput {
  displayName?: string
  source?: ModelConfigSource
  presetProvider?: string | null
  apiFormat?: ApiFormat
  baseUrl?: string | null
  modelId?: string
  contextWindow?: number
  maxTokens?: number
  multimodal?: boolean
  reasoning?: boolean
  /** null = 清除（回退 catalog/0），undefined = 不动 */
  pricing?: ModelPricing | null
  apiKey?: string | null
}

export function toSummary(config: ModelConfig): ModelConfigSummary {
  return {
    id: config.id,
    displayName: config.displayName,
    source: config.source,
    presetProvider: config.presetProvider,
    apiFormat: config.apiFormat,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    multimodal: config.multimodal,
    reasoning: config.reasoning,
    pricing: config.pricing,
    hasApiKey: config.apiKeyEncrypted !== null,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  }
}

export function toCreateParams(input: CreateModelConfigInput): CreateModelConfigParams {
  return {
    displayName: input.displayName,
    source: input.source,
    presetProvider: input.presetProvider ?? null,
    apiFormat: input.apiFormat,
    baseUrl: input.baseUrl ?? null,
    modelId: input.modelId,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    multimodal: input.multimodal,
    reasoning: input.reasoning,
    pricing: input.pricing ?? null,
    apiKeyEncrypted: undefined
  }
}

/**
 * 把 UpdateModelConfigInput 映射为 DB 层 UpdateModelConfigParams。
 * apiKey 不在此处理（由 agent-service 走 setConfigApiKey/clearConfigApiKey）。
 */
export function toUpdateParams(input: UpdateModelConfigInput): UpdateModelConfigParams {
  const params: UpdateModelConfigParams = {}
  if (input.displayName !== undefined) params.displayName = input.displayName
  if (input.source !== undefined) params.source = input.source
  if (input.presetProvider !== undefined) params.presetProvider = input.presetProvider
  if (input.apiFormat !== undefined) params.apiFormat = input.apiFormat
  if (input.baseUrl !== undefined) params.baseUrl = input.baseUrl
  if (input.modelId !== undefined) params.modelId = input.modelId
  if (input.contextWindow !== undefined) params.contextWindow = input.contextWindow
  if (input.maxTokens !== undefined) params.maxTokens = input.maxTokens
  if (input.multimodal !== undefined) params.multimodal = input.multimodal
  if (input.reasoning !== undefined) params.reasoning = input.reasoning
  if (input.pricing !== undefined) params.pricing = input.pricing
  return params
}
