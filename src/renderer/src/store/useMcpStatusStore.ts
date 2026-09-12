import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { McpServerStatus } from '@main/agent/mcp/types'

/**
 * MCP server 连接状态（设置页 MCP 卡片消费）。
 * main 进程在连接「开始 / 成功 / 失败」时经 mcpSync.statusesChanged 推送全量快照，
 * 卡片挂载时再调 getStatus 拉一次兜底（避免推送早于订阅丢失）。
 * 连接在后台异步进行（npx 冷启动可能数十秒），必须靠推送实时刷新，不能只靠挂载时拉取。
 */
export const useMcpStatusStore = defineStore('mcp-status', () => {
  const statusMap = ref<Record<string, McpServerStatus>>({})

  /** 用全量快照替换（main 每次推送都是完整状态，删除/停用的 server 自然消失）。 */
  function hydrate(statuses: McpServerStatus[]): void {
    statusMap.value = Object.fromEntries(statuses.map((s) => [s.serverId, s]))
  }

  return { statusMap, hydrate }
})
