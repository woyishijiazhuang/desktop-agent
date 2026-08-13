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
