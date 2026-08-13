import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { db } from '../../database'
import type { McpServerRow } from '../../database'
import { jsonSchemaToType } from './schema'
import type { McpServerStatus, McpTestResult } from './types'
import { createLogger } from '../../utils/log'
import { connectMcpServer, callMcpTool } from './client'
import { testMcpConnection } from './test'
import { safeName } from './utils'

const log = createLogger('mcp')

/**
 * MCP 客户端管理器（main 进程单例）。
 *
 * 职责：
 * - 维护每个已启用 MCP server 的连接（stdio / streamable HTTP）
 * - 拉取并缓存 server 暴露的工具，转换为 AgentTool 供 Agent 注入
 * - 工具执行时经对应连接调用 MCP server 的 tools/call
 * - 配置变更（增删改/启停）后 reload：先断开全部再重连，失败 server 记录错误不阻塞其他
 *
 * 连接层（单连接生命周期 / 超时）见 client.ts，连通性测试见 test.ts。
 * 注意：连接失败的 server 不会注入任何工具，Agent 照常工作，状态可在设置页查看。
 */

interface ServerConnection {
  row: McpServerRow
  client: Client
  tools: { name: string; description: string; inputSchema: unknown }[]
}

class McpManager {
  private connections = new Map<string, ServerConnection>()
  private errors = new Map<string, string>()

  /** 重建全部连接：先断开所有，再并行连接已启用的 server。失败不影响其它。 */
  async reload(): Promise<void> {
    await this.disconnectAll()
    const enabled = db.listMcpServers().filter((s) => s.enabled)
    log.info('MCP reload', { enabledServerCount: enabled.length })
    await Promise.all(enabled.map((row) => this.connectServer(row)))
  }

  /** 断开全部连接（应用退出 / reload 用）。 */
  async disconnectAll(): Promise<void> {
    const count = this.connections.size
    await Promise.all(
      [...this.connections.values()].map(async (conn) => {
        try {
          await conn.client.close()
        } catch {
          // 忽略关闭失败
        }
      })
    )
    this.connections.clear()
    if (count > 0) log.info('已断开全部 MCP 连接', { count })
  }

  /** 连接单个 server 并拉取工具；失败记录错误，不抛出（不影响调用方）。 */
  private async connectServer(row: McpServerRow): Promise<void> {
    if (this.connections.has(row.id)) return
    try {
      const conn = await connectMcpServer(row)
      this.connections.set(row.id, { row, ...conn })
      this.errors.delete(row.id)
      log.info('MCP server 连接成功', {
        server: row.name,
        transport: row.transport,
        toolCount: conn.tools.length
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.errors.set(row.id, error)
      log.error('MCP server 连接失败', { server: row.name, transport: row.transport, error })
    }
  }

  /**
   * 汇总当前注入 Agent 的 MCP 工具。
   * 已连接且启用的 server 的工具转换为 AgentTool；未连接/失败的跳过（错误见 getStatus）。
   */
  async getTools(): Promise<AgentTool[]> {
    // 惰性连接：agent 创建时保证已启用 server 的连接就绪（并行，失败不抛出）
    const enabled = db.listMcpServers().filter((s) => s.enabled)
    await Promise.all(
      enabled.filter((row) => !this.connections.has(row.id)).map((row) => this.connectServer(row))
    )
    const tools: AgentTool[] = []
    const seen = new Set<string>()
    for (const conn of this.connections.values()) {
      const current = db.getMcpServer(conn.row.id)
      if (!current || !current.enabled) continue
      const prefix = safeName(current.name)
      for (const tool of conn.tools) {
        const name = `${prefix}_${tool.name}`
        if (seen.has(name)) continue
        seen.add(name)
        tools.push(this.toAgentTool(conn, current, tool, name))
      }
    }
    if (tools.length > 0) log.debug('注入 MCP 工具', { count: tools.length })
    return tools
  }

  /** 单个 MCP 工具 → AgentTool（执行时经所属连接调用 server）。 */
  private toAgentTool(
    conn: ServerConnection,
    row: McpServerRow,
    tool: { name: string; description: string; inputSchema: unknown },
    name: string
  ): AgentTool {
    return {
      name,
      label: `${row.name} · ${tool.name}`,
      description: tool.description || `调用 MCP server「${row.name}」提供的工具 ${tool.name}。`,
      parameters: jsonSchemaToType(tool.inputSchema),
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        const start = Date.now()
        log.debug('MCP 工具调用', { server: row.name, tool: tool.name })
        try {
          const content = await callMcpTool(conn.client, tool.name, params)
          log.debug('MCP 工具调用完成', {
            server: row.name,
            tool: tool.name,
            durationMs: Date.now() - start
          })
          return { content, details: {} }
        } catch (err) {
          log.error('MCP 工具调用失败', {
            server: row.name,
            tool: tool.name,
            error: err instanceof Error ? err.message : String(err)
          })
          throw err
        }
      }
    }
  }

  /** 各 server 当前状态（设置页展示）。 */
  getStatus(): McpServerStatus[] {
    return db.listMcpServers().map((row) => {
      const conn = this.connections.get(row.id)
      return {
        serverId: row.id,
        name: row.name,
        transport: row.transport,
        enabled: row.enabled,
        connected: !!conn,
        error: this.errors.get(row.id) ?? null,
        toolCount: conn?.tools.length ?? 0
      }
    })
  }

  /** 用给定配置试连并拉取工具（不持久化、不改连接池）。 */
  testConnection(input: {
    name: string
    transport: McpServerRow['transport']
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
  }): Promise<McpTestResult> {
    return testMcpConnection(input)
  }
}

/** main 进程单例。 */
export const mcpManager = new McpManager()
