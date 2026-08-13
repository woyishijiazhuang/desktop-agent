/** MCP server 传输方式。 */
export type McpTransport = 'stdio' | 'http'

/** MCP server 配置行（DB 形态）。 */
export interface McpServerRow {
  id: string
  name: string
  transport: McpTransport
  /** stdio：可执行命令（如 npx、python） */
  command: string | null
  /** stdio：命令参数（JSON 数组） */
  args: string | null
  /** stdio：附加环境变量（JSON 对象） */
  env: string | null
  /** http：server URL */
  url: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 创建/更新 MCP server 的参数。 */
export interface CreateMcpServerParams {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled?: boolean
}

/** 更新 MCP server 的参数（字段可选，未传不修改）。 */
export type UpdateMcpServerParams = Partial<CreateMcpServerParams>
