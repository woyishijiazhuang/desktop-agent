import type { MutableModels } from '@earendil-works/pi-ai'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { getDecryptedApiKey } from './crypto'
import { buildModel } from './register'

const log = createLogger('modelConfig')

/**
 * 测试某 config 的连通性：用 maxTokens:1 跑一次 streamSimple，收到首个非 error 事件即判成功。
 * 8s 超时兜底。error 事件 / 抛错 → 失败，返回错误信息。
 */
export async function testModelConfig(
  models: MutableModels,
  configId: string
): Promise<{ ok: boolean; error?: string }> {
  const config = db.getModelConfig(configId)
  if (!config) return { ok: false, error: '模型配置不存在' }
  let apiKey: string
  try {
    apiKey = getDecryptedApiKey(configId)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const model = buildModel(config)
  const stream = models.streamSimple(
    model,
    {
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], timestamp: Date.now() }]
    },
    // 不传 reasoning：连通性测试无需推理，省略后 reasoningEffort=undefined，
    // openai-completions 默认分支不会发送 reasoning_effort，避免某些端点
    // （如小米）因只接受 low/medium/high 而对 minimal/off 报 400。
    { apiKey, maxTokens: 1, signal: AbortSignal.timeout(8000) }
  )
  try {
    for await (const ev of stream) {
      if (ev.type === 'error') {
        const err = ev.error.errorMessage ?? '连接失败'
        log.warn('模型连通性测试失败', { configId, error: err })
        return { ok: false, error: err }
      }
      // 收到首个非 error 事件（如 start）即判连通成功
      log.info('模型连通性测试通过', { configId, modelId: model.id })
      return { ok: true }
    }
    return { ok: false, error: '未收到任何响应' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn('模型连通性测试失败', { configId, error })
    return { ok: false, error }
  }
}
