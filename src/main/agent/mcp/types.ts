import type { McpServerRow, McpTransport } from '../../database'

/**
 * MCP server 相关跨进程类型（renderer 用 import type 引用，无运行时依赖）。
 */

/** 面向 renderer 的 MCP server 配置（DB 行的解析形态）。 */
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  /** stdio：可执行命令（如 npx、python） */
  command: string
  /** stdio：命令参数 */
  args: string[]
  /** stdio：附加环境变量 */
  env: Record<string, string>
  /** http：server URL */
  url: string
  enabled: boolean
}

/** MCP server 的连接状态（设置页展示用）。 */
export interface McpServerStatus {
  serverId: string
  name: string
  transport: McpTransport
  enabled: boolean
  connected: boolean
  error: string | null
  /** 已拉取到的工具数量 */
  toolCount: number
}

/** MCP server 暴露的单个工具描述（列表/测试用）。 */
export interface McpToolDescriptor {
  name: string
  description: string
  /** JSON Schema（MCP inputSchema），渲染层仅展示不解释。 */
  inputSchema: unknown
}

/** 连接测试结果。 */
export interface McpTestResult {
  ok: boolean
  error: string | null
  tools: string[]
}

/**
 * 内置 MCP 预设（随包出厂目录，非已安装配置）。
 * 与 McpServerConfig 同构，renderer「添加」时按此预填弹窗，确认/补参后保存为正式 server。
 * 注意：预设不是 DB 行，不会默认启用，也不参与 manifest/墓碑管理（删除的只是用户自己添加的副本）。
 */
export interface BuiltinMcpPreset {
  /** 预设唯一 id（如 playwright / context7 / github）。 */
  id: string
  name: string
  description: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  /** 使用前提示（依赖、所需参数、注意事项），弹窗与预设卡片展示。 */
  note: string
}

/** DB 行 → renderer 配置。 */
export function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? '',
    args: parseJson(row.args, []),
    env: parseJson(row.env, {}),
    url: row.url ?? '',
    enabled: row.enabled
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
