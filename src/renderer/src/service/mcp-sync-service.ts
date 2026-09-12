import { IpcService } from 'electron-ipc-service/renderer'
import { useMcpStatusStore } from '../store/useMcpStatusStore'
import type { McpServerStatus } from '@main/agent/mcp/types'

/**
 * MCP 连接状态同步服务：main 进程在 MCP 连接状态跳变时经
 * rendererClient.mcpSync.statusesChanged 广播全量状态快照到全部窗口，
 * 设置页据此实时展示「连接中 / 已连接 / 连接失败」，无需轮询。
 */
export class McpSyncService extends IpcService {
  static override readonly namespace = 'mcpSync'

  /** 全部 server 的最新状态快照。 */
  statusesChanged(statuses: McpServerStatus[]): void {
    useMcpStatusStore().hydrate(statuses)
  }
}
