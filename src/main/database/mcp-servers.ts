import type { DatabaseSync } from 'node:sqlite'
import type { CreateMcpServerParams, McpServerRow, UpdateMcpServerParams } from './types'
import { toMcpServer } from './utils'

/** MCP server 配置域 API（index.ts 组装进 db 门面）。 */
export interface McpServersApi {
  listMcpServers(): McpServerRow[]
  getMcpServer(id: string): McpServerRow | undefined
  createMcpServer(params: CreateMcpServerParams): McpServerRow
  updateMcpServer(id: string, params: UpdateMcpServerParams): McpServerRow
  deleteMcpServer(id: string): void
}

/** MCP server 配置 CRUD。 */
export function createMcpServersApi(db: DatabaseSync): McpServersApi {
  const api: McpServersApi = {
    listMcpServers(): McpServerRow[] {
      const rows = db
        .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
        .all() as unknown as McpServerRow[]
      return rows.map((r) => toMcpServer(r))
    },

    getMcpServer(id: string): McpServerRow | undefined {
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as
        McpServerRow | undefined
      return row ? toMcpServer(row) : undefined
    },

    createMcpServer(params: CreateMcpServerParams): McpServerRow {
      const id = crypto.randomUUID()
      db.prepare(
        `INSERT INTO mcp_servers (id, name, transport, command, args, env, url, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        params.name,
        params.transport,
        params.command ?? null,
        params.args ? JSON.stringify(params.args) : null,
        params.env ? JSON.stringify(params.env) : null,
        params.url ?? null,
        params.enabled === false ? 0 : 1
      )
      return api.getMcpServer(id)!
    },

    updateMcpServer(id: string, params: UpdateMcpServerParams): McpServerRow {
      const sets: string[] = []
      const values: (string | number | null)[] = []
      if (params.name !== undefined) {
        sets.push('name = ?')
        values.push(params.name)
      }
      if (params.transport !== undefined) {
        sets.push('transport = ?')
        values.push(params.transport)
      }
      if (params.command !== undefined) {
        sets.push('command = ?')
        values.push(params.command)
      }
      if (params.args !== undefined) {
        sets.push('args = ?')
        values.push(params.args ? JSON.stringify(params.args) : null)
      }
      if (params.env !== undefined) {
        sets.push('env = ?')
        values.push(params.env ? JSON.stringify(params.env) : null)
      }
      if (params.url !== undefined) {
        sets.push('url = ?')
        values.push(params.url)
      }
      if (params.enabled !== undefined) {
        sets.push('enabled = ?')
        values.push(params.enabled ? 1 : 0)
      }
      sets.push('updated_at = ?')
      values.push(Date.now())
      db.prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
      return api.getMcpServer(id)!
    },

    deleteMcpServer(id: string): void {
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    }
  }
  return api
}
