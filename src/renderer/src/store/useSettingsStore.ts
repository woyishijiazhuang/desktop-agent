import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import { useSessionStore } from './useSessionStore'
import type {
  FindSkillSource,
  InstalledSkill,
  ThinkingLevel,
  TitleBarMode,
  ToolInfo
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
  DEFAULT_MAX_TURNS_PER_RUN,
  DEFAULT_FIND_SKILL_SOURCE,
  DEFAULT_AUTO_COMPRESS_ENABLED,
  DEFAULT_AUTO_COMPRESS_THRESHOLD
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
 * 此处不再持有 provider/model/默认模型状态。保存后驱逐当前会话的内存 Agent，使新设置下一轮生效。
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
  /** 关闭窗口时最小化到托盘（默认关闭：关窗即退出/关闭窗口）。 */
  const closeToTray = ref(false)
  /** 标题栏模式（默认 native：优先当前平台原生窗口栏）。 */
  const titleBarMode = ref<TitleBarMode>('native')
  /**
   * Agent 工作目录（当前生效值，含默认回退：settings 配置 > 开发项目根 / 生产用户主目录）。
   * bash 默认 cwd 每次执行实时读取；已建会话提示词快照不受影响，仅新会话首次创建 Agent 时按此生成。
   */
  const workdir = ref<string>('')
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
      workdirVal,
      agentEnvVal
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
      mainClient.agent.getWorkdir(),
      mainClient.db.getSetting(SETTING_AGENT_ENV)
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
    workdir.value = (workdirVal as string | undefined) ?? ''
    agentEnv.value = (agentEnvVal as Record<string, string> | undefined) ?? {}
  }

  /** 保存后驱逐当前会话的内存 Agent，使新设置在下一轮生效。 */
  async function evictCurrentAgent(): Promise<void> {
    const sessionId = useSessionStore().currentSessionId
    if (sessionId) {
      await mainClient.agent.evictSession(sessionId)
    }
  }

  /**
   * 保存默认系统提示并驱逐当前会话 Agent。
   * 同时清空全部会话已固化的最终提示词快照：快照优先复用，若不失效，
   * 旧会话会永远沿用旧默认提示词（resolved_system_prompt 逻辑见 agent-manager.createAgent）。
   */
  async function saveDefaultSystemPrompt(prompt: string): Promise<void> {
    await mainClient.db.setSetting(SETTING_DEFAULT_SYSTEM_PROMPT, prompt)
    await mainClient.db.clearResolvedSystemPrompts()
    defaultSystemPrompt.value = prompt
    await evictCurrentAgent()
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
   * 切换长期记忆开关：写入 settings，并驱逐当前会话 Agent，
   * 使记忆工具（list/add/update/delete_memory）在下一轮从 Agent 工具集中移除/恢复。
   * 注意：开关只影响记忆工具，不影响系统提示词中的记忆段（该段随 Agent 创建时全量注入、会话内固定）。
   */
  async function saveMemoryEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_MEMORY_ENABLED, v)
    memoryEnabled.value = v
    await evictCurrentAgent()
  }

  /**
   * 切换本地技能总开关：写入 settings，并驱逐当前会话 Agent，
   * 使技能域工具（find_skill/install_skill/read_skill）在下一轮从 Agent 工具集中移除/恢复。
   */
  async function saveSkillsEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_SKILLS_ENABLED, v)
    skillsEnabled.value = v
    await evictCurrentAgent()
  }

  /**
   * 切换知识库总开关：写入 settings，并驱逐当前会话 Agent，
   * 使知识库检索工具（search_knowledge）在下一轮从 Agent 工具集中移除/恢复。
   */
  async function saveKbEnabled(v: boolean): Promise<void> {
    await mainClient.db.setSetting(SETTING_KB_ENABLED, v)
    kbEnabled.value = v
    await evictCurrentAgent()
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
   * 保存 Agent 工作目录（settings 表持久化）。
   * 不驱逐 Agent、不清提示词快照：bash 默认 cwd 每次执行实时读取，立即生效；
   * 已有消息的会话提示词保持原样，仅新会话首次创建 Agent 时按新目录生成。
   */
  async function saveWorkdir(dir: string): Promise<void> {
    const v = dir.trim()
    if (!v) return
    await mainClient.agent.setWorkdir(v)
    workdir.value = v
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
   * 切换某工具的启用状态：写回全量覆盖（toolName → enabled），
   * 刷新内存工具列表，并驱逐当前会话 Agent 使新工具集下一轮生效。
   */
  async function saveToolEnabled(name: string, enabled: boolean): Promise<void> {
    const overrides: Record<string, boolean> = {}
    for (const t of tools.value) overrides[t.name] = t.enabled
    overrides[name] = enabled
    await mainClient.db.setSetting(SETTING_ENABLED_TOOLS, overrides)
    const target = tools.value.find((t) => t.name === name)
    if (target) target.enabled = enabled
    await evictCurrentAgent()
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
    workdir,
    agentEnv,
    loadSettings,
    saveDefaultSystemPrompt,
    setLastUsedThinkingLevel,
    saveMaxTurnsPerRun,
    saveNotificationsEnabled,
    saveMemoryEnabled,
    saveSkillsEnabled,
    saveKbEnabled,
    saveAutoCompressEnabled,
    saveAutoCompressThreshold,
    saveCloseToTray,
    saveTitleBarMode,
    saveWorkdir,
    saveAgentEnv,
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
