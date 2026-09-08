import { IpcService } from 'electron-ipc-service'
import { db } from '../../database'
import type { CreateMcpServerParams, UpdateMcpServerParams } from '../../database'
import { mcpManager } from './index'
import { getBuiltinMcpPresets } from './presets'
import { createLogger } from '../../utils/log'
import {
  rowToConfig,
  type BuiltinMcpPreset,
  type McpServerConfig,
  type McpServerStatus,
  type McpTestResult
} from './types'

const log = createLogger('mcp')

/**
 * MCP server 管理服务（namespace: mcp）。
 * - 配置 CRUD（持久化到 mcp_servers 表）
 * - 连接状态查询 / 连接测试
 * - 配置变更后自动 reload 连接池（连接/状态即时生效）
 * 说明：MCP 工具经 mcp_tools/mcp_call 元工具按需发现调用（不预注入 Agent），
 * 因此配置变更无需驱逐会话，在途对话不受影响（见 agent/mcp/index.ts）。
 */
export class McpService extends IpcService {
  static override readonly namespace = 'mcp'

  listServers(): McpServerConfig[] {
    return db.listMcpServers().map(rowToConfig)
  }

  /** 内置 MCP 预设目录（只读，不创建任何配置；renderer 据此预填添加弹窗）。 */
  listBuiltinPresets(): BuiltinMcpPreset[] {
    return getBuiltinMcpPresets()
  }

  createServer(input: CreateMcpServerParams): McpServerConfig {
    const row = db.createMcpServer(input)
    log.info('创建 MCP server', { serverId: row.id, name: row.name, transport: row.transport })
    void this.afterChange()
    return rowToConfig(row)
  }

  updateServer(id: string, patch: UpdateMcpServerParams): McpServerConfig {
    const row = db.updateMcpServer(id, patch)
    log.info('更新 MCP server', { serverId: id, name: row.name, changedKeys: Object.keys(patch) })
    void this.afterChange()
    return rowToConfig(row)
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig {
    const row = db.updateMcpServer(id, { enabled })
    log.info('切换 MCP server 启用状态', { serverId: id, name: row.name, enabled })
    void this.afterChange()
    return rowToConfig(row)
  }

  deleteServer(id: string): void {
    const row = db.getMcpServer(id)
    db.deleteMcpServer(id)
    log.info('删除 MCP server', { serverId: id, name: row?.name })
    void this.afterChange()
  }

  getStatus(): McpServerStatus[] {
    return mcpManager.getStatus()
  }

  testConnection(input: CreateMcpServerParams): Promise<McpTestResult> {
    return mcpManager.testConnection(input)
  }

  /** 应用启动时连接全部已启用 server（失败不影响启动）。 */
  connectAll(): Promise<void> {
    return mcpManager.reload()
  }

  private async afterChange(): Promise<void> {
    await mcpManager.reload()
  }
}
