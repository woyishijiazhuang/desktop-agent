import type { Provider } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ApiFormat, ModelPeakPeriod } from '../../database'

/** 预置服务商信息（AddModelDialog 的服务商选择器用） */
export interface PresetProviderInfo {
  id: string
  name: string
  getKeyUrl?: string
  /** 该服务商默认高峰定价时段（如 DeepSeek 峰谷），经 IPC 透传供对话框预填 */
  defaultPeakPeriods?: ModelPeakPeriod[]
}

/** catalog 模型基准价（$/M tokens，供定价默认值）。 */
export interface PresetModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 预置模型信息（选服务商后列模型用） */
export interface PresetModelInfo {
  id: string
  name: string
  api: ApiFormat
  contextWindow: number
  reasoning: boolean
  multimodal: boolean
  /** catalog 基准价（在线拉取的模型无此字段） */
  cost?: PresetModelCost
  /** 是否来自服务商 /models 在线拉取（非 catalog） */
  online?: boolean
}

/**
 * DeepSeek 官方峰谷定价默认高峰时段（北京时间）：上午 09:00-12:00、下午 14:00-18:00，
 * 高峰时段所有计费项翻倍（2026 年 V4 起生效）。
 * 仅在用户选择 deepseek 预置模型时作为默认预填，仍可在对话框中修改。
 */
export const DEEPSEEK_PEAK_PERIODS: ModelPeakPeriod[] = [
  { startMinutes: 9 * 60, endMinutes: 12 * 60, multiplier: 2 },
  { startMinutes: 14 * 60, endMinutes: 18 * 60, multiplier: 2 }
]

/**
 * DeepSeek 官方人民币基准价（¥/M tokens，平时价），按模型 id 覆盖 catalog 美元价预填。
 * 官方以人民币计价，catalog 为美元换算值（≈÷7.14），直接预填会导致金额错一位。
 * 分时段高峰翻倍仍由 DEEPSEEK_PEAK_PERIODS 提供。
 */
const DEEPSEEK_RMB_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'deepseek-v4-flash': { input: 1, output: 2, cacheRead: 0.02 },
  'deepseek-v4-pro': { input: 3, output: 6, cacheRead: 0.025 }
}

/** 预置服务商「获取 API Key」链接（按 builtin provider id） */
const PRESET_GET_KEY_URLS: Record<string, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai',
  openrouter: 'https://openrouter.ai/keys',
  fireworks: 'https://fireworks.ai/account/api-keys',
  together: 'https://api.together.xyz/settings/api-keys',
  cerebras: 'https://cloud.cerebras.ai',
  huggingface: 'https://huggingface.co/settings/tokens'
}

/** 预置选择器白名单：只列 api 属于这两种格式的 builtin provider / 模型 */
const PRESET_ALLOWED_APIS: ReadonlySet<ApiFormat> = new Set([
  'openai-completions',
  'anthropic-messages'
])

let _builtinProviders: Provider[] | null = null

/** 惰性缓存 builtinProviders()，避免每次重新构造。 */
function getBuiltinProviders(): Provider[] {
  if (!_builtinProviders) _builtinProviders = builtinProviders()
  return _builtinProviders
}

/** 列出可用的预置服务商（至少有一个白名单 api 模型）。 */
export function listPresetProviders(): PresetProviderInfo[] {
  return getBuiltinProviders()
    .filter((p) => p.getModels().some((m) => PRESET_ALLOWED_APIS.has(m.api as ApiFormat)))
    .map((p) => ({
      id: p.id,
      name: p.name,
      getKeyUrl: PRESET_GET_KEY_URLS[p.id],
      defaultPeakPeriods: p.id === 'deepseek' ? DEEPSEEK_PEAK_PERIODS : undefined
    }))
}

/** 列出某预置服务商下白名单 api 的模型。 */
export function listPresetModels(providerId: string): PresetModelInfo[] {
  const provider = getBuiltinProviders().find((p) => p.id === providerId)
  if (!provider) return []
  return provider
    .getModels()
    .filter((m) => PRESET_ALLOWED_APIS.has(m.api as ApiFormat))
    .map((m) => {
      const rmb = providerId === 'deepseek' ? DEEPSEEK_RMB_PRICING[m.id] : undefined
      return {
        id: m.id,
        name: m.name,
        api: m.api as ApiFormat,
        contextWindow: m.contextWindow,
        reasoning: m.reasoning,
        multimodal: m.input.includes('image'),
        // DeepSeek 用官方人民币价预填；其余沿用 catalog 价。
        cost: rmb
          ? { input: rmb.input, output: rmb.output, cacheRead: rmb.cacheRead, cacheWrite: 0 }
          : {
              input: m.cost.input,
              output: m.cost.output,
              cacheRead: m.cost.cacheRead,
              cacheWrite: m.cost.cacheWrite
            }
      }
    })
}

/** 供同层 buildModel 复用 builtin catalog（getModels 骨架）。 */
export function findBuiltinModel(
  providerId: string,
  modelId: string
): ReturnType<Provider['getModels']>[number] | undefined {
  const provider = getBuiltinProviders().find((p) => p.id === providerId)
  const catalog = provider?.getModels() ?? []
  return catalog.find((m) => m.id === modelId) ?? catalog[0]
}

/**
 * 从服务商 GET /models 在线拉取模型列表。
 * OpenAI 兼容端点与 Anthropic Messages 均支持（Anthropic 需 anthropic-version 头）。
 * 返回 /models 全量列表（不再过滤 catalog），作为模型列表的唯一来源：
 * 在线结果全量替换内置 catalog，metadata（上下文/多模态等）未知，由用户在高级配置中补充。
 */
export async function fetchPresetModelsOnline(
  providerId: string,
  apiKey: string
): Promise<PresetModelInfo[]> {
  const provider = getBuiltinProviders().find((p) => p.id === providerId)
  const models = provider?.getModels() ?? []
  if (!provider || models.length === 0) throw new Error('未知服务商')
  const api = models[0].api as ApiFormat
  const baseUrl = provider.baseUrl || models[0].baseUrl
  // Anthropic baseUrl 是根地址（https://api.anthropic.com），模型列表在 /v1/models；
  // OpenAI 兼容端点的 baseUrl 一般已含 /v1，直接拼 /models。
  const isAnthropic = api === 'anthropic-messages'
  const url = `${baseUrl.replace(/\/+$/, '')}${isAnthropic ? '/v1/models?limit=1000' : '/models'}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Anthropic /models 需要版本头（不带返回 400）
      ...(isAnthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey } : {})
    },
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const data = (await res.json()) as {
    data?: {
      id?: string
      display_name?: string
      max_input_tokens?: number | null
      capabilities?: {
        image_input?: { supported?: boolean }
        thinking?: { supported?: boolean }
      }
    }[]
  }
  return (data?.data ?? [])
    .map((d) => ({
      id: d?.id ?? '',
      name: d?.display_name ?? d?.id ?? '',
      // Anthropic beta Models 返回 capabilities（image_input/thinking）与 max_input_tokens；
      // OpenAI 兼容端点只有 id，无任何元数据，多模态/推理留待用户在高级配置中补充。
      multimodal: d?.capabilities?.image_input?.supported === true,
      reasoning: d?.capabilities?.thinking?.supported === true,
      contextWindow: d?.max_input_tokens ?? 0
    }))
    .filter((m) => !!m.id.trim())
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      api,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
      multimodal: m.multimodal,
      online: true
    }))
}
