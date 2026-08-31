import { ref, watch, onScopeDispose, type Ref } from 'vue'
import { MicVAD, utils } from '@ricky0123/vad-web'
import { useMessage } from 'naive-ui'
import { useChatStore } from '@renderer/store/useChatStore'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { extractMessageText } from '@renderer/utils/messageText'
import { mainClient } from '@renderer/utils/main-client'

/** 语音会话阶段：off=未开启 / listening=等待说话 / recording=正在录音 /
 *  transcribing=转写中 / waiting=等待 AI 回复 / speaking=朗读回复（可打断）。 */
export type VoicePhase =
  | 'off'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'waiting'
  | 'speaking'

/** Silero VAD 模型与 ort wasm 的虚拟资源路径（main 进程 appasset:// 协议提供）。 */
const ASSET_BASE = 'appasset://voice/'
const ORT_BASE = 'appasset://voice/ort/'

/** 单次录音最长时长（ms）：VAD 未判断句时的兜底截断。 */
const MAX_UTTERANCE_MS = 15_000
/** VAD 预滚（ms）：语音起始前补录，避免丢开头字音。 */
const PRE_SPEECH_PAD_MS = 300
/** 判定一段语音有效的最短时长（ms）。 */
const MIN_SPEECH_MS = 250
/** 流式朗读兜底切句（字符）：文本无句尾标点但累计达到该长度也提前朗读，避免干等。 */
const STREAM_CHUNK_FALLBACK = 40
/** 无有效语音输入自动退出语音会话的静默时长（ms）。 */
const VOICE_IDLE_TIMEOUT_MS = 60_000
/** 空闲超时检查周期（ms）。 */
const IDLE_CHECK_INTERVAL_MS = 10_000

/**
 * 语音对话会话状态机（点击一次持续对话）：
 * 麦克风 → Silero VAD 自动断句 → MiMo ASR 转写 → 现有发送链路（voice 标记，
 * 口语化精简 + 可选快通道）→ 回复完成 → MiMo TTS 朗读 → 回到监听；朗读期间
 * VAD 继续运行，检测到用户开口即掐断（barge-in）并进入新一轮录音。
 */
export function useVoiceChat(): {
  phase: Ref<VoicePhase>
  supported: Ref<boolean>
  toggle: () => Promise<void>
} {
  const chatStore = useChatStore()
  const settings = useSettingsStore()
  const message = useMessage()

  const phase = ref<VoicePhase>('off')
  const supported = ref(
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  )

  let voiceActive = false
  let mic: MicVAD | null = null
  let stream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let ttsAudio: HTMLAudioElement | null = null
  let collector: ScriptProcessorNode | null = null
  let collectorSource: MediaStreamAudioSourceNode | null = null

  // 录音兜底缓冲（VAD 断句超时用；正常路径直接用 VAD 提供的 16k 音频）
  let recordingFlag = false
  let chunks: Float32Array[] = []
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let awaitingReply = false
  /** 最近一次有效语音输入时间（VAD 检测到开口即刷新），空闲超时据此判定。 */
  let lastInputAt = 0
  /** 空闲超时看门狗：静默超阈值自动退出语音会话。 */
  let idleTimer: ReturnType<typeof setInterval> | null = null

  // ---- 朗读状态：流式逐句（第一句出来即开始播放，不等整轮结束）----
  /** 已朗读到的文本进度（相对当前 assistant 消息原文，未剥离 markdown）。 */
  let spokenUpTo = 0
  /** 已播报过开始提示语的工具（toolCallId，避免同轮重复播报）。 */
  const announcedTools = new Set<string>()
  /** TTS 播放项：text 为朗读文本；audio 为已生成好的音频（工具提示语缓存），无则现场合成。 */
  interface TtsItem {
    text: string
    audio?: string
  }
  /** TTS 队列：逐句入队、顺序播放；barge-in 时清空。 */
  let ttsQueue: TtsItem[] = []
  let ttsPlaying = false
  /** 预生成流水线：播放当前项期间并行合成队内下一条，避免逐条串行等 TTS。 */
  let prefetch: { text: string; promise: Promise<string> } | null = null

  function toast(type: 'info' | 'warning' | 'error', content: string): void {
    message[type](content, { duration: 3500 })
  }

  // ---------- 播放 / 录音基础操作 ----------

  function toListening(): void {
    if (voiceActive) phase.value = 'listening'
  }

  function clearWatchdog(): void {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function startRecording(): void {
    phase.value = 'recording'
    chunks = []
    recordingFlag = true
    clearWatchdog()
    watchdogTimer = setTimeout(onRecordingTimeout, MAX_UTTERANCE_MS)
  }

  function stopRecording(): void {
    recordingFlag = false
    clearWatchdog()
  }

  /** 掐断正在播放的 TTS（barge-in / 关闭语音会话时）。 */
  function stopTtsPlayback(): void {
    if (ttsAudio) {
      ttsAudio.onended = null
      try {
        ttsAudio.pause()
      } catch {
        /* 忽略播放停止异常 */
      }
      ttsAudio = null
    }
  }

  // ---------- VAD 回调 ----------

  function onSpeechStart(): void {
    if (!voiceActive) return
    // 检测到开口即视为有效输入，刷新空闲超时
    lastInputAt = Date.now()
    // 朗读期间检测到用户开口 → barge-in：掐断朗读、清空队列并立即录音
    if (phase.value === 'speaking') {
      stopTtsPlayback()
      ttsQueue = []
      prefetch = null
      startRecording()
      return
    }
    // 等待回复期间用户开口 → 打断当前生成（丢弃未读完的回复），立即进入新一轮录音。
    // 置 awaitingReply=false 使 busy 结束回调不再 flush 旧文本。
    if (phase.value === 'waiting') {
      awaitingReply = false
      stopTtsPlayback()
      ttsQueue = []
      prefetch = null
      void chatStore.abort()
      startRecording()
      return
    }
    if (phase.value === 'listening') startRecording()
  }

  function onSpeechEnd(audio: Float32Array): void {
    if (!voiceActive || phase.value !== 'recording') return
    stopRecording()
    void handleUtterance(audio)
  }

  /** 录音超时兜底：用自身缓冲转写（可能略缺开头，但不会卡死会话）。 */
  function onRecordingTimeout(): void {
    if (!voiceActive || phase.value !== 'recording') return
    stopRecording()
    const merged = concatChunks(chunks)
    chunks = []
    if (merged.length === 0) {
      toListening()
      return
    }
    const rate = audioCtx?.sampleRate ?? 16000
    void handleUtterance(downsample(merged, rate, 16000))
  }

  // ---------- 一句话的完整链路：转写 → 发送 → 等待回复 ----------

  async function handleUtterance(audio16k: Float32Array): Promise<void> {
    if (!voiceActive) return
    phase.value = 'transcribing'
    try {
      const wav = utils.encodeWAV(audio16k, 1, 16000, 1, 16)
      const { text } = await mainClient.voice.asr(
        `data:audio/wav;base64,${utils.arrayBufferToBase64(wav)}`
      )
      const trimmed = text.trim()
      if (!trimmed) {
        toast('warning', '没听清，请再说一遍')
        toListening()
        return
      }
      // 上一句尚未结束：跳过本句，避免重复发送
      if (chatStore.isBusy) {
        toast('info', '上一句还在处理中，请稍候')
        toListening()
        return
      }
      // 本轮语音 run 启动：重置朗读/播报状态（文本朗读由下方 watch 驱动）
      awaitingReply = true
      announcedTools.clear()
      spokenUpTo = 0
      phase.value = 'waiting'
      await chatStore.send(trimmed, [], [], {
        voice: true,
        voiceFast: settings.voiceFastChannel
      })
      // send 同步失败（如未选模型）时 busy 不会置位，兜底回到监听
      if (!chatStore.isBusy) {
        awaitingReply = false
        const errMsg = chatStore.error
        if (errMsg) toast('error', errMsg)
        toListening()
      }
    } catch (err) {
      awaitingReply = false
      toast('error', `语音识别失败：${err instanceof Error ? err.message : String(err)}`)
      toListening()
    }
  }

  // ---------- 朗读：流式逐句（第一句出来即开始）+ 工具调用口语化提示语 ----------

  /** 工具开始执行时的口语化提示语（toolName → 一句话；未知工具走兜底）。
   * 打破工具执行期间的静默，让语音对话有节奏感。 */
  const TOOL_START_PHRASES: Record<string, string> = {
    bash: '我执行一下命令',
    web_search: '我帮你搜索一下',
    'web-search': '我帮你搜索一下',
    grep: '我搜索一下相关内容',
    find_file: '我帮你找一下文件',
    list_files: '我看看目录里有什么',
    read_file: '我先看一下这个文件',
    write_file: '我帮你写入这个文件',
    edit_file: '我帮你修改这个文件',
    memory: '我先查一下记忆',
    search_knowledge: '我检索一下知识库'
  }
  const DEFAULT_TOOL_PHRASE = '我帮你处理一下'

  /** 播放一段音频：播放结束 / 被打断（barge-in）/ 出错均 resolve，避免队列卡死。 */
  function playOnce(dataUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio(dataUrl)
      ttsAudio = audio
      const done = (): void => {
        audio.onended = null
        audio.onpause = null
        audio.onerror = null
        if (ttsAudio === audio) ttsAudio = null
        resolve()
      }
      audio.onended = done
      audio.onerror = () => done()
      // barge-in 会 pause 当前音频，需放行以退出播放（剩余文本随队列清空丢弃）
      audio.onpause = done
      audio.play().catch(() => done())
    })
  }

  /** 入队一段朗读文本（播放时合成，且可与当前播放并行预生成）并启动播放（未在播时）。 */
  function enqueueTts(text: string): void {
    const t = text.trim()
    if (!t) return
    ttsQueue.push({ text: t })
    if (!ttsPlaying) void drainTts()
    else prefetchNext()
  }

  /** 入队一段已生成好的音频（工具提示语 DB 缓存），首个音节零合成等待。 */
  function enqueueAudio(text: string, dataUrl: string): void {
    ttsQueue.push({ text, audio: dataUrl })
    if (!ttsPlaying) void drainTts()
  }

  /** 预生成：播放当前项期间并行合成队内第一条未合成文本（跳过已带音频的缓存项）。 */
  function prefetchNext(): void {
    if (prefetch || !voiceActive) return
    const next = ttsQueue.find((i) => !i.audio)
    if (!next) return
    const text = next.text
    prefetch = { text, promise: mainClient.voice.tts(text).then((r) => r.dataUrl) }
    prefetch.promise.catch(() => {
      if (prefetch?.text === text) prefetch = null
    })
  }

  /** 取某项的音频：已带音频（缓存）直接返回 → 预生成命中即等它在途结果 → 现场合成。 */
  async function obtainAudio(item: TtsItem): Promise<string> {
    if (item.audio) return item.audio
    if (prefetch?.text === item.text) {
      const p = prefetch
      prefetch = null
      return p.promise
    }
    const { dataUrl } = await mainClient.voice.tts(item.text)
    return dataUrl
  }

  async function drainTts(): Promise<void> {
    if (ttsPlaying || !voiceActive) return
    ttsPlaying = true
    try {
      while (ttsQueue.length > 0 && voiceActive) {
        const item = ttsQueue.shift()!
        phase.value = 'speaking'
        const dataUrl = await obtainAudio(item)
        if (!voiceActive) return
        // 本句播放期间并行合成下一条，衔接处无合成等待
        prefetchNext()
        await playOnce(dataUrl)
      }
    } catch (err) {
      toast('error', `朗读失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      ttsPlaying = false
      // 队列清空后：本轮已结束 → 回监听；否则回到等待（生成间隙保持静默）
      if (voiceActive && phase.value === 'speaking') {
        if (awaitingReply) phase.value = 'waiting'
        else toListening()
      }
    }
  }

  /** 流式文本切句：出现完整句子（含句尾标点/换行）即朗读；无句尾但累计超阈值也读（兜底）。
   * 入参为已提取的纯文本；newMsg 用于识别「换了新 assistant 消息」（工具往返后新一轮生成）。 */
  function onStreamingText(raw: string, newMsg: boolean): void {
    if (newMsg) spokenUpTo = 0
    if (raw.length <= spokenUpTo) return
    const segment = raw.slice(spokenUpTo)
    let end = -1
    for (let i = 0; i < segment.length; i++) {
      if (/[。！？!?；;\n]/.test(segment[i])) end = i + 1
    }
    if (end === -1) {
      if (segment.length < STREAM_CHUNK_FALLBACK) return
      end = segment.length
    }
    const chunkRaw = segment.slice(0, end)
    spokenUpTo += end
    const spoken = stripMarkdownForTts(chunkRaw)
    if (spoken) enqueueTts(spoken)
  }

  /**
   * 监听当前会话最后一条 assistant 消息文本：流式 message_update 由 applyChatEvent
   * 「就地替换 state.messages[i]」，数组引用不变——getter 必须读取数组元素内容
   * （role/content）才能建立元素级响应式依赖，元素替换、push 新消息、agent_end
   * 整体换数组均会触发回调。（此前「watch 无回调、被迫轮询」的根因：getter 只取
   * chatStore.messages 引用，computed 缓存同一数组，就地替换元素不会触发。）
   * 回调不检查 phase/ttsPlaying：工具提示语朗读中正式文本出现即入队，FIFO 顺序播放。
   */
  watch(
    () => {
      const msgs = chatStore.messages
      for (let i = msgs.length - 1; i >= 0; i--) {
        // 注意传 content 字段而非消息对象：extractMessageText 只接受 string/block 数组
        if (msgs[i].role === 'assistant')
          return extractMessageText((msgs[i] as { content?: unknown }).content)
      }
      return ''
    },
    (raw) => {
      if (!voiceActive || !awaitingReply || !raw) return
      // 值回退（新消息开头短于已朗读进度）→ 进入新的 assistant 消息，重置进度
      onStreamingText(raw, raw.length < spokenUpTo)
    }
  )

  /** 监听 busy 翻转：语音 run 结束时 flush 未朗读的尾部并收尾。 */
  watch(
    () => chatStore.isBusy,
    (busy) => {
      if (!voiceActive || !awaitingReply) return
      if (busy) return
      awaitingReply = false
      // flush 未朗读的尾部（可能没有完整句尾）
      const msgs = chatStore.messages
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          // 传 content 字段而非消息对象：extractMessageText 只接受 string/block 数组
          const raw = extractMessageText((msgs[i] as { content?: unknown }).content)
          const rest = raw.slice(spokenUpTo)
          if (rest.trim()) enqueueTts(stripMarkdownForTts(rest))
          spokenUpTo = raw.length
          break
        }
      }
      if (!ttsPlaying && ttsQueue.length === 0) toListening()
    }
  )

  /**
   * 监听最后一条 assistant 消息里的工具调用块：toolCall 的 name 一出现（参数可能仍在
   * 流式生成）即播报口语化提示语，不必等工具执行结束。固定短语走 main 侧 DB 预缓存
   * 音频（toolPhrase 随机变体），首个音节零合成等待；缓存未命中回退现场合成。
   * 同轮同工具只播一次（announcedTools）。
   */
  watch(
    () => {
      const msgs = chatStore.messages
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role !== 'assistant') continue
        const c = (m as { content?: unknown }).content
        if (!Array.isArray(c)) return ''
        return (c as { type?: string; id?: string; name?: string }[])
          .filter((b) => b.type === 'toolCall' && b.id && b.name)
          .map((b) => `${b.id}::${b.name}`)
          .join(',')
      }
      return ''
    },
    (toolCalls) => {
      if (!voiceActive || !awaitingReply) return
      for (const pair of toolCalls.split(',').filter(Boolean)) {
        const sep = pair.indexOf('::')
        const id = pair.slice(0, sep)
        const name = pair.slice(sep + 2)
        if (!id || !name || announcedTools.has(id)) continue
        announcedTools.add(id)
        const phrase = `${TOOL_START_PHRASES[name] ?? DEFAULT_TOOL_PHRASE}，稍等一下`
        void mainClient.voice.toolPhrase(phrase).then(
          ({ dataUrl }) => {
            if (voiceActive) enqueueAudio(phrase, dataUrl)
          },
          () => {
            // 缓存不可用（未配置 key 等）回退现场合成，不阻断朗读
            if (voiceActive) enqueueTts(phrase)
          }
        )
      }
    }
  )

  // ---------- 会话开关 ----------

  /**
   * 空闲超时看门狗：仅在空闲聆听阶段判定（生成/朗读/录音期间不打断），
   * 静默超过 VOICE_IDLE_TIMEOUT_MS 无有效语音输入时自动关闭语音会话。
   */
  function startIdleWatchdog(): void {
    stopIdleWatchdog()
    idleTimer = setInterval(() => {
      if (!voiceActive || phase.value !== 'listening') return
      if (Date.now() - lastInputAt < VOICE_IDLE_TIMEOUT_MS) return
      toast('info', '超过 1 分钟无语音输入，已自动退出语音对话')
      void stopVoice()
    }, IDLE_CHECK_INTERVAL_MS)
  }

  function stopIdleWatchdog(): void {
    if (idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
  }

  async function toggle(): Promise<void> {
    if (phase.value === 'off') await startVoice()
    else await stopVoice()
  }

  async function startVoice(): Promise<void> {
    if (phase.value !== 'off') return
    if (!supported.value) {
      toast('error', '当前环境不支持麦克风')
      return
    }
    // 实时校验 key：设置窗口保存后本窗口的缓存标记不会自动更新（跨窗口独立状态），
    // 点击时向 main 查询为准，避免「已配置却提示去配置」。
    try {
      const cfg = await mainClient.voice.getConfig()
      settings.voiceHasApiKey = cfg.hasApiKey
      if (!cfg.hasApiKey) {
        toast(
          'warning',
          '请先在「设置 → 语音」配置 MiMo 语音 API key（platform.xiaomimimo.com 申请）'
        )
        return
      }
    } catch (err) {
      toast('error', `语音配置读取失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(
        'error',
        `无法访问麦克风：${msg}。macOS 需在「系统设置 → 隐私与安全性 → 麦克风」中授权本应用`
      )
      return
    }
    audioCtx = new AudioContext()
    await audioCtx.resume()
    try {
      // 兜底缓冲采集：仅在录音期间把本机采样率 PCM 追加到 chunks
      collectorSource = audioCtx.createMediaStreamSource(stream)
      collector = audioCtx.createScriptProcessor(4096, 1, 1)
      collector.onaudioprocess = (e) => {
        if (recordingFlag) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      collectorSource.connect(collector)
      // ScriptProcessor 需连接 destination 才会持续触发（输出静音即可）
      collector.connect(audioCtx.destination)

      mic = await MicVAD.new({
        model: 'legacy',
        baseAssetPath: ASSET_BASE,
        // ort 会经此动态 import 胶水 .mjs + fetch wasm；appasset:// 协议已放行
        //（CSP connect-src/script-src + 协议 ACAO 头 + host/path 路由，见 asset-protocol.ts）
        onnxWASMBasePath: ORT_BASE,
        processorType: 'ScriptProcessor',
        audioContext: audioCtx,
        getStream: () => Promise.resolve(stream!),
        // 会话期间麦克风常开（供 barge-in），不随 VAD pause 停流
        pauseStream: async () => {},
        resumeStream: async (s) => s,
        startOnLoad: true,
        preSpeechPadMs: PRE_SPEECH_PAD_MS,
        minSpeechMs: MIN_SPEECH_MS,
        redemptionMs: Math.round(settings.voiceSilenceSec * 1000),
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        ortConfig: (ort) => {
          ort.env.logLevel = 'error'
          // file:// 下无跨源隔离，单线程避免 SharedArrayBuffer 依赖
          ort.env.wasm.numThreads = 1
        },
        onSpeechStart,
        onSpeechEnd,
        onVADMisfire: () => {}
      })
      voiceActive = true
      phase.value = 'listening'
      lastInputAt = Date.now()
      startIdleWatchdog()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 完整打日志：vad-web 内部会吞掉 fetch 的真实错误，这里补全方便排查
      console.error('[voice] VAD 初始化失败', err)
      toast('error', `语音引擎初始化失败：${msg}`)
      await stopVoice()
    }
  }

  async function stopVoice(): Promise<void> {
    stopIdleWatchdog()
    voiceActive = false
    awaitingReply = false
    clearWatchdog()
    stopTtsPlayback()
    // 复位流式朗读状态
    ttsQueue = []
    ttsPlaying = false
    prefetch = null
    spokenUpTo = 0
    announcedTools.clear()
    try {
      if (collector) {
        collector.onaudioprocess = null
        collector.disconnect()
      }
      if (collectorSource) collectorSource.disconnect()
    } catch {
      /* 忽略断开异常 */
    }
    collector = null
    collectorSource = null
    if (mic) {
      try {
        await mic.destroy()
      } catch {
        /* 忽略销毁异常 */
      }
      mic = null
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }
    if (audioCtx) {
      try {
        await audioCtx.close()
      } catch {
        /* 忽略关闭异常 */
      }
      audioCtx = null
    }
    chunks = []
    phase.value = 'off'
  }

  onScopeDispose(() => {
    void stopVoice()
  })

  return {
    phase,
    supported,
    toggle
  }
}

// ---------- 工具函数 ----------

/**
 * 朗读前剥离 markdown 符号：只读干净正文，避免 TTS 把 **、#、```、[链接](url) 等
 * 原样念出来。工具调用/工具结果本来就不进入朗读文本（onReplyFinished 只取最终 assistant 文本）。
 */
function stripMarkdownForTts(text: string): string {
  let s = text.trim()
  if (!s) return ''
  // 代码围栏整体移除（``` 或 ```lang ... ```）
  s = s.replace(/```[\s\S]*?```/g, ' ')
  // 行首标题/列表/引用/分割线符号
  s = s.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*|---+)/gm, '')
  // 粗体/斜体/行内代码/链接
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // 合并多余空行与空白
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 线性重采样（就近取值）。 */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || toRate <= 0) return input
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const idx = Math.round(i * ratio)
    out[i] = input[Math.min(idx, input.length - 1)]
  }
  return out
}
