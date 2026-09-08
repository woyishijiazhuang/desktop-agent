import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { db } from '../../database'
import type { McpServerRow } from '../../database'
import type { McpServerStatus, McpTestResult } from './types'
import { createLogger } from '../../utils/log'
import { connectMcpServer, callMcpTool } from './client'
import { testMcpConnection } from './test'
import { SETTING_MCP_TOOL_USAGE } from '../types'

const log = createLogger('mcp')

/**
 * MCP 客户端管理器（main 进程单例）。
 *
 * 职责：
 * - 维护每个已启用 MCP server 的连接（stdio / streamable HTTP）与拉取到的工具缓存
 * - 给 Agent 提供**发现层**（mcp_tools 工具：服务器目录 / 关键词搜索 / 工具详情与参数 Schema）
 *   与**通用调用**（mcp_call 工具：实时校验 server/工具可用后执行）
 * - 配置变更（增删改/启停）后 reload 连接池
 *
 * 设计要点（2026-09 改造）：
 * MCP 工具不再逐工具注入 Agent 上下文（一个 server 动辄 10~25 个工具会显著挤占上下文与
 * 工具选择空间）。改为仅注入两个固定元工具（mcp_tools / mcp_call），server 工具“用到才查、
 * 查完再调”，因此启用/停用 MCP 服务器不再改变 Agent 上下文；调用时实时校验，服务器在对话中
 * 被关闭会返回明确的“已停用/不存在”提示，无需驱逐 Agent。
 * 连接失败不影响对话；各 server 状态在设置页展示。
 */

/** 连接缓存里工具的字段子集。 */
interface McpToolLike {
  name: string
  description: string
  inputSchema: unknown
}

interface ServerConnection {
  row: McpServerRow
  client: Client
  tools: McpToolLike[]
}

/** 文本截断（目录/列表输出控制体量，防止撑爆上下文）。 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
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

  /** 确保 server 已连接；未连接则尝试连接，仍失败返回 null（错误见 errors）。 */
  private async ensureConnected(row: McpServerRow): Promise<ServerConnection | null> {
    const existing = this.connections.get(row.id)
    if (existing) return existing
    await this.connectServer(row)
    return this.connections.get(row.id) ?? null
  }

  /** 当前已启用的 server 行。 */
  private enabledRows(): McpServerRow[] {
    return db.listMcpServers().filter((s) => s.enabled)
  }

  /** 按「名称或 id」解析已启用 server 行。 */
  private resolveEnabledRow(server: string): McpServerRow | undefined {
    const s = server.trim()
    return this.enabledRows().find(
      (r) => r.id === s || r.name.toLocaleLowerCase() === s.toLocaleLowerCase()
    )
  }

  // ---- 使用热度（供目录排序，跨重启保留）----

  private usage(): Record<string, number> {
    return db.getSetting<Record<string, number>>(SETTING_MCP_TOOL_USAGE) ?? {}
  }

  /** 记录一次成功调用（key = serverId::toolName）。 */
  private bumpUsage(serverId: string, tool: string): void {
    const u = this.usage()
    const k = `${serverId}::${tool}`
    u[k] = (u[k] ?? 0) + 1
    db.setSetting(SETTING_MCP_TOOL_USAGE, u)
  }

  /** 某 server 内按调用次数排序的（工具名, 次数）列表。 */
  private topToolsByUsage(serverId: string, limit: number): string[] {
    const prefix = `${serverId}::`
    return Object.entries(this.usage())
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => k.slice(prefix.length))
  }

  // ---- 发现层（mcp_tools）----

  /**
   * 返回 MCP 目录/搜索/详情文本，供 mcp_tools 工具执行。
   * - 无参数：已启用服务器的分类目录（按使用热度 + 名称排序，含最近常用工具）
   * - keywords：按关键词搜索匹配的 server / 工具（含用途说明）
   * - server：该服务器全部可用工具清单
   * - server + tool：单个工具的完整参数 JSON Schema（调用前应查看）
   */
  async describeMcp(opts: { server?: string; tool?: string; keywords?: string }): Promise<string> {
    const { server, tool, keywords } = opts
    if (server) {
      const row = this.resolveEnabledRow(server)
      if (!row) return this.notFoundServerText(server)
      const conn = await this.ensureConnected(row)
      if (!conn) {
        return `服务器「${row.name}」当前不可用（连接失败：${this.errors.get(row.id) ?? '未知原因'}）。可在「设置 → MCP」查看状态，或稍后重试。`
      }
      if (tool) {
        const t = this.findTool(conn, tool)
        if (!t) return this.notFoundToolText(row.name, conn.tools)
        return [
          `MCP 工具：${row.name} · ${t.name}`,
          `用途：${t.description || '（无描述）'}`,
          `参数 JSON Schema：`,
          prettySchema(t.inputSchema),
          `提示：请严格按上述字段构造 mcp_call 的 args（必填字段不可省略；对象嵌套请保持层级）。`
        ].join('\n')
      }
      // 单服务器工具清单
      const lines = conn.tools.map(
        (t, i) => `${i + 1}. ${t.name} — ${truncate(t.description || '（无描述）', 70)}`
      )
      const usageTools = this.topToolsByUsage(row.id, 3)
      return [
        `「${row.name}」可用工具（${conn.tools.length} 个）${usageTools.length ? `，常用：${usageTools.join('、')}` : ''}`,
        ...lines,
        `提示：如需某工具的完整参数说明，请调用 mcp_tools 并同时传入 server（${row.name}）与 tool（工具名）。`
      ].join('\n')
    }
    if (keywords?.trim()) return this.searchText(keywords.trim())
    return this.catalogText()
  }

  /** 调用 MCP 工具（mcp_call）。实时校验服务器与工具当前可用性。 */
  async invokeTool(input: {
    server: string
    tool: string
    args?: unknown
  }): Promise<
    { ok: true; content: Awaited<ReturnType<typeof callMcpTool>> } | { ok: false; text: string }
  > {
    const row = this.resolveEnabledRow(input.server)
    if (!row) {
      return {
        ok: false,
        text:
          `找不到已启用的 MCP 服务器「${input.server}」。该服务器可能已在对话中被停用或删除；` +
          `可先调用 mcp_tools 查看当前可用服务器列表。`
      }
    }
    const conn = await this.ensureConnected(row)
    if (!conn) {
      return {
        ok: false,
        text: `服务器「${row.name}」当前不可用（连接失败：${this.errors.get(row.id) ?? '未知原因'}）。请先在「设置 → MCP」查看状态。`
      }
    }
    const t = this.findTool(conn, input.tool)
    if (!t) return { ok: false, text: this.notFoundToolText(row.name, conn.tools) }
    const start = Date.now()
    log.debug('MCP 工具调用', { server: row.name, tool: t.name })
    try {
      const content = await callMcpTool(conn.client, t.name, input.args)
      this.bumpUsage(row.id, t.name)
      log.debug('MCP 工具调用完成', {
        server: row.name,
        tool: t.name,
        durationMs: Date.now() - start
      })
      return { ok: true, content }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error('MCP 工具调用失败', { server: row.name, tool: t.name, error })
      return {
        ok: false,
        text: `调用「${row.name} · ${t.name}」失败：${truncate(error, 300)}。如为参数不完整/格式错误，请先用 mcp_tools 查看该工具的参数说明后重试。`
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

  // ---- 内部：文本构建与查找 ----

  /** 服务器目录（无搜索词）：按使用热度降序、其余按名称，逐条给出常用工具。 */
  private async catalogText(): Promise<string> {
    const rows = this.enabledRows()
    if (rows.length === 0) {
      return '当前未启用任何 MCP 服务器。可在「设置 → MCP」添加并启用服务器，之后本工具会列出其可用工具。'
    }
    const usageAll = this.usage()
    const scoreOf = (id: string): number =>
      Object.entries(usageAll)
        .filter(([k]) => k.startsWith(`${id}::`))
        .reduce((sum, [, v]) => sum + v, 0)
    const sorted = [...rows].sort(
      (a, b) => scoreOf(b.id) - scoreOf(a.id) || a.name.localeCompare(b.name)
    )
    const lines: string[] = []
    for (const row of sorted) {
      const conn = this.connections.get(row.id)
      const count = conn ? String(conn.tools.length) : '未连接'
      const top = this.topToolsByUsage(row.id, 3)
      lines.push(
        `- ${row.name}（id: ${row.id}，${row.transport === 'stdio' ? '本地进程' : 'HTTP'}，工具 ${count}）${top.length ? ` 常用：${top.join('、')}` : ''}`
      )
    }
    return [
      `已启用 MCP 服务器（${rows.length}）：`,
      ...lines,
      `提示：查看某服务器可用工具 → mcp_tools(server=服务器名)；按需求搜索 → mcp_tools(keywords=关键词)；两者都不传即返回本目录。`
    ].join('\n')
  }

  /** 关键词搜索：命中服务器名 / 工具名 / 工具用途说明。 */
  private async searchText(keywords: string): Promise<string> {
    const tokens = keywords.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const hits: { server: string; tool: string; desc: string; score: number }[] = []
    for (const row of this.enabledRows()) {
      const conn = await this.ensureConnected(row)
      if (!conn) continue
      for (const t of conn.tools) {
        const hay = `${row.name} ${t.name} ${t.description ?? ''}`.toLocaleLowerCase()
        const matched = tokens.filter((tok) => hay.includes(tok)).length
        if (matched === 0) continue
        // 工具名命中权重高于用途说明命中
        const nameHit = tokens.filter((tok) => t.name.toLocaleLowerCase().includes(tok)).length
        hits.push({
          server: row.name,
          tool: t.name,
          desc: truncate(t.description || '（无描述）', 60),
          score: nameHit * 2 + matched
        })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    if (hits.length === 0) {
      return `未找到与「${keywords}」匹配的 MCP 工具。可换关键词，或调用 mcp_tools（不传参数）查看全部可用服务器。`
    }
    const top = hits.slice(0, 15)
    return [
      `关键词「${keywords}」匹配 ${hits.length} 个 MCP 工具，最相关 ${top.length} 个：`,
      ...top.map((h) => `- ${h.server} · ${h.tool} — ${h.desc}`),
      `提示：确认目标后，先 mcp_tools(server=${top[0]?.server ?? ''}, tool=工具名) 查看参数说明，再 mcp_call 调用。`
    ].join('\n')
  }

  private notFoundServerText(server: string): string {
    const names = this.enabledRows()
      .map((r) => r.name)
      .join('、')
    return `未找到已启用的 MCP 服务器「${server}」。当前已启用：${names || '（无）'}。`
  }

  private notFoundToolText(serverName: string, tools: McpToolLike[]): string {
    const sample = tools
      .slice(0, 10)
      .map((t) => t.name)
      .join('、')
    return `服务器「${serverName}」没有该工具，或工具已被服务器移除。可用工具示例：${sample}${tools.length > 10 ? ` 等 ${tools.length} 个` : ''}。请先用 mcp_tools(server=${serverName}) 查看完整清单。`
  }

  private findTool(conn: ServerConnection, name: string): McpToolLike | undefined {
    const exact = conn.tools.find((t) => t.name === name)
    if (exact) return exact
    const lower = name.toLocaleLowerCase()
    return conn.tools.find((t) => t.name.toLocaleLowerCase() === lower)
  }
}

/** JSON Schema 格式化输出（对象为空的给占位提示，避免输出空壳误导）。 */
function prettySchema(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '{}（无约束，可直接构造任意 JSON 参数）'
  const s = schema as Record<string, unknown>
  if (!Array.isArray(s.properties) && Object.keys(s.properties ?? {}).length === 0) {
    return `${JSON.stringify(schema, null, 2)}\n（未声明具体字段，按工具用途自然填写）`
  }
  return JSON.stringify(schema, null, 2)
}

/** main 进程单例。 */
export const mcpManager = new McpManager()
