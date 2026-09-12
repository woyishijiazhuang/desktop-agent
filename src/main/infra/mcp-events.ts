import type { McpServerStatus } from '../agent/mcp/types'
import { rendererClient } from './render-client'

/**
 * MCP 连接状态变更广播（main → 全部窗口）。
 * MCP server 连接在后台异步进行（npx 冷启动可能耗时数十秒），设置页不能靠一次性
 * 拉取拿到最终状态：McpManager 每次状态跳变（连接中/成功/失败）都推送全量快照，
 * 设置页的 mcpSync 接收服务据此实时刷新，无需轮询。
 * 推送失败（无窗口等）不影响连接管理主流程。
 */
export function notifyMcpStatuses(statuses: McpServerStatus[]): void {
  try {
    rendererClient.mcpSync.statusesChanged(statuses)
  } catch {
    // 忽略推送失败
  }
}
