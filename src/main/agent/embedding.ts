import { safeStorage } from 'electron'
import { db } from '../database'
import { getDecryptedApiKey } from './model-config'
import { findBuiltinModel } from './model-config/preset-catalog'
import { SETTING_KB_EMBEDDING_CONFIG } from './types'
import { createLogger } from '../utils/log'

const log = createLogger('embedding')

/** 单批嵌入的最大文本条数（多数 OpenAI 兼容端点有批量上限）。 */
const EMBED_BATCH_SIZE = 16
/** 请求超时（ms）。 */
const REQUEST_TIMEOUT = 30_000
/** 失败重试次数。 */
const MAX_RETRIES = 2
/** 重试基础退避（ms），按 1s、2s 递增。 */
const RETRY_BASE_DELAY = 1000

/**
 * 知识库 embedding 配置（settings 存储形态，JSON 字符串）。
 * - source='model'：复用已添加模型配置（configId 指向 model_configs.id），其 baseUrl/modelId/key 即嵌入端点。
 * - source='custom'：知识库专属自定义配置，key 经 safeStorage 加密后 base64 存入。
 * 很多对话模型同样提供嵌入接口，故不再限定「嵌入用途」的模型类型。
 */
export interface KbEmbeddingSettings {
  source: 'model' | 'custom'
  /** source='model'：model_configs.id */
  configId?: string
  /** source='custom'：Base URL */
  baseUrl?: string
  /** source='custom'：模型 ID */
  modelId?: string
  /** source='custom'：safeStorage 加密后的 API key（base64），空 = 未配置 */
  apiKeyEncrypted?: string
}

/** 解析后的嵌入调用配置（统一形态，供 embedTexts 与成本计算使用）。 */
export interface ResolvedEmbedding {
  baseUrl: string
  modelId: string
  apiKey: string
  /** 每百万 token 输入价（model 模式取 config 自定义定价，未配置计 0；custom 模式计 0）。 */
  inputPricePerM: number
  /** model 模式为关联的 model_configs.id；custom 模式为 'custom'（成本日志归属）。 */
  configId: string
}

/**
 * 解析知识库当前 embedding 配置。未配置 / 配置不完整时返回 null（检索退化为关键词兜底）。
 * - model 模式：读取关联模型配置的 baseUrl/modelId 与其加密 key。
 * - custom 模式：读取设置内加密 key。
 */
export function resolveKbEmbedding(): ResolvedEmbedding | null {
  const raw = db.getSetting<string>(SETTING_KB_EMBEDDING_CONFIG)
  if (!raw) return null
  let s: KbEmbeddingSettings
  try {
    s = JSON.parse(raw) as KbEmbeddingSettings
  } catch {
    return null
  }
  if (s.source === 'model' && s.configId) {
    const config = db.getModelConfig(s.configId)
    if (!config) return null
    // 预置（preset）模型的 base_url 在 DB 中为 NULL，真实地址来自服务商 catalog（与
    // preset-catalog 在线拉取/注册逻辑一致），此处回退查找，避免「缺少 Base URL」误报。
    const baseUrl =
      config.baseUrl ??
      (config.presetProvider
        ? findBuiltinModel(config.presetProvider, config.modelId)?.baseUrl
        : null)
    if (!baseUrl) return null
    // 本地无鉴权端点（如 Ollama）未配 key 时允许空，请求不带 Authorization 头。
    let apiKey = ''
    try {
      apiKey = getDecryptedApiKey(s.configId)
    } catch {
      // 未配置 key：视为无鉴权本地端点
    }
    return {
      baseUrl,
      modelId: config.modelId,
      apiKey,
      inputPricePerM: config.pricing?.input ?? 0,
      configId: config.id
    }
  }
  if (s.source === 'custom' && s.baseUrl && s.modelId) {
    // custom 模式 key 可缺省（本地端点如 Ollama 无需鉴权）。
    let apiKey = ''
    if (s.apiKeyEncrypted) {
      try {
        apiKey = decryptKbEmbeddingKey(s.apiKeyEncrypted)
      } catch {
        return null
      }
    }
    return {
      baseUrl: s.baseUrl,
      modelId: s.modelId,
      apiKey,
      inputPricePerM: 0,
      configId: 'custom'
    }
  }
  return null
}

/** 解密 custom 模式存储的 API key（base64 → safeStorage 解密）。 */
export function decryptKbEmbeddingKey(encryptedB64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage 不可用），无法解密 API key')
  }
  return safeStorage.decryptString(Buffer.from(encryptedB64, 'base64'))
}

/** 加密并写入 custom 模式的 API key（base64 存入 settings JSON）。无 key 时返回 undefined。 */
export function encryptKbEmbeddingKey(key: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage 不可用），无法加密 API key')
  }
  return safeStorage.encryptString(key).toString('base64')
}

/** 生成知识块 embedding_model 标识（baseUrl|modelId），用于向量失效判定。 */
export function embeddingModelKey(input: { baseUrl: string; modelId: string }): string {
  return `${input.baseUrl}|${input.modelId}`
}

/** 嵌入成本 = tokens / 1e6 × 输入单价（$/M tokens）。 */
export function embeddingCost(tokens: number, inputPricePerM: number): number {
  return (tokens / 1_000_000) * inputPricePerM
}

/** 嵌入调用结果：向量 + 本次 token 用量。 */
export interface EmbeddingResult {
  vectors: Float32Array[]
  /** 本次调用消耗的 prompt tokens */
  tokens: number
}

/**
 * 批量文本向量化：OpenAI 兼容 /v1/embeddings。
 * 不依赖 pi-ai（其无 embedding API），直接 fetch；base_url 尾斜杠自动归一。
 * 失败重试 MAX_RETRIES 次（指数退避），全部失败抛错。
 */
export async function embedTexts(
  texts: string[],
  input: { baseUrl: string; modelId: string; apiKey: string }
): Promise<EmbeddingResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0 }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('embedding 配置缺少 Base URL')

  const vectors: Float32Array[] = []
  let tokens = 0
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    const res = await requestBatch(baseUrl, input.apiKey, input.modelId, batch)
    vectors.push(...res.vectors)
    tokens += res.tokens
  }
  log.debug('嵌入完成', { model: input.modelId, texts: texts.length, tokens })
  return { vectors, tokens }
}

/** 构造请求头：本地无鉴权端点（如 Ollama）apiKey 为空时不带 Authorization。 */
function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/** 单批请求（含重试）。 */
async function requestBatch(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  batch: string[]
): Promise<{ vectors: Float32Array[]; tokens: number }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY * 2 ** (attempt - 1)))
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
      try {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: buildHeaders(apiKey),
          // 不传 encoding_format：多数端点默认返回 float 数组，且本地端点（如 Ollama）不支持该参数
          body: JSON.stringify({ model: modelId, input: batch }),
          signal: controller.signal
        })
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200)
          // 404/405 常见于所选模型只提供对话接口而无 /embeddings 端点（如 DeepSeek），给出可读提示。
          const hint =
            res.status === 404 || res.status === 405
              ? '（该模型可能不支持嵌入接口，请换用支持 embedding 的模型或使用自定义配置）'
              : ''
          throw new Error(`嵌入请求失败：HTTP ${res.status}${body ? `（${body}）` : ''}${hint}`)
        }
        const json = (await res.json()) as {
          data: { embedding: number[] }[]
          usage?: { prompt_tokens?: number }
        }
        const vectors = json.data.map((d) => Float32Array.from(d.embedding))
        return { vectors, tokens: json.usage?.prompt_tokens ?? 0 }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      lastError = err
      log.warn('嵌入请求失败，准备重试', { attempt, model: modelId, error: err })
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
