import type { McpServerRow, McpTransport } from '../../database'
import { connectMcpServer } from './client'
import type { McpTestResult } from './types'
import { createLogger } from '../../utils/log'

const log = createLogger('mcp')

/** 用给定配置试连并拉取工具（不持久化、不改连接池）。 */
export async function testMcpConnection(input: {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}): Promise<McpTestResult> {
  const row: McpServerRow = {
    id: '__test__',
    name: input.name || '测试',
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    env: input.env ? JSON.stringify(input.env) : null,
    url: input.url ?? null,
    enabled: true,
    createdAt: '',
    updatedAt: ''
  }
  try {
    const conn = await connectMcpServer(row)
    const tools = conn.tools.map((t) => t.name)
    log.info('MCP 连接测试通过', {
      name: row.name,
      transport: row.transport,
      toolCount: tools.length
    })
    try {
      await conn.client.close()
    } catch {
      // 忽略
    }
    return { ok: true, error: null, tools }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn('MCP 连接测试失败', { name: row.name, transport: row.transport, error })
    return { ok: false, error, tools: [] }
  }
}
