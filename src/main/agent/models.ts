import {
  createModels,
  type MutableModels,
  type Model,
  type Api,
  type Context,
  type AssistantMessage,
  type Usage
} from '@earendil-works/pi-ai'
import type { ModelKey } from './types'
import { getDecryptedApiKey } from './model-config'
import { extractMessageText } from '../utils/message-text'
import { createLogger } from '../utils/log'

const log = createLogger('models')

/**
 * 运行时 Models 集合单例：空集合，仅注册用户添加的 model_configs。
 * 不装 builtin，避免 1116+ 内置模型污染选择器。注册由 AgentService / ModelConfigService
 * 惰性调 ensureAllModelConfigsRegistered 完成（每个 config.id 同时作 pi-ai 的 provider id）。
 * API key 经 Agent 的 getApiKey 回调按 config.id 注入 streamSimple({apiKey})。
 */
let _models: MutableModels | null = null

export function getModelsInstance(): MutableModels {
  if (!_models) {
    _models = createModels()
  }
  return _models
}

/** 按 {provider, id} 解析具体 Model 实例。key 为 null 时返回 undefined。 */
export function resolveModel(key: ModelKey | null): Model<Api> | undefined {
  if (!key) return undefined
  return getModelsInstance().getModel(key.provider, key.id)
}

/** 一次性文本补全的完整结果：文本 + 调用用量（供调用方计入 token 统计）。 */
export interface CompleteTextResult {
  /** 最终 assistant 文本 */
  text: string
  /** 生成此响应的 provider（pi-ai provider id，即 model_configs.id） */
  provider: string
  /** 模型 id */
  model: string
  usage: Usage
  /** 调用完成时间（unix ms），用于成本计算与用量落库 */
  timestamp: number
}

/**
 * 一次性文本补全：用最小上下文跑一次 streamSimple，返回最终 assistant 文本。
 * 用于会话标题生成、压缩摘要等非流式辅助任务。
 * model 由调用方传入（应与当前会话/默认模型一致，确保 provider=config.id 与 key 匹配）。
 * 失败时抛错（由调用方 catch，不影响主对话流）。
 */
export async function completeText(
  systemPrompt: string,
  userText: string,
  model: Model<Api>,
  options?: { signal?: AbortSignal }
): Promise<CompleteTextResult> {
  log.debug('辅助文本补全开始', {
    provider: model.provider,
    modelId: model.id,
    inputChars: userText.length
  })
  const models = getModelsInstance()
  const apiKey = getDecryptedApiKey(model.provider)
  const context: Context = {
    systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() }]
  }
  // 不传 reasoning：标题生成 / 压缩摘要等辅助任务无需推理，省略后 reasoningEffort=undefined，
  // openai-completions 默认分支不会发送 reasoning_effort，避免某些端点（如小米）只接受
  // low/medium/high 而对 minimal/off 报 400（与 testModelConfig 同一处理）。
  const stream = models.streamSimple(model, context, {
    apiKey,
    signal: options?.signal
  })
  const final = (await stream.result()) as AssistantMessage
  const text = extractMessageText(final.content)
  log.debug('辅助文本补全完成', {
    provider: model.provider,
    modelId: model.id,
    outputChars: text.length
  })
  return {
    text,
    provider: final.provider,
    model: final.model,
    usage: final.usage,
    timestamp: Date.now()
  }
}
