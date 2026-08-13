/** 模型配置来源：预置服务商 / 完全自定义 */
export type ModelConfigSource = 'preset' | 'custom'

/** 支持的 API 格式（与 pi-ai 的 api 工厂对应） */
export type ApiFormat = 'openai-completions' | 'anthropic-messages'

/**
 * 高峰定价时段（分时段定价用）。
 * startMinutes/endMinutes 为本地时间分钟（0-1439），跨午夜时 start > end。
 */
export interface ModelPeakPeriod {
  /** 时段起始（本地时间分钟，0-1439） */
  startMinutes: number
  /** 时段结束（本地时间分钟，0-1439） */
  endMinutes: number
  /** 高峰倍率：命中时段时价格 = 基准价 × multiplier（如 2 = 翻倍） */
  multiplier: number
}

/**
 * 模型定价（自定义）：基准价（平时价）+ 高峰时段。
 * 价格单位：人民币（¥）/ 百万 tokens。
 * 落库成本按消息时间戳命中时段选择倍率；pricing 为 null 时沿用默认 0（不统计消费）。
 */
export interface ModelPricing {
  /** 基准输入价（¥/M tokens） */
  input: number
  /** 基准输出价（¥/M tokens） */
  output: number
  /** 基准缓存命中价（¥/M tokens） */
  cacheRead: number
  /** 基准缓存写入价（¥/M tokens） */
  cacheWrite: number
  /** 高峰时段列表（空数组 = 不分时段） */
  peakPeriods: ModelPeakPeriod[]
}

/**
 * 模型配置实体：每行 = 用户添加的一个模型 endpoint。
 * - source='preset' 时 presetProvider 为 builtin provider id，baseUrl 可选覆盖。
 * - source='custom' 时 baseUrl 必填，presetProvider 为 null。
 * - apiKeyEncrypted 为 safeStorage 加密后的 BLOB，null 表示未配置 key。
 */
export interface ModelConfig {
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
  /** 自定义定价（null = 沿用 catalog / 0）。序列化为 JSON 存 pricing 列。 */
  pricing: ModelPricing | null
  /** safeStorage.encryptString 输出，DB 存 BLOB，读出为 Uint8Array；null = 未配置 */
  apiKeyEncrypted: Uint8Array | null
  /** unix ms 时间戳（与 sessions/messages 一致）。 */
  createdAt: number
  updatedAt: number
}

export interface CreateModelConfigParams {
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
  apiKeyEncrypted?: Uint8Array | null
}

export interface UpdateModelConfigParams {
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
  /** null = 清除（回退 catalog/0），undefined = 不修改 */
  pricing?: ModelPricing | null
  /** null = 清除，undefined = 不修改，Uint8Array = 覆盖 */
  apiKeyEncrypted?: Uint8Array | null
}

/** 数据库行类型（内部）：model_configs 表 */
export interface ModelConfigRow {
  id: string
  display_name: string
  source: string
  preset_provider: string | null
  api_format: string
  base_url: string | null
  model_id: string
  context_window: number
  max_tokens: number
  multimodal: number
  reasoning: number
  /** pricing 列：JSON 字符串或 null */
  pricing: string | null
  api_key_encrypted: Uint8Array | null
  created_at: number
  updated_at: number
}
