import { IpcService } from 'electron-ipc-service'
import { db } from '../database'
import { createLogger } from '../utils/log'
import { encryptSecret, decryptSecret } from '../utils/safe-key'
import {
  SETTING_VOICE_API_KEY,
  SETTING_VOICE_REGION,
  SETTING_VOICE_LANGUAGE,
  SETTING_VOICE_TTS_VOICE,
  SETTING_VOICE_TTS_STYLE,
  SETTING_VOICE_SILENCE_SEC,
  SETTING_VOICE_FAST_CHANNEL,
  SETTING_VOICE_TOOL_PHRASES,
  DEFAULT_VOICE_REGION,
  DEFAULT_VOICE_LANGUAGE,
  DEFAULT_VOICE_TTS_VOICE,
  DEFAULT_VOICE_SILENCE_SEC,
  DEFAULT_VOICE_FAST_CHANNEL,
  DEFAULT_VOICE_TOOL_PHRASES,
  type VoiceRegion,
  type VoiceLanguage
} from '../agent/types'

const log = createLogger('voice')

/** MiMo 语音接入区域 → API base（OpenAI 兼容 /v1）。 */
const MIMO_BASE_URLS: Record<VoiceRegion, string> = {
  cn: 'https://token-plan-cn.xiaomimimo.com/v1',
  global: 'https://api.xiaomimimo.com/v1'
}

/** ASR / TTS 模型 id。 */
const MIMO_ASR_MODEL = 'mimo-v2.5-asr'
const MIMO_TTS_MODEL = 'mimo-v2.5-tts'

/** 单次 HTTP 超时（ms）：ASR/TTS 均含模型推理，给足时间。 */
const REQUEST_TIMEOUT_MS = 30_000

/** TTS 单次合成上限（字符）：过长文本截断，避免超时与费用失控。 */
const TTS_MAX_CHARS = 500

/** 工具提示语缓存：每种短语预生成的变体数（同文本不同语气，随机播放有听感差异）。 */
const TOOL_PHRASE_VARIANTS = 3
/** 变体语气后缀（叠加在用户配置的风格指令后；用户未配置风格时作为唯一风格指令）。 */
const TOOL_PHRASE_STYLE_VARIANTS = ['', '，语速稍快、干脆利落', '，语气温和自然']

/** 拼接某变体的完整风格指令：用户配置风格 + 变体后缀。 */
function variantStyle(style: string, idx: number): string {
  const suffix = TOOL_PHRASE_STYLE_VARIANTS[idx] ?? ''
  return `${style}${suffix}`.trim()
}

/** 读取设置项并做类型收窄（settings 表存 JSON，可能缺失或类型漂移）。 */
function getSetting<T>(key: string, fallback: T): T {
  const v = db.getSetting<unknown>(key)
  return v === undefined || v === null ? fallback : (v as T)
}

/** 读取并解密 MiMo 语音 API key。未配置时抛引导性错误。 */
function getApiKey(): string {
  const encryptedB64 = db.getSetting<string>(SETTING_VOICE_API_KEY)
  if (!encryptedB64) {
    throw new Error('未配置 MiMo 语音 API key，请到「设置 → 语音」填写（platform.xiaomimimo.com 申请，当前限时免费）')
  }
  return decryptSecret(Buffer.from(encryptedB64, 'base64'))
}

/** MiMo API 公共请求封装：统一 header/超时/错误解析。 */
async function postJson(base: string, body: unknown): Promise<unknown> {
  const key = getApiKey()
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!resp.ok) {
    const errText = (await resp.text().catch(() => '')).slice(0, 300)
    throw new Error(`MiMo 语音 API ${resp.status}: ${errText || resp.statusText}`)
  }
  return resp.json() as Promise<unknown>
}

/** 语音服务：MiMo 语音 API（ASR / TTS）接入，key 经 safeStorage 加密存 settings 表。 */
export class VoiceService extends IpcService {
  static override readonly namespace = 'voice'

  /** 当前语音相关配置（不含 key 明文；hasApiKey 单独标记是否已配置）。 */
  getConfig(): {
    hasApiKey: boolean
    region: VoiceRegion
    language: VoiceLanguage
    ttsVoice: string
    ttsStyle: string
    silenceSec: number
    fastChannel: boolean
    toolPhrases: boolean
  } {
    return {
      hasApiKey: !!db.getSetting(SETTING_VOICE_API_KEY),
      region: getSetting<VoiceRegion>(SETTING_VOICE_REGION, DEFAULT_VOICE_REGION),
      language: getSetting<VoiceLanguage>(SETTING_VOICE_LANGUAGE, DEFAULT_VOICE_LANGUAGE),
      ttsVoice: getSetting<string>(SETTING_VOICE_TTS_VOICE, DEFAULT_VOICE_TTS_VOICE),
      ttsStyle: getSetting<string>(SETTING_VOICE_TTS_STYLE, ''),
      silenceSec: getSetting<number>(SETTING_VOICE_SILENCE_SEC, DEFAULT_VOICE_SILENCE_SEC),
      fastChannel: getSetting<boolean>(SETTING_VOICE_FAST_CHANNEL, DEFAULT_VOICE_FAST_CHANNEL),
      toolPhrases: getSetting<boolean>(SETTING_VOICE_TOOL_PHRASES, DEFAULT_VOICE_TOOL_PHRASES)
    }
  }

  /** 保存并加密 MiMo 语音 API key（明文不落库）。 */
  setApiKey(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('API key 不能为空')
    db.setSetting(SETTING_VOICE_API_KEY, encryptSecret(trimmed).toString('base64'))
    log.info('已设置 MiMo 语音 API key')
  }

  /** 清除已保存的 MiMo 语音 API key。 */
  clearApiKey(): void {
    db.deleteSetting(SETTING_VOICE_API_KEY)
    log.info('已清除 MiMo 语音 API key')
  }

  /**
   * 语音识别：MiMo ASR，传入 data URL 音频（data:audio/wav;base64,...）。
   * 返回转写文本；未识别到内容时返回空串（不抛错——渲染层按「没听清」提示重说，
   * 避免把「无有效语音」当业务错误刷 IPC 报错日志）。
   */
  async asr(
    audioDataUrl: string,
    language?: VoiceLanguage
  ): Promise<{ text: string }> {
    const region = getSetting<VoiceRegion>(SETTING_VOICE_REGION, DEFAULT_VOICE_REGION)
    const lang = language ?? getSetting<VoiceLanguage>(SETTING_VOICE_LANGUAGE, DEFAULT_VOICE_LANGUAGE)
    const data = await postJson(MIMO_BASE_URLS[region], {
      model: MIMO_ASR_MODEL,
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: audioDataUrl } }]
        }
      ],
      asr_options: { language: lang }
    })
    const content = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
      ?.message?.content
    const text =
      typeof content === 'string'
        ? content.trim()
        : Array.isArray(content)
          ? (content as { text?: string }[]).map((b) => b.text ?? '').join('').trim()
          : ''
    if (!text) {
      log.debug('ASR 无有效内容', {})
      return { text: '' }
    }
    log.debug('ASR 完成', { chars: text.length, text: text.slice(0, 60) })
    return { text }
  }

  /**
   * 语音合成：MiMo TTS，返回 wav 音频 data URL（渲染进程 <audio> 直接播放）。
   * style 为可选自然语言风格指令（如「温柔、口语化」）。
   */
  async tts(
    text: string,
    opts?: { voice?: string; style?: string }
  ): Promise<{ dataUrl: string }> {
    const region = getSetting<VoiceRegion>(SETTING_VOICE_REGION, DEFAULT_VOICE_REGION)
    const voice = opts?.voice ?? getSetting<string>(SETTING_VOICE_TTS_VOICE, DEFAULT_VOICE_TTS_VOICE)
    const style = opts?.style ?? getSetting<string>(SETTING_VOICE_TTS_STYLE, '')
    const content = text.trim().slice(0, TTS_MAX_CHARS)
    if (!content) throw new Error('没有可朗读的内容')
    // MiMo TTS 用 user 消息传风格指令、assistant 消息传要合成的文本
    const messages: { role: string; content: string }[] = []
    if (style) messages.push({ role: 'user', content: style })
    messages.push({ role: 'assistant', content })
    const data = await postJson(MIMO_BASE_URLS[region], {
      model: MIMO_TTS_MODEL,
      messages,
      audio: { format: 'wav', voice }
    })
    const audioB64 = (data as { choices?: { message?: { audio?: { data?: string } } }[] })
      .choices?.[0]?.message?.audio?.data
    if (!audioB64) throw new Error('TTS 返回无音频数据')
    log.debug('TTS 完成', { chars: content.length })
    return { dataUrl: `data:audio/wav;base64,${audioB64}` }
  }

  /** 连通性测试：用极短文本走一次 TTS，验证 key 有效性与额度。 */
  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.tts('测试', { voice: 'mimo_default' })
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn('MiMo 语音连通性测试失败', { error })
      return { ok: false, error }
    }
  }

  /**
   * 工具提示语朗读：固定短语优先取 DB 预缓存音频（随机变体），首个音节零合成等待。
   * 未命中时先同步合成首个变体立即返回（不阻塞朗读），其余变体后台补齐入库。
   * 缓存键含 (voice, style)：音色/风格切换后自然失配重建；设置变更时由 clearTtsCache
   * 整体清空旧键，避免残留旧音色数据。
   */
  async toolPhrase(text: string): Promise<{ dataUrl: string }> {
    const phrase = text.trim().slice(0, TTS_MAX_CHARS)
    if (!phrase) throw new Error('没有可朗读的内容')
    const voice = getSetting<string>(SETTING_VOICE_TTS_VOICE, DEFAULT_VOICE_TTS_VOICE)
    const style = getSetting<string>(SETTING_VOICE_TTS_STYLE, '')
    const cached = db.listVoiceTtsCache(phrase, voice, style)
    if (cached.length > 0) {
      return { dataUrl: cached[Math.floor(Math.random() * cached.length)].audio }
    }
    // 未命中：首个变体同步合成（保持原风格），其余变体后台生成
    const first = await this.tts(phrase, { voice, style: variantStyle(style, 0) })
    db.insertVoiceTtsCache({ phrase, voice, style, variant: 0, audio: first.dataUrl })
    for (let i = 1; i < TOOL_PHRASE_VARIANTS; i++) {
      const variant = i
      void this.tts(phrase, { voice, style: variantStyle(style, variant) })
        .then((r) => {
          db.insertVoiceTtsCache({ phrase, voice, style, variant, audio: r.dataUrl })
          log.debug('工具提示语变体已缓存', { phrase, variant })
        })
        .catch((err) => {
          log.warn('工具提示语变体生成失败', {
            phrase,
            variant,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    }
    return { dataUrl: first.dataUrl }
  }

  /** 清空工具提示语 TTS 缓存（音色/风格指令变更后调用，强制按新参数重建）。 */
  clearTtsCache(): void {
    db.clearVoiceTtsCache()
    log.info('已清空工具提示语 TTS 缓存')
  }
}
