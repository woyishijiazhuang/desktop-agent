import type { AgentEvent } from '@earendil-works/pi-agent-core'
export type {
  ModelConfigSource,
  ApiFormat,
  ModelConfigSummary,
  CreateModelConfigInput,
  UpdateModelConfigInput,
  PresetProviderInfo,
  PresetModelInfo,
  PresetModelCost,
  ModelPricing,
  ModelPeakPeriod
} from './model-config'

/**
 * 思考级别（与 pi-agent-core 的 ThinkingLevel 对齐，结构相同故可互相赋值）。
 * pi-agent-core 未从包根直接导出 ThinkingLevel，此处本地定义用于 settings 读写。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 全部合法思考级别（校验 session/settings 读出的值用）。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** 判断值是否为合法思考级别（DB/settings 读出的未知字符串 → 回退）。 */
export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v)
}

/**
 * Agent 事件转发 payload。
 * main 进程 Agent.subscribe 收到事件后，整体包装为该结构推给 renderer。
 * renderer 的 AgentEventService.onEvent 据此 dispatch 到 useChatStore。
 */
export interface AgentEventPayload {
  sessionId: string
  event: AgentEvent
  /**
   * agent_end 时若本次 run 真实失败（非用户主动中止），携带 agent.state.errorMessage，
   * 供 renderer 弹错误提示。中止（aborted）不携带，避免打扰。
   */
  error?: string
}

/**
 * 权限确认回执的作用域（renderer 批量条选择后回传）。
 * - once：仅本次放行
 * - session：本会话内对相同/相似命令或同一路径放行
 * - always：加入持久白名单（仅 bash 且未命中破坏性命令时允许）
 * - batch：对「同一条 assistant 消息内的整批危险工具」统一放行或统一拒绝
 *   （approved=true 自动放行批内剩余工具；false 自动拒绝批内剩余工具；
 *   进入下一条消息即失效；破坏性命令始终强制单独确认，不受 batch 放行覆盖）
 * - batch-session：整批统一放行，并把批内每条命令/路径记入本会话放行
 * - batch-always：整批统一放行，并把批内每条 bash 非破坏性命令加入持久白名单
 */
export type PermissionScope =
  'once' | 'session' | 'always' | 'batch' | 'batch-session' | 'batch-always'

/** 待确认批中的单个操作摘要（main 侧生成，renderer 批量条一次列全供用户决策）。 */
export interface PermissionBatchItem {
  toolName: string
  /** 对应 assistant 消息中 toolCall 块 id（renderer 关联卡片用）。 */
  toolCallId: string
  /** 一行摘要：bash=命令原文，write/edit=路径，install_skill=技能标识。 */
  summary: string
  /** 是否命中破坏性模式（deny 提示；且不受 batch 自动放行覆盖）。 */
  denyHit: boolean
}

/**
 * 危险工具执行前的权限确认请求。
 * main 通过 rendererClient.agentEvent.onPermissionRequest 推给 renderer，
 * renderer 在批量条上一次列全本条消息的待确认操作后调 mainClient.agent.respondPermission 回传结果。
 */
export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  /** 对应 assistant 消息流中 toolCall 块的 id：renderer 据此把「等待确认」挂到具体的工具卡片上。 */
  toolCallId: string
  args: unknown
  /** 是否命中破坏性命令模式（deny）：为 true 时 UI 不提供「总是允许」，防止白名单绕过 deny 兜底。 */
  denyHit: boolean
  /**
   * 本条 assistant 消息中需要人工确认的全部危险工具（含当前请求）。
   * beforeToolCall 串行逐个到达，但批量条据此一次展示整批的命令/路径，供一次性决策。
   */
  batch: PermissionBatchItem[]
  /**
   * 超时截止时间（epoch ms）：到点 main 侧自动拒绝；0 = 一直等待（不超时）。
   * renderer 据此在批量条上显示倒计时，并同步清理本地队列。
   */
  expiresAt: number
}

/**
 * settings 表中存储的「跳过工具确认」开关 key（boolean，默认 false）。
 * 开启后危险工具（write_file / edit_file / bash / install_skill）免确认直接放行；
 * 破坏性命令（deny 兜底）不受覆盖，始终人工确认。permission 钩子实时读取，改后下一轮立即生效。
 */
export const SETTING_PERMISSION_AUTO_APPROVE = 'permission.autoApprove'

/**
 * settings 表中存储的「工具确认超时」key（秒，默认 60）。
 * 等待用户确认的最长时间，超时自动拒绝；0 = 一直等待。permission 钩子实时读取。
 */
export const SETTING_PERMISSION_TIMEOUT_SEC = 'permission.timeoutSec'

/** 工具确认超时默认值（秒）。 */
export const DEFAULT_PERMISSION_TIMEOUT_SEC = 60

/**
 * 计划审批请求（exit_plan_mode 提交计划后 main 推给 renderer 展示）。
 * renderer 在计划卡片上批准/拒绝后调 agent.respondPlan 回传。
 */
export interface PlanApprovalRequest {
  requestId: string
  sessionId: string
  /** 计划标题（简短概括）。 */
  title: string
  /** 完整计划文本（分步、可执行，供用户审阅）。 */
  plan: string
  /**
   * 计划中预登记的 bash 命令（词级前缀匹配）：批准后本 run 内执行期免确认。
   * 破坏性命令（deny 兜底）始终人工确认，不受预批准覆盖。
   */
  allowedPrompts: string[]
}

/** 结构化问题的一个选项。 */
export interface AskUserOption {
  label: string
  value: string
}

/**
 * ask_user 提问请求（工具调用后 main 推给 renderer 展示）。
 * renderer 在问答卡片上作答后调 agent.respondAskUser 回传；超时（expiresAt）自动按「跳过」处理。
 */
export interface AskUserRequest {
  requestId: string
  sessionId: string
  /** 问题文本（必填）。 */
  question: string
  /** 预置选项（可选）：UI 以选项卡片展示，用户点选或自由输入。 */
  options: AskUserOption[]
  /** 是否允许多选（仅对选项生效；自由输入总是单值）。 */
  multiSelect: boolean
  /** 是否必答：为 true 时用户不能跳过（只能选择/输入后提交）。 */
  required: boolean
  /** 超时截止时间（epoch ms）：到点 main 侧自动按「跳过」处理；0 = 一直等待。 */
  expiresAt: number
}

/**
 * 模型定位键：{provider, id} 二元组。
 * provider 为 model_configs.id（config id），id 为 model_id。
 * 序列化为 JSON 字符串存入 settings.defaultModel（上次使用）/ session.model（TEXT 列）。
 */
export interface ModelKey {
  provider: string
  id: string
}

/** 将 ModelKey 序列化为可存储的字符串。 */
export function formatModelKey(key: ModelKey): string {
  return JSON.stringify(key)
}

/**
 * 解析存储的模型键字符串为 ModelKey。
 * 合法 JSON {provider,id} → 返回；空值 → null（未设置，调用方回退到默认）。
 * 不再兼容旧版纯 id 字符串：非 JSON 输入将抛错。
 */
export function parseModelKey(raw: string | null | undefined): ModelKey | null {
  if (!raw) return null
  const o = JSON.parse(raw) as unknown
  if (
    o &&
    typeof o === 'object' &&
    typeof (o as ModelKey).provider === 'string' &&
    typeof (o as ModelKey).id === 'string'
  ) {
    return o as ModelKey
  }
  return null
}

/** settings 表中存储的「上次使用模型」key（语义：新建会话沿用此项）。 */
export const SETTING_DEFAULT_MODEL = 'defaultModel'
export const SETTING_DEFAULT_SYSTEM_PROMPT = 'defaultSystemPrompt'
/** settings 表中存储的「上次使用思考级别」key（语义：新建会话继承最近一次手动选择）。 */
export const SETTING_DEFAULT_THINKING_LEVEL = 'defaultThinkingLevel'

/** settings 表中存储的「关闭窗口时最小化到托盘」key（默认关闭：关窗即退出/关闭）。 */
export const SETTING_CLOSE_TO_TRAY = 'window.closeToTray'

/** 标题栏模式：native = 平台原生（macOS 红绿灯 / Windows·Linux 系统标题栏）；custom = 自绘标题栏。 */
export type TitleBarMode = 'custom' | 'native'
/** settings 表中存储的「标题栏模式」key（默认 native：优先使用当前平台的原生窗口栏）。 */
export const SETTING_TITLE_BAR_MODE = 'window.titleBarMode'

/** 主题模式：对齐 nativeTheme.themeSource（light / dark / system）。 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** settings 表中存储的「主题模式」key（默认 system）。主进程以此为唯一真源驱动 nativeTheme。 */
export const SETTING_THEME_MODE = 'appearance.theme'

/** settings 表中存储的「桌面通知」开关 key（默认开启；关闭后不弹系统通知）。 */
export const SETTING_NOTIFICATIONS_ENABLED = 'notificationsEnabled'

/** settings 表中存储的「长期记忆」开关 key（控制记忆工具可用性；记忆注入不受影响，默认开启）。 */
export const SETTING_MEMORY_ENABLED = 'memoryEnabled'

/** settings 表中存储的「本地技能」总开关 key（技能工具注入，默认开启）。 */
export const SETTING_SKILLS_ENABLED = 'skillsEnabled'

/** settings 表中存储的「知识库」总开关 key（知识库检索工具注入，默认开启）。 */
export const SETTING_KB_ENABLED = 'kbEnabled'

/** settings 表中存储的「知识库 embedding 配置」key（JSON，见 knowledge-service 的 KbEmbeddingSettings）。 */
export const SETTING_KB_EMBEDDING_CONFIG = 'kb.embeddingConfig'

/** settings 表中存储的「单次 run 最大轮次」key（防工具死循环，默认 DEFAULT_MAX_TURNS_PER_RUN）。 */
export const SETTING_MAX_TURNS_PER_RUN = 'maxTurnsPerRun'

/**
 * settings 表中存储的「自动压缩」开关与阈值 key：
 * 发送消息前估算未压缩上下文的 token 量，达到模型窗口的阈值百分比时静默摘要旧历史。
 */
export const SETTING_AUTO_COMPRESS_ENABLED = 'autoCompressEnabled'
export const SETTING_AUTO_COMPRESS_THRESHOLD = 'autoCompressThreshold'

/** 自动压缩默认值：开启，未压缩上下文达到窗口 75% 时触发。 */
export const DEFAULT_AUTO_COMPRESS_ENABLED = true
export const DEFAULT_AUTO_COMPRESS_THRESHOLD = 75

/**
 * 技能搜索（find_skill）可选的数据源。
 * - byte：字节跳动火山引擎 Find Skill（findskill.com，开放 API skills.volces.com/v1）
 * - tencent：腾讯云 SkillHub（skillhub.cn，开放 API api.skillhub.cn）
 */
export type FindSkillSource = 'byte' | 'tencent'

/** 数据源展示名（renderer 设置页选择器用）。 */
export const FIND_SKILL_SOURCE_LABELS: Record<FindSkillSource, string> = {
  byte: '字节 Find Skill',
  tencent: '腾讯 SkillHub'
}

/** 数据源主页（renderer 设置页跳转用）。 */
export const FIND_SKILL_SOURCE_HOMEPAGES: Record<FindSkillSource, string> = {
  byte: 'https://findskill.com/',
  tencent: 'https://skillhub.cn/skills'
}

/** settings 表中存储的「技能搜索数据源」key。 */
export const SETTING_FIND_SKILL_SOURCE = 'findSkillSource'

/** settings 表中存储的「Agent 工作目录」key。
 * 值为绝对路径；未配置时回退到 resolveAgentWorkdir 的默认值
 * （开发环境 = 项目根 process.cwd()，生产 = 用户主目录 app.getPath('home')）。
 * Agent 系统提示的能力指引（工作目录行）与 bash 工具默认 cwd 均读取该项。
 */
export const SETTING_AGENT_WORKDIR = 'agent.workdir'

/** settings 表中存储的「欢迎页最近一批 AI 建议」key（string[]）。
 * 新会话优先展示该批建议（跨会话/重启复用），点「换一批」才重新生成并覆盖。
 */
export const SETTING_WELCOME_SUGGESTIONS = 'welcomeSuggestions'

/** settings 表中存储的「bash 工具额外环境变量」key（Record<string, string>）。
 * 用户手动配置、独立于 shell 环境的变量；bash 子进程最终环境 =
 * 应用自身 process.env < 自动抓取的 shell 环境（getShellEnv） < 此处手动配置。
 */
export const SETTING_AGENT_ENV = 'agent.env'

/** 未配置时的默认数据源。 */
export const DEFAULT_FIND_SKILL_SOURCE: FindSkillSource = 'byte'

/**
 * 已安装技能条目（skills 目录 manifest.json 中的一条）。
 * 技能落盘于 {userData}/skills/{id}/（标准 Agent Skills 结构：SKILL.md + 可选 scripts/references）。
 * 跨进程共享：renderer 技能管理页展示用，main 侧由 skills-store 维护。
 */
export interface InstalledSkill {
  /** 技能目录名（唯一标识，也是 manifest 中技能条目的 id）。 */
  id: string
  /** 技能名（SKILL.md frontmatter name，缺失时回退到 slug 末段）。 */
  name: string
  /** 一句话用途说明（SKILL.md frontmatter description / 平台返回的 description）。 */
  description: string
  /** 来源平台。 */
  source: FindSkillSource
  /** 平台侧完整技能标识（如 volcengine/las/byted-las-pdf-parse-doubao）。 */
  slug: string
  /** 版本号（解析自 SKILL.md frontmatter，缺失时为空）。 */
  version: string
  /** 平台展示的下载量（仅展示用）。 */
  downloads: number
  /** 详情页链接（仅展示用）。 */
  homepage?: string
  /** 安装时间（ms）。 */
  installedAt: number
  /** 是否启用：停用后 Agent 无法发现（read_skill 清单）也无法读取该技能，聊天框亦不可选择。 */
  enabled: boolean
  /** 技能目录中的文件总数（含 SKILL.md）。 */
  fileCount: number
  /**
   * 是否存在 SKILL.md 之外的文件（scripts/ 等）。
   * 字节来源仅落 SKILL.md 文本（平台未开放完整包下载），为 true 时表示脚本未随包安装。
   */
  hasExtraFiles: boolean
}

/** 未配置最大轮次时的默认值（一轮 = 一次模型调用）。 */
export const DEFAULT_MAX_TURNS_PER_RUN = 40

/** 达到最大轮次自动中止时推给 renderer 的错误提示（展示实际配置值）。 */
export function maxTurnsReachedMessage(maxTurns: number): string {
  return `已达最大轮次限制（${maxTurns} 轮），已自动停止。建议简化任务或分段进行。`
}

/**
 * 构建内置系统提示的「能力指引」部分：当前环境 + 工作方式 + 回答风格 + 图表输出。
 * 用户设置了自定义系统提示词时，这些运行事实与能力指引仍会无条件追加在其后
 *（见 agent-manager.createAgent 的拼接逻辑），避免自定义提示词覆盖必要的
 * 环境信息（操作系统/时间/工作目录）与 echarts 等能力指引。
 *
 * @param workdir 显式工作目录（Agent 主进程从 settings 解析后传入）。
 *                为空时回退到 process.cwd()（渲染进程无 process.cwd 时为 ''，
 *                供设置页占位符展示使用）。
 * @param shellKind 主进程探测到的实际持久 shell（resolveShell().kind）。传入时
 *                  「当前环境」的 Shell 行展示确切结果（bash / PowerShell）；
 *                  渲染进程不传，按平台给出通用描述（设置页占位符使用）。
 */
export function buildSystemCapabilitySections(
  workdir?: string,
  shellKind?: 'bash' | 'powershell'
): string {
  const { platform, arch } = detectPlatform()
  const cwd =
    workdir ||
    (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '')
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''

  const sections: (string | string[])[] = [
    [
      '## 当前环境',
      `- 操作系统：${platform ? `${platformName(platform)}${arch ? `（${arch}）` : ''}` : '未知'}`,
      `- Shell：${shellKind ? shellExactName(shellKind) : shellDesc(platform)}（命令语法必须匹配该 shell，不要在 PowerShell 上用 bash 专有语法）`,
      `- 当前时间：${now.toLocaleString('zh-CN', { hour12: false })}（时区 ${tz || '未知'}）`,
      cwd ? `- 工作目录：${cwd}` : ''
    ],
    [
      '## 工作方式',
      '- 当任务需要查询文件、执行命令或获取外部信息时，优先调用对应工具，不要凭空猜测。',
      '- bash 工具默认 30 秒超时，可用其 timeout_ms 参数按命令调整；长驻命令（如 npm run dev、长测试）改用 background=true 后台启动，配合 bash_output 读输出、kill_shell 终止。交互式命令（提示确认/密码、REPL）也用 background=true 启动，用 bash_input 写入应答、bash_output 读结果；「读输入到结尾」的命令（如裸 cat/sort）用 bash_input end=true 发送 EOF。命令在同一持久化会话中执行，cd（PowerShell 为 Set-Location）/环境变量设置会保留。',
      '- 删除、覆盖、写文件、执行命令等操作可能需要用户确认，等待确认后再继续。',
      '- 工具返回大量输出时，只提取与任务相关的部分，不要原样重复给用户。'
    ],
    [
      '## 回答风格',
      '- 默认使用中文回答；用户使用其他语言时跟随用户。',
      '- 先给结论再给细节；保持简洁，长内容用列表或小标题组织。',
      '- 对不确定的事实、路径、命令结果明确说明不确定性，绝不编造。'
    ],
    [
      '## 图表输出',
      '- 当数据适合可视化呈现（趋势、对比、占比、分布等）时，用 echarts 代码块输出一个完整的 ECharts 配置对象。',
      '- echarts 代码块必须是合法的纯 JSON 对象：不写注释、不包含函数或 JS 代码，例如：\n```echarts\n{"title": {"text": "月度销量"}, "xAxis": {"type": "category", "data": ["一月", "二月", "三月"]}, "yAxis": {"type": "value"}, "series": [{"type": "bar", "data": [120, 200, 150]}]}\n```',
      '- 尽量给出完整配置（title、tooltip、legend、series 等）；可用 "height": 320 指定图表高度（像素）。'
    ]
  ]

  return sections
    .map((section) => (Array.isArray(section) ? section.filter(Boolean).join('\n') : section))
    .join('\n\n')
}

/**
 * 构建内置默认系统提示词：角色定位 + 能力指引。
 * 用户未自定义（settings 为空）时的回退文本，渲染进程设置页在留空时展示其实际内容。
 * @param workdir 显式工作目录，透传给 buildSystemCapabilitySections（主进程调用时传入）。
 * @param shellKind 实际持久 shell（主进程调用时传入，见 buildSystemCapabilitySections）。
 */
export function buildDefaultSystemPrompt(
  workdir?: string,
  shellKind?: 'bash' | 'powershell'
): string {
  return [
    '你是一个运行在用户桌面上的智能助手，可以调用工具帮助用户完成文件读写、命令执行、网页搜索等任务。',
    buildSystemCapabilitySections(workdir, shellKind)
  ].join('\n\n')
}

/**
 * 探测当前操作系统与架构。
 * - 主进程：process.platform / process.arch 可靠，直接使用。
 * - 渲染进程：electron-vite 注入的 process 仅有 env 子集（process.platform 为 undefined），
 *   回退到 navigator.userAgent 识别，避免设置页占位符显示「未知」。
 */
function detectPlatform(): { platform: string; arch: string } {
  if (typeof process !== 'undefined' && process.platform) {
    return {
      platform: process.platform,
      arch: typeof process.arch === 'string' ? process.arch : ''
    }
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent
    const arch = /arm64|aarch64/i.test(ua) ? 'arm64' : /x64|win64|wow64/i.test(ua) ? 'x64' : ''
    if (/Windows/.test(ua)) return { platform: 'win32', arch }
    if (/Mac OS X|Macintosh/.test(ua)) return { platform: 'darwin', arch }
    if (/Android/.test(ua)) return { platform: 'android', arch }
    if (/iPhone|iPad|iPod/.test(ua)) return { platform: 'ios', arch }
    if (/Linux/.test(ua)) return { platform: 'linux', arch }
  }
  return { platform: '', arch: '' }
}

/**
 * 当前持久化 shell 描述（与 bash-session.resolveShell 的选择逻辑对应）：
 * - macOS/Linux：bash
 * - Windows：PATH 有 bash（Git Bash）时为 bash，否则 PowerShell
 * 渲染进程无 process.platform 时返回通用描述（该分支仅设置页占位符使用）。
 */
function shellDesc(platform: string): string {
  if (platform === 'darwin' || platform === 'linux') return 'bash'
  if (platform === 'win32') {
    return typeof process !== 'undefined' && process.platform === 'win32'
      ? `bash 或 PowerShell（以 bash 工具实际启动为准，见其返回信息）`
      : 'bash 或 PowerShell'
  }
  return '未知'
}

/** resolveShell().kind → 提示词中的确切 shell 名称。 */
function shellExactName(kind: 'bash' | 'powershell'): string {
  return kind === 'bash' ? 'bash' : 'PowerShell'
}

/** process.platform / navigator 识别值 → 用户可读的 OS 名称。 */
function platformName(p: string): string {
  switch (p) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'android':
      return 'Android'
    case 'ios':
      return 'iOS'
    default:
      return p
  }
}

/**
 * settings 表中存储的工具启用状态 key。
 * 值为 Record<toolName, boolean>，仅记录用户显式覆盖；未记录的工具走默认值。
 */
export const SETTING_ENABLED_TOOLS = 'enabledTools'

/** 工具信息（renderer 工具开关 UI 用，不含工具实现，避免跨进程类型耦合）。 */
export interface ToolInfo {
  name: string
  label: string
  description: string
  enabled: boolean
}
