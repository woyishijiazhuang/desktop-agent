import type { DatabaseSync } from 'node:sqlite'
import type { SettingRow } from './types'

/**
 * settings 表写入白名单 + 值类型校验。
 * key 与各模块导出的常量一一对应（agent/types.ts、window-service.ts、web-search-config.ts），
 * 集中注册防止拼写错误 / 意外 key 写脏数据；未知 key 或类型不符直接抛错拒绝写入。
 */
const SETTING_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  /** 上次使用模型（ModelKey 的 JSON 字符串，见 formatModelKey）。 */
  defaultModel: (v) => typeof v === 'string',
  defaultSystemPrompt: (v) => typeof v === 'string',
  /** 上次使用思考级别（ThinkingLevel 字符串，读写两侧均按枚举校验；新建会话继承）。 */
  defaultThinkingLevel: (v) => typeof v === 'string',
  /** 单次 run 最大轮次（正整数）。 */
  maxTurnsPerRun: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  /** 工具启用覆盖（toolName → boolean 的对象）。 */
  enabledTools: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'boolean'),
  /** Tavily API Key（safeStorage 加密后的 base64 字符串）。 */
  webSearchApiKey: (v) => typeof v === 'string',
  /** 技能搜索（find_skill）数据源：字节 Find Skill / 腾讯 SkillHub。 */
  findSkillSource: (v) => v === 'byte' || v === 'tencent',
  /** 桌面通知开关（默认开启）。 */
  notificationsEnabled: (v) => typeof v === 'boolean',
  /** 长期记忆开关（控制记忆读写工具是否可用；记忆注入不受此开关影响）。 */
  memoryEnabled: (v) => typeof v === 'boolean',
  /** 本地技能总开关（技能工具注入）。 */
  skillsEnabled: (v) => typeof v === 'boolean',
  /** 知识库总开关（知识库检索工具注入）。 */
  kbEnabled: (v) => typeof v === 'boolean',
  /** 知识库 embedding 配置（JSON 字符串，见 knowledge-service 的 KbEmbeddingSettings）。 */
  'kb.embeddingConfig': (v) => typeof v === 'string',
  /** 自动压缩开关（boolean）与阈值（0~100 的百分比数值）。 */
  autoCompressEnabled: (v) => typeof v === 'boolean',
  autoCompressThreshold: (v) => typeof v === 'number' && v > 0 && v <= 100,
  /** 窗口置顶偏好。 */
  'window.alwaysOnTop': (v) => typeof v === 'boolean',
  /** 关闭窗口时最小化到托盘（默认关闭）。 */
  'window.closeToTray': (v) => typeof v === 'boolean',
  /** 标题栏模式：custom 自绘 / native 平台原生（macOS 红绿灯、Windows·Linux 系统标题栏）。 */
  'window.titleBarMode': (v) => v === 'custom' || v === 'native',
  /** 主题模式：light / dark / system（主进程 nativeTheme.themeSource 唯一真源）。 */
  'appearance.theme': (v) => v === 'light' || v === 'dark' || v === 'system',
  /** bash 持久白名单（权限弹窗点「总是允许」的命令，string[]）。 */
  bashAllowlist: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  /** 跳过工具确认（危险工具免确认；破坏性命令除外，见 agent/types.ts SETTING_PERMISSION_AUTO_APPROVE）。 */
  'permission.autoApprove': (v) => typeof v === 'boolean',
  /** 工具确认超时（秒；0 = 一直等待，见 agent/types.ts SETTING_PERMISSION_TIMEOUT_SEC）。 */
  'permission.timeoutSec': (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  /** 上次退出时打开的工作区窗口（string[]，见 window-manager.ts SETTING_OPEN_WORKSPACES）。 */
  'workspace.openWindows': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  /** 欢迎页最近一批 AI 建议（string[]，见 agent/types.ts SETTING_WELCOME_SUGGESTIONS）。 */
  welcomeSuggestions: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  /** agent.md 注入系统提示词的上限（字符数，正整数；见 agent/types.ts SETTING_AGENT_MD_INJECTION_CHARS）。 */
  'agent.agentMdInjectionChars': (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  /** bash 工具额外环境变量（Record<string, string>，见 agent/types.ts SETTING_AGENT_ENV）。 */
  'agent.env': (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(
      ([k, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof val === 'string'
    )
}

/** 设置项域 API（index.ts 组装进 db 门面）。 */
export interface SettingsApi {
  getSetting<T = unknown>(key: string): T | undefined
  setSetting(key: string, value: unknown): void
  deleteSetting(key: string): void
}

/** 设置项（JSON 值）读写。 */
export function createSettingsApi(db: DatabaseSync): SettingsApi {
  return {
    getSetting<T = unknown>(key: string): T | undefined {
      const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as unknown as
        SettingRow | undefined
      if (!row) return undefined
      return JSON.parse(row.value) as T
    },

    setSetting(key: string, value: unknown): void {
      const validate = SETTING_VALIDATORS[key]
      if (!validate) {
        throw new Error(`未知的设置项: ${key}（如需新增请先在 SETTING_VALIDATORS 注册）`)
      }
      if (!validate(value)) {
        throw new Error(`设置项值非法: ${key}=${JSON.stringify(value)}`)
      }
      db.prepare(
        `INSERT INTO settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(key, JSON.stringify(value))
    },

    deleteSetting(key: string): void {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    }
  }
}
