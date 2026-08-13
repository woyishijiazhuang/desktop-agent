import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import type { McpServerRow } from '../../database'
import { withTimeout, mcpResultToContent } from './utils'

/** 连接超时（秒）。超过即视为失败，避免某个不可达 server 拖慢 Agent 创建。 */
export const CONNECT_TIMEOUT_MS = 8000
/** 拉取工具列表超时。 */
export const LIST_TOOLS_TIMEOUT_MS = 8000

export interface McpTool {
  name: string
  description: string
  inputSchema: unknown
}

/** 单个 server 的连接 + 已拉取的工具。 */
export interface McpConnection {
  client: Client
  tools: McpTool[]
}

/** 构造对应传输方式的 transport。 */
export function buildTransport(row: McpServerRow): Transport {
  if (row.transport === 'http') {
    const url = row.url ?? ''
    if (!url) throw new Error('HTTP 传输需要填写 server URL')
    return new StreamableHTTPClientTransport(new URL(url))
  }
  const command = row.command ?? ''
  if (!command) throw new Error('stdio 传输需要填写命令')
  let args: string[] = []
  try {
    args = row.args ? (JSON.parse(row.args) as string[]) : []
  } catch {
    args = []
  }
  let env: Record<string, string> = {}
  try {
    env = row.env ? (JSON.parse(row.env) as Record<string, string>) : {}
  } catch {
    env = {}
  }
  return new StdioClientTransport({ command, args, env })
}

/**
 * 连接单个 server 并拉取工具（含超时）。
 * 失败时关闭 client 并抛出，由调用方决定记录错误或返回失败结果。
 */
export async function connectMcpServer(row: McpServerRow): Promise<McpConnection> {
  const client = new Client({ name: 'my-app', version: '1.0.0' }, { capabilities: {} })
  try {
    const transport = buildTransport(row)
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 MCP「${row.name}」`)
    const { tools } = await withTimeout(
      client.listTools(),
      LIST_TOOLS_TIMEOUT_MS,
      `拉取 MCP「${row.name}」工具`
    )
    return {
      client,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as unknown) ?? {}
      }))
    }
  } catch (err) {
    try {
      await client.close()
    } catch {
      // 忽略关闭失败
    }
    throw err
  }
}

/** 经连接调用 MCP server 的 tools/call，结果转 pi-ai content blocks。 */
export async function callMcpTool(
  client: Client,
  name: string,
  params: unknown
): Promise<(TextContent | ImageContent)[]> {
  const result = await client.callTool({
    name,
    arguments: (params ?? {}) as Record<string, unknown>
  })
  return mcpResultToContent(result.content)
}
