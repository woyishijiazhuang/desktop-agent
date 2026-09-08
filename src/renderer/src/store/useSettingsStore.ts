import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type {
  FindSkillSource,
  InstalledSkill,
  ThinkingLevel,
  TitleBarMode,
  ToolInfo,
  VoiceRegion,
  VoiceLanguage
} from '@main/agent/types'
import {
  SETTING_DEFAULT_SYSTEM_PROMPT,
  SETTING_DEFAULT_THINKING_LEVEL,
  SETTING_ENABLED_TOOLS,
  SETTING_MAX_TURNS_PER_RUN,
  SETTING_NOTIFICATIONS_ENABLED,
  SETTING_MEMORY_ENABLED,
  SETTING_SKILLS_ENABLED,
  SETTING_KB_ENABLED,
  SETTING_AUTO_COMPRESS_ENABLED,
  SETTING_AUTO_COMPRESS_THRESHOLD,
  SETTING_CLOSE_TO_TRAY,
  SETTING_TITLE_BAR_MODE,
  SETTING_AGENT_ENV,
  SETTING_PERMISSION_AUTO_APPROVE,
  SETTING_PERMISSION_TIMEOUT_SEC,
  SETTING_SANDBOX_ENABLED,
  SETTING_SANDBOX_WRITABLE_ROOTS,
  SETTING_SANDBOX_DENY_READ_ROOTS,
  SETTING_SANDBOX_NETWORK_ALLOWLIST,
  SANDBOX_DEFAULT_NETWORK_ALLOWLIST,
  SETTING_VOICE_REGION,
  SETTING_VOICE_LANGUAGE,
  SETTING_VOICE_TTS_VOICE,
  SETTING_VOICE_TTS_STYLE,
  SETTING_VOICE_SILENCE_SEC,
  SETTING_VOICE_FAST_CHANNEL,
  SETTING_VOICE_TOOL_PHRASES,
  SETTING_VOICE_API_KEY,
  DEFAULT_MAX_TURNS_PER_RUN,
  DEFAULT_FIND_SKILL_SOURCE,
  DEFAULT_AUTO_COMPRESS_ENABLED,
  DEFAULT_AUTO_COMPRESS_THRESHOLD,
  DEFAULT_PERMISSION_TIMEOUT_SEC,
  DEFAULT_VOICE_REGION,
  DEFAULT_VOICE_LANGUAGE,
  DEFAULT_VOICE_TTS_VOICE,
  DEFAULT_VOICE_SILENCE_SEC,
  DEFAULT_VOICE_FAST_CHANNEL,
  DEFAULT_VOICE_TOOL_PHRASES,
  VOICE_PRESETS
} from '@main/agent/types'

/** 思考级别可选项（renderer 选择器用）。须与 @main/agent/types 的 ThinkingLevel 一一对应。 */
export const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' }
]

/**
 * 设置状态：全局默认系统提示 / 上次使用思考级别 / 工具开关。
 *
 * 模型配置与 API Key 已迁移到 useModelConfigsStore（每条 config 独立 key，加密存 main 进程），
 * 此处不再持有 provider/model/默认模型状态。
 * 上下文稳定性约定（2026-09）：工具/技能/记忆/知识库/默认提示词开关均「即时生效、不驱逐 Agent、
 * 不改工具集」——工具数组常驻，启停靠执行层掩码（见 tools/index.ts wrapGate），前缀缓存不失效。
 */
export const useSettingsStore = defineStore('settings', () => {
  const defaultSystemPrompt = ref<string>('')
  /** 上次使用思考级别（新建会话继承，与模型 lastUsed 语义一致；存 settings.defaultThinkingLevel）。 */
  const lastUsedThinkingLevel = ref<ThinkingLevel>('medium')
  /** 单次 run 允许的最大轮次（防工具死循环，正整数）。 */
  const maxTurnsPerRun = ref<number>(DEFAULT_MAX_TURNS_PER_RUN)
  /** 全部工具及其启用状态（工具开关 UI 用）。 */
  const tools = ref<ToolInfo[]>([])
  /** Tavily API Key 是否已配置（明文 key 不进入渲染进程）。 */
  const webSearchKeyConfigured = ref(false)
  /** 技能搜索（find_skill）当前数据源：字节 Find Skill / 腾讯 SkillHub。 */
  const findSkillSource = ref<FindSkillSource>(DEFAULT_FIND_SKILL_SOURCE)
  /** 已安装技能列表（技能管理页展示用）。 */
  const installedSkills = ref<InstalledSkill[]>([])
  /** 长期记忆开关（控制记忆读写工具是否可用；记忆注入不受此开关影响）。 */
  const memoryEnabled = ref(true)
  /** 本地技能总开关（控制技能域工具注入）。 */
  const skillsEnabled = ref(true)
  /** 知识库总开关（控制知识库检索工具注入）。 */
  const kbEnabled = ref(true)
  /** 自动压缩开关（发送消息前未压缩上下文超阈值时静默摘要）。 */
  const autoCompressEnabled = ref<boolean>(DEFAULT_AUTO_COMPRESS_ENABLED)
  /** 自动压缩阈值：未压缩上下文达到模型窗口的该百分比时触发（0~100）。 */
  const autoCompressThreshold = ref<number>(DEFAULT_AUTO_COMPRESS_THRESHOLD)
  /** 桌面通知开关（默认开启；关闭后不弹系统通知）。 */
  const notificationsEnabled = ref(true)
  /** 跳过工具确认（默认关闭；开启后危险工具免确认，破坏性命令除外）。 */
  const permissionAutoApprove = ref(false)
  /** 工具确认超时（秒；0 = 一直等待，默认 60）。 */
  const permissionTimeoutSec = ref(DEFAULT_PERMISSION_TIMEOUT_SEC)
  // ---- bash 沙箱 ----
  /** 沙箱总开关（默认关闭 = 维持现状直跑）。 */
  const sandboxEnabled = ref(false)
  /** 用户追加的可写根（工作区目录自动可写，此处追加工作区外授权目录）。 */
  const sandboxWritableRoots = ref<string[]>([])
  /** 禁止读取的目录（默认全局可读，此处做减法）。 */
  const sandboxDenyReadRoots = ref<string[]>([])
  /** 网络域名白名单（空数组 = 全部拒网；默认内置常用站点）。 */
  const sandboxNetworkAllowlist = ref<string[]>(SANDBOX_DEFAULT_NETWORK_ALLOWLIST)
  // ---- 语音对话 ----
  /** MiMo 语音 API key 是否已配置（明文不进入渲染进程）。 */
  const voiceHasApiKey = ref(false)
  /** MiMo 语音接入区域。 */
  const voiceRegion = ref<VoiceRegion>(DEFAULT_VOICE_REGION)
  /** ASR 识别语言。 */
  const voiceLanguage = ref<VoiceLanguage>(DEFAULT_VOICE_LANGUAGE)
  /** TTS 音色 id。 */
  const voiceTtsVoice = ref(DEFAULT_VOICE_TTS_VOICE)
  /** TTS 风格指令（自然语言描述，如「温柔、口语化」；空 = 不传）。 */
  const voiceTtsStyle = ref('')
  /** VAD 断句静音阈值（秒）。 */
  const voiceSilenceSec = ref(DEFAULT_VOICE_SILENCE_SEC)
  /** 语音快通道（跳过工具 + 关思考）。 */
  const voiceFastChannel = ref(DEFAULT_VOICE_FAST_CHANNEL)
  /** 工具调用开始时播报口语化提示语（如「我执行一下命令」）。 */
  const voiceToolPhrases = ref(DEFAULT_VOICE_TOOL_PHRASES)
  /** 关闭窗口时最小化到托盘（默认关闭：关窗即退出/关闭窗口）。 */
  const closeToTray = ref(false)
  /** 标题栏模式（默认 native：优先当前平台原生窗口栏）。 */
  const titleBarMode = ref<TitleBarMode>('native')
  /** bash 工具额外环境变量（KEY=VALUE；优先级高于应用自身与自动抓取的 shell 环境）。 */
  const agentEnv = ref<Record<string, string>>({})

  /**
   * 加载全局默认项 + 工具列表（settings 表）。
   * 注：IPC 客户端包装会擦除方法的泛型参数，故 getSetting 返回 unknown，需手动断言。
   */
  async function loadSettings(): Promise<void> {
    const [
      systemPrompt,
      thinkingLevel,
      maxTurns,
      toolList,
      webSearchConfig,
      findSkillConfig,
      skills,
      notificationsEnabledVal,
      memoryEnabledVal,
      skillsEnabledVal,
      kbEnabledVal,
      autoCompressEnabledVal,
      autoCompressThresholdVal,
      closeToTrayVal,
      titleBarModeVal,
      agentEnvVal,
      permissionAutoApproveVal,
      permissionTimeoutSecVal,
      sandboxEnabledVal,
      sandboxWritableRootsVal,
      sandboxDenyReadRootsVal,
      sandboxNetworkAllowlistVal,
      voiceConfig
    ] = await Promise.all([
      mainClient.db.getSetting(SETTING_DEFAULT_SYSTEM_PROMPT),
      mainClient.db.getSetting(SETTING_DEFAULT_THINKING_LEVEL),
      mainClient.db.getSetting(SETTING_MAX_TURNS_PER_RUN),
      mainClient.agent.listTools(),
      mainClient.agent.getWebSearchConfig(),
      mainClient.agent.getFindSkillConfig(),
      mainClient.agent.listInstalledSkills(),
      mainClient.db.getSetting(SETTING_NOTIFICATIONS_ENABLED),
      mainClient.db.getSetting(SETTING_MEMORY_ENABLED),
      mainClient.db.getSetting(SETTING_SKILLS_ENABLED),
      mainClient.db.getSetting(SETTING_KB_ENABLED),
      mainClient.db.getSetting(SETTING_AUTO_COMPRESS_ENABLED),
      mainClient.db.getSetting(SETTING_AUTO_COMPRESS_THRESHOLD),
      mainClient.db.getSetting(SETTING_CLOSE_TO_TRAY),
      mainClient.db.getSetting(SETTING_TITLE_BAR_MODE),
      mainClient.db.getSetting(SETTING_AGENT_ENV),
      mainClient.db.getSetting(SETTING_PERMISSION_AUTO_APPROVE),
      mainClient.db.getSetting(SETTING_PERMISSION_TIMEOUT_SEC),
      mainClient.db.getSetting(SETTING_SANDBOX_ENABLED),
      mainClient.db.getSetting(SETTING_SANDBOX_WRITABLE_ROOTS),
      mainClient.db.getSetting(SETTING_SANDBOX_DENY_READ_ROOTS),
      mainClient.db.getSetting(SETTING_SANDBOX_NETWORK_ALLOWLIST),
      mainClient.voice.getConfig()
    ])
    tools.value = toolList
    installedSkills.value = skills
    defaultSystemPrompt.value = (systemPrompt as string | undefined) ?? ''
    const lvl = (thinkingLevel as ThinkingLevel | undefined) ?? 'medium'
    lastUsedThinkingLevel.value = THINKING_LEVEL_OPTIONS.some((o) => o.value === lvl)
      ? lvl
      : 'medium'
    const max = maxTurns as number | undefined
    maxTurnsPerRun.value =
      typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_TURNS_PER_RUN
    webSearchKeyConfigured.value = webSearchConfig.hasKey
    findSkillSource.value = findSkillConfig.source
    notificationsEnabled.value = (notificationsEnabledVal as boolean | undefined) ?? true
    permissionAutoApprove.value = (permissionAutoApproveVal as boolean | undefined) ?? false
    const permTimeout = permissionTimeoutSecVal as number | undefined
    permissionTimeoutSec.value =
      typeof permTimeout === 'number' && Number.isFinite(permTimeout) && permTimeout >= 0
        ? Math.floor(permTimeout)
        : DEFAULT_PERMISSION_TIMEOUT_SEC
    sandboxEnabled.value = (sandboxEnabledVal as boolean | undefined) ?? false
    sandboxWritableRoots.value = (sandboxWritableRootsVal as string[] | undefined) ?? []
    sandboxDenyReadRoots.value = (sandboxDenyReadRootsVal as string[] | undefined) ?? []
    const allowlist = sandboxNetworkAllowlistVal as string[] | undefined
    // 未配置过才回退内置默认；显式存空数组 = 用户选择「禁止全部外网」
    sandboxNetworkAllowlist.value =
      allowlist === undefined ? [...SANDBOX_DEFAULT_NETWORK_ALLOWLIST] : allowlist
    // 语音配置（voice.getConfig 返回聚合配置，无 key 明文）
    const vc = voiceConfig as
      | {
          hasApiKey: boolean
          region: VoiceRegion
          language: VoiceLanguage
          ttsVoice: string
          ttsStyle: string
          silenceSec: number
          fastChannel: boolean
          toolPhrases: boolean
        }
      | undefined
    voiceHasApiKey.value = vc?.hasApiKey ?? false
    voiceRegion.value = vc?.region ?? DEFAULT_VOICE_REGION
    voiceLanguage.value = vc?.language ?? DEFAULT_VOICE_LANGUAGE
    voiceTtsVoice.value =
      vc?.ttsVoice && VOICE_PRESETS.some((v) => v.id === vc.ttsVoice)
        ? vc.ttsVoice
        : DEFAULT_VOICE_TTS_VOICE
    voiceTtsStyle.value = vc?.ttsStyle ?? ''
    const sil = vc?.silenceSec
    voiceSilenceSec.value =
      typeof sil === 'number' && Number.isFinite(sil) && sil >= 0.1 && sil <= 5
        ? sil
        : DEFAULT_VOICE_SILENCE_SEC
    voiceFastChannel.value = vc?.fastChannel ?? DEFAULT_VOICE_FAST_CHANNEL
    voiceToolPhrases.value = vc?.toolPhrases ?? DEFAULT_VOICE_TOOL_PHRASES
    memoryEnabled.value = (memoryEnabledVal as boolean | undefined) ?? true
    skillsEnabled.value = (skillsEnabledVal as boolean | undefined) ?? true
    kbEnabled.value = (kbEnabledVal as boolean | undefined) ?? true
    autoCompressEnabled.value =
      (autoCompressEnabledVal as boolean | undefined) ?? DEFAULT_AUTO_COMPRESS_ENABLED
    const thr = autoCompressThresholdVal as number | undefined
    autoCompressThreshold.value =
      typeof thr === 'number' && thr >= 50 && thr <= 100 ? thr : DEFAULT_AUTO_COMPRESS_THRESHOLD
    closeToTray.value = (closeToTrayVal as boolean | undefined) ?? false
    const mode = titleBarModeVal as TitleBarMode | undefined
    titleBarMode.value = mode === 'custom' || mode === 'native' ? mode : 'native'
    agentEnv.value = (agentEnvVal as Record<string, string> | undefined) ?? {}
  }

  /**
   * 保存默认系统提示：仅写入作为「之后新建会话」的默认值。
   * 不再清空既有会话的固化提示词快照、不再驱逐 Agent——避免一次保存导致全部会话
   * 前缀重建（缓存 miss + 带新时间戳）。需要让现有会话也采用时，
   * 由用户显式触发 applyDefaultSystemPromptToAll（设置页独立按钮）。
   */
  async function saveDefaultSystemPrompt(prompt: string): Promise<void> {
    await mainClient.db.setSetting(SETTING_DEFAULT_SYSTEM_PROMPT, prompt)
    defaultSystemPrompt.value = prompt
  }

  /**
   * 将当前默认系统提示应用到全部现有会话（显式操作，会清空全部固化快照并驱逐 Agent，
   * 各会话下一轮以新默认 + 新时间重建前缀）。
   */
  async function applyDefaultSystemPromptToAll(): Promise<void> {
    await mainClient.db.clearResolvedSystemPrompts()
    await mainClient.agent.evictAllSessions()
  }

  /** 写回「上次使用思考级别」：新建会话继承（与模型 lastUsed 语义一致）。非法 level 拒绝写库。无需驱逐 Agent（会话级选择已由 selectThinkingLevel 同步内存）。 */
  async function setLastUsedThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (!THINKING_LEVEL_OPTIONS.some((o) => o.value === level)) return
    await mainClient.db.setSetting(SETTING_DEFAULT_THINKING_LEVEL, level)
    lastUsedThinkingLevel.value = level
  }

  /**
   * 保存单次 run 最大轮次（防工具死循环）。仅接受正整数，非法值拒绝写库。
   * 无需驱逐 Agent：main 侧 turn_end 每轮实时读取，修改后下一轮立即生效。
   */
  async function saveMaxTurnsPerRun(n: number): Promise<void> {
    const v = Math.floor(n)
    if (!Number.isInteger(v) || v <= 0) return
    await mainClient.db.setSetting(SETTING_MAX_TURNS_PER_RUN, v)
    maxTurnsPerRun.value = v
  }

  /**
   * 切换长期记忆开关：写入 settings 并刷新本地状态。
   * 记忆工具始终驻留在 Agent 工具集（schema 稳定、前缀缓存不失效），关闭仅使调用时被
   * 执行层拦截并返回「已停用」提示（见 tools/index.ts 的 wrapGate）——无需驱逐 Agent。
   * 注：开关只影响记忆工具，不影响系统提示词中的记忆段（该段随 Agent 创建时全量注入、会话内固定）。
   */
  async function saveMemoryEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_MEMORY_ENABLED, v)
    memoryEnabled.value = v
  }

  /**
   * 切换本地技能总开关：写入 settings 并刷新本地状态。
   * 技能工具（find_skill/install_skill/read_skill）常驻但执行层掩码，开关即时生效，不驱逐 Agent。
   */
  async function saveSkillsEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_SKILLS_ENABLED, v)
    skillsEnabled.value = v
  }

  /**
   * 切换知识库总开关：写入 settings 并刷新本地状态。
   * search_knowledge 常驻但执行层掩码，开关即时生效，不驱逐 Agent。
   */
  async function saveKbEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_KB_ENABLED, v)
    kbEnabled.value = v
  }

  /**
   * 切换自动压缩开关。无需驱逐 Agent：main 侧 prompt 入口实时读取，
   * 修改后下一条消息立即生效。
   */
  async function saveAutoCompressEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_AUTO_COMPRESS_ENABLED, v)
    autoCompressEnabled.value = v
  }

  /** 保存自动压缩阈值（百分比 50~100）。非法值拒绝写库。 */
  async function saveAutoCompressThreshold(n: number): Promise<void> {
    const v = Math.round(n)
    if (!Number.isFinite(v) || v < 50 || v > 100) return
    await mainClient.db.setSetting(SETTING_AUTO_COMPRESS_THRESHOLD, v)
    autoCompressThreshold.value = v
  }

  async function saveNotificationsEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_NOTIFICATIONS_ENABLED, v)
    notificationsEnabled.value = v
  }

  /**
   * 切换「跳过工具确认」。无需驱逐 Agent：main 侧 permission 钩子实时读取，
   * 修改后下一次工具调用立即生效；破坏性命令不受覆盖，始终人工确认。
   */
  async function savePermissionAutoApprove(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_PERMISSION_AUTO_APPROVE, v)
    permissionAutoApprove.value = v
  }

  /**
   * 保存「工具确认超时」（秒）。仅接受非负整数（0 = 一直等待），非法值拒绝写库。
   * 无需驱逐 Agent：main 侧每次权限请求实时读取；已在等待中的请求按其入队时的
   * expiresAt 生效，新请求按新值生效。
   */
  async function savePermissionTimeoutSec(n: number): Promise<void> {
    const v = Math.floor(n)
    if (!Number.isInteger(v) || v < 0) return
    await mainClient.db.setSetting(SETTING_PERMISSION_TIMEOUT_SEC, v)
    permissionTimeoutSec.value = v
  }

  // ---- bash 沙箱保存 ----

  /** 路径列表规范化：trim + 去重 + 去空项。 */
  function normalizePaths(list: string[]): string[] {
    return [...new Set(list.map((p) => p.trim()).filter((p) => p.length > 0))]
  }

  /**
   * 切换沙箱总开关。
   * 生效边界：沙箱在 shell「spawn 时刻」施加，已在运行的会话不受影响；改后建议
   * 从新会话（或新命令触发自动重建）开始观察。main 侧 readSandboxSettings 实时读取。
   */
  async function saveSandboxEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_SANDBOX_ENABLED, v)
    sandboxEnabled.value = v
  }

  /** 保存用户追加的可写根（工作区目录自动可写，此处仅追加工作区外目录）。 */
  async function saveSandboxWritableRoots(list: string[]): Promise<void> {
    const v = normalizePaths(list)
    await mainClient.db.setSetting(SETTING_SANDBOX_WRITABLE_ROOTS, v)
    sandboxWritableRoots.value = v
  }

  /** 保存禁止读取的目录（默认全局可读，此处做减法）。 */
  async function saveSandboxDenyReadRoots(list: string[]): Promise<void> {
    const v = normalizePaths(list)
    await mainClient.db.setSetting(SETTING_SANDBOX_DENY_READ_ROOTS, v)
    sandboxDenyReadRoots.value = v
  }

  /** 保存网络域名白名单（trim+去重；留空 = 禁止全部外网）。 */
  async function saveSandboxNetworkAllowlist(list: string[]): Promise<void> {
    const v = [...new Set(list.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0))]
    await mainClient.db.setSetting(SETTING_SANDBOX_NETWORK_ALLOWLIST, v)
    sandboxNetworkAllowlist.value = v
  }

  // ---- 语音设置保存 ----

  /** 保存 MiMo 语音 API key（main 进程 safeStorage 加密存储）。 */
  async function saveVoiceApiKey(key: string): Promise<void> {
    await mainClient.voice.setApiKey(key)
    voiceHasApiKey.value = true
  }

  /** 清除 MiMo 语音 API key。 */
  async function clearVoiceApiKey(): Promise<void> {
    await mainClient.voice.clearApiKey()
    voiceHasApiKey.value = false
  }

  /** 测试 MiMo 语音连通性（短文本 TTS）。 */
  async function testVoice(): Promise<{ ok: boolean; error?: string }> {
    return mainClient.voice.test()
  }

  /** 保存语音接入区域。 */
  async function saveVoiceRegion(v: VoiceRegion): Promise<void> {
    await mainClient.db.setSetting(SETTING_VOICE_REGION, v)
    voiceRegion.value = v
  }

  /** 保存 ASR 识别语言。 */
  async function saveVoiceLanguage(v: VoiceLanguage): Promise<void> {
    await mainClient.db.setSetting(SETTING_VOICE_LANGUAGE, v)
    voiceLanguage.value = v
  }

  /** 保存 TTS 音色 id（须为内置音色之一）。变更后清空工具提示语音频缓存，强制按新音色重建。 */
  async function saveVoiceTtsVoice(id: string): Promise<void> {
    if (!VOICE_PRESETS.some((v) => v.id === id)) return
    if (voiceTtsVoice.value !== id) await mainClient.voice.clearTtsCache()
    await mainClient.db.setSetting(SETTING_VOICE_TTS_VOICE, id)
    voiceTtsVoice.value = id
  }

  /** 保存 TTS 风格指令（自然语言描述）。变更后清空工具提示语音频缓存，强制按新风格重建。 */
  async function saveVoiceTtsStyle(style: string): Promise<void> {
    if (voiceTtsStyle.value !== style) await mainClient.voice.clearTtsCache()
    await mainClient.db.setSetting(SETTING_VOICE_TTS_STYLE, style)
    voiceTtsStyle.value = style
  }

  /** 保存 VAD 断句静音阈值（秒，0.1~5）。非法值拒绝写库。 */
  async function saveVoiceSilenceSec(n: number): Promise<void> {
    const v = Math.round(n * 10) / 10
    if (!Number.isFinite(v) || v < 0.1 || v > 5) return
    await mainClient.db.setSetting(SETTING_VOICE_SILENCE_SEC, v)
    voiceSilenceSec.value = v
  }

  /** 切换语音快通道（跳过工具 + 关思考）。无需驱逐 Agent：语音 run 按请求实时生效。 */
  async function saveVoiceFastChannel(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_VOICE_FAST_CHANNEL, v)
    voiceFastChannel.value = v
  }

  /** 切换工具提示语播报。实时生效：朗读前逐次读取，无需缓存失效。 */
  async function saveVoiceToolPhrases(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_VOICE_TOOL_PHRASES, v)
    voiceToolPhrases.value = v
  }

  /**
   * 切换「关闭窗口时最小化到托盘」。无需驱逐 Agent：
   * main 侧窗口 close 时实时读取该设置决定拦截隐藏或放行。
   */
  async function saveCloseToTray(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_CLOSE_TO_TRAY, v)
    closeToTray.value = v
  }

  /**
   * 切换标题栏模式（自定义 / 原生）。main 侧持久化后重建窗口
   *（frame/titleBarStyle 在窗口构造时生效），渲染进程随窗口一起重载。
   */
  async function saveTitleBarMode(mode: TitleBarMode): Promise<void> {
    await mainClient.window.triggerWindowAction(
      mode === 'native' ? 'native-title-bar' : 'cancel-native-title-bar'
    )
    titleBarMode.value = mode
  }

  /**
   * 保存 bash 工具额外环境变量（KEY=VALUE）。
   * 无需驱逐 Agent：bash 每次执行实时读 settings，改后下一轮命令立即生效。
   */
  async function saveAgentEnv(env: Record<string, string>): Promise<void> {
    await mainClient.db.setSetting(SETTING_AGENT_ENV, env)
    agentEnv.value = env
  }

  /**
   * 处理 main 进程广播的设置变更（settingsSync.settingChanged）。
   * 多窗口下任意窗口保存设置后广播，本窗口据此同步内存状态，避免各窗口数据不一致。
   * 仅同步纯设置项；工具列表/技能列表等聚合数据由对应 store 自行管理。
   */
  function handleSettingChanged(key: string, value: unknown): void {
    switch (key) {
      case SETTING_DEFAULT_SYSTEM_PROMPT:
        defaultSystemPrompt.value = (value as string) ?? ''
        break
      case SETTING_DEFAULT_THINKING_LEVEL:
        lastUsedThinkingLevel.value = (value as ThinkingLevel) ?? 'medium'
        break
      case SETTING_MAX_TURNS_PER_RUN:
        maxTurnsPerRun.value = (value as number) ?? DEFAULT_MAX_TURNS_PER_RUN
        break
      case SETTING_NOTIFICATIONS_ENABLED:
        notificationsEnabled.value = value as boolean
        break
      case SETTING_MEMORY_ENABLED:
        memoryEnabled.value = value as boolean
        break
      case SETTING_SKILLS_ENABLED:
        skillsEnabled.value = value as boolean
        break
      case SETTING_KB_ENABLED:
        kbEnabled.value = value as boolean
        break
      case SETTING_AUTO_COMPRESS_ENABLED:
        autoCompressEnabled.value = value as boolean
        break
      case SETTING_AUTO_COMPRESS_THRESHOLD:
        autoCompressThreshold.value = value as number
        break
      case SETTING_CLOSE_TO_TRAY:
        closeToTray.value = value as boolean
        break
      case SETTING_TITLE_BAR_MODE:
        titleBarMode.value = (value as TitleBarMode) ?? 'native'
        break
      case SETTING_AGENT_ENV:
        agentEnv.value = (value as Record<string, string>) ?? {}
        break
      case SETTING_PERMISSION_AUTO_APPROVE:
        permissionAutoApprove.value = value as boolean
        break
      case SETTING_PERMISSION_TIMEOUT_SEC:
        permissionTimeoutSec.value = value as number
        break
      case SETTING_SANDBOX_ENABLED:
        sandboxEnabled.value = value as boolean
        break
      case SETTING_SANDBOX_WRITABLE_ROOTS:
        sandboxWritableRoots.value = (value as string[] | undefined) ?? []
        break
      case SETTING_SANDBOX_DENY_READ_ROOTS:
        sandboxDenyReadRoots.value = (value as string[] | undefined) ?? []
        break
      case SETTING_SANDBOX_NETWORK_ALLOWLIST:
        sandboxNetworkAllowlist.value = (value as string[] | undefined) ?? []
        break
      case SETTING_VOICE_REGION:
        voiceRegion.value = (value as VoiceRegion) ?? DEFAULT_VOICE_REGION
        break
      case SETTING_VOICE_API_KEY:
        // key 以加密 base64 广播，仅更新「是否已配置」标记
        voiceHasApiKey.value = !!value
        break
      case SETTING_VOICE_LANGUAGE:
        voiceLanguage.value = (value as VoiceLanguage) ?? DEFAULT_VOICE_LANGUAGE
        break
      case SETTING_VOICE_TTS_VOICE:
        voiceTtsVoice.value = (value as string) ?? DEFAULT_VOICE_TTS_VOICE
        break
      case SETTING_VOICE_TTS_STYLE:
        voiceTtsStyle.value = (value as string) ?? ''
        break
      case SETTING_VOICE_SILENCE_SEC:
        voiceSilenceSec.value = (value as number) ?? DEFAULT_VOICE_SILENCE_SEC
        break
      case SETTING_VOICE_FAST_CHANNEL:
        voiceFastChannel.value = (value as boolean) ?? DEFAULT_VOICE_FAST_CHANNEL
        break
      case SETTING_VOICE_TOOL_PHRASES:
        voiceToolPhrases.value = (value as boolean) ?? DEFAULT_VOICE_TOOL_PHRASES
        break
    }
  }

  /**
   * 切换某工具的启用状态：写回全量覆盖（toolName → enabled）并刷新内存列表。
   * 工具 schema 常驻（buildTools 固定注入集合），关闭只切换执行层掩码，即时生效、无需驱逐 Agent。
   */
  async function saveToolEnabled(name: string, enabled: boolean): Promise<void> {
    const overrides: Record<string, boolean> = {}
    for (const t of tools.value) overrides[t.name] = t.enabled
    overrides[name] = enabled
    await mainClient.db.setSetting(SETTING_ENABLED_TOOLS, overrides)
    const target = tools.value.find((t) => t.name === name)
    if (target) target.enabled = enabled
  }

  /** 保存 Tavily API Key（main 进程加密存储，renderer 只记录已配置状态）。 */
  async function saveWebSearchApiKey(key: string): Promise<void> {
    await mainClient.agent.setWebSearchApiKey(key)
    webSearchKeyConfigured.value = true
  }

  /** 清除 Tavily API Key。 */
  async function clearWebSearchApiKey(): Promise<void> {
    await mainClient.agent.clearWebSearchApiKey()
    webSearchKeyConfigured.value = false
  }

  /** 测试 Tavily 连通性（未传 key 用已保存 key）。 */
  async function testWebSearch(key?: string): Promise<{ ok: boolean; error?: string }> {
    return mainClient.agent.testWebSearch(key)
  }

  /** 切换技能搜索数据源（main 进程持久化；工具执行时实时读取，无需驱逐 Agent）。 */
  async function saveFindSkillSource(source: FindSkillSource): Promise<void> {
    await mainClient.agent.setFindSkillSource(source)
    findSkillSource.value = source
  }

  /** 测试指定数据源的连通性。 */
  async function testFindSkill(source: FindSkillSource): Promise<{ ok: boolean; error?: string }> {
    return mainClient.agent.testFindSkill(source)
  }

  /** 启停已安装技能（仅更新 manifest 记录；Agent 通过 read_skill 动态发现，即时生效）。 */
  async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = await mainClient.agent.setSkillEnabled(id, enabled)
    const target = installedSkills.value.find((s) => s.id === id)
    if (target) {
      target.enabled = entry.enabled
    }
  }

  /** 卸载已安装技能（删除本地目录与 manifest 记录）。 */
  async function uninstallSkill(id: string): Promise<void> {
    await mainClient.agent.uninstallSkill(id)
    installedSkills.value = installedSkills.value.filter((s) => s.id !== id)
  }

  /** 打开技能根目录（系统文件管理器）。 */
  async function openSkillsDir(): Promise<void> {
    await mainClient.agent.openSkillsDir()
  }

  return {
    defaultSystemPrompt,
    lastUsedThinkingLevel,
    maxTurnsPerRun,
    tools,
    webSearchKeyConfigured,
    findSkillSource,
    installedSkills,
    memoryEnabled,
    skillsEnabled,
    kbEnabled,
    autoCompressEnabled,
    autoCompressThreshold,
    notificationsEnabled,
    closeToTray,
    titleBarMode,
    agentEnv,
    permissionAutoApprove,
    permissionTimeoutSec,
    sandboxEnabled,
    sandboxWritableRoots,
    sandboxDenyReadRoots,
    sandboxNetworkAllowlist,
    voiceHasApiKey,
    voiceRegion,
    voiceLanguage,
    voiceTtsVoice,
    voiceTtsStyle,
    voiceSilenceSec,
    voiceFastChannel,
    voiceToolPhrases,
    loadSettings,
    saveDefaultSystemPrompt,
    applyDefaultSystemPromptToAll,
    setLastUsedThinkingLevel,
    saveMaxTurnsPerRun,
    saveNotificationsEnabled,
    savePermissionAutoApprove,
    savePermissionTimeoutSec,
    saveSandboxEnabled,
    saveSandboxWritableRoots,
    saveSandboxDenyReadRoots,
    saveSandboxNetworkAllowlist,
    saveVoiceApiKey,
    clearVoiceApiKey,
    testVoice,
    saveVoiceRegion,
    saveVoiceLanguage,
    saveVoiceTtsVoice,
    saveVoiceTtsStyle,
    saveVoiceSilenceSec,
    saveVoiceFastChannel,
    saveVoiceToolPhrases,
    saveMemoryEnabled,
    saveSkillsEnabled,
    saveKbEnabled,
    saveAutoCompressEnabled,
    saveAutoCompressThreshold,
    saveCloseToTray,
    saveTitleBarMode,
    saveAgentEnv,
    handleSettingChanged,
    saveToolEnabled,
    saveWebSearchApiKey,
    clearWebSearchApiKey,
    testWebSearch,
    saveFindSkillSource,
    testFindSkill,
    setSkillEnabled,
    uninstallSkill,
    openSkillsDir
  }
})
