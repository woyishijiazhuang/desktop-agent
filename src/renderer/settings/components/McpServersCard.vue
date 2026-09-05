<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NCard, NButton, NTag, NSwitch, NSpace, NPopconfirm, useMessage } from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import McpServerDialog from './McpServerDialog.vue'
import type { McpServerConfig, McpServerStatus } from '@main/agent/mcp/types'

/**
 * 设置页「MCP 服务器」卡片：配置自定义 MCP server（stdio / HTTP/SSE），
 * 启用后其工具自动注入 Agent。支持连接状态展示、新增/编辑/删除、启停、测试连接。
 */
const message = useMessage()

const servers = ref<McpServerConfig[]>([])
const statusMap = ref<Record<string, McpServerStatus>>({})

const dialogShow = ref(false)
const editing = ref<McpServerConfig | null>(null)

async function refresh(): Promise<void> {
  const [list, status] = await Promise.all([
    mainClient.mcp.listServers(),
    mainClient.mcp.getStatus()
  ])
  servers.value = list
  statusMap.value = Object.fromEntries(status.map((s) => [s.serverId, s]))
}

onMounted(() => void refresh())

function onAdd(): void {
  editing.value = null
  dialogShow.value = true
}

function onEdit(s: McpServerConfig): void {
  editing.value = s
  dialogShow.value = true
}

async function onToggleEnabled(s: McpServerConfig, enabled: boolean): Promise<void> {
  try {
    await mainClient.mcp.setEnabled(s.id, enabled)
    s.enabled = enabled
    message.success(`${enabled ? '已启用' : '已停用'}：${s.name}`)
    void refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function onRemove(s: McpServerConfig): Promise<void> {
  await mainClient.mcp.deleteServer(s.id)
  message.success(`已删除：${s.name}`)
  void refresh()
}

function onSaved(): void {
  void refresh()
}

function statusOf(s: McpServerConfig): McpServerStatus | undefined {
  return statusMap.value[s.id]
}
</script>

<template>
  <NCard size="small">
    <template #header>
      <span>MCP 服务器</span>
    </template>
    <template #header-extra>
      <NTag :type="servers.length > 0 ? 'info' : 'default'" size="small" round>
        {{ servers.length }} 个
      </NTag>
    </template>
    <p class="mcp-desc">
      通过 MCP 协议接入第三方工具（本地 stdio 进程或远程 HTTP/SSE
      服务）。启用的服务器会自动把其工具注入 Agent，可直接在对话中调用。
      连接失败不影响对话，状态与错误信息在此展示。
    </p>

    <div v-if="servers.length === 0" class="mcp-empty">
      <p class="mcp-empty__text">尚未配置 MCP 服务器，点击下方添加一个即可。</p>
    </div>

    <div v-else class="mcp-list">
      <div v-for="s in servers" :key="s.id" class="mcp-list__item">
        <div class="mcp-list__head">
          <div class="mcp-list__info">
            <span class="mcp-list__name">{{ s.name }}</span>
            <NTag size="tiny" round>{{ s.transport === 'stdio' ? 'stdio' : 'HTTP' }}</NTag>
            <NTag :type="s.enabled ? 'success' : 'default'" size="tiny" round>
              {{ s.enabled ? '已启用' : '已停用' }}
            </NTag>
          </div>
          <NSpace :size="8" align="center">
            <NSwitch :value="s.enabled" size="small" @update:value="(v) => onToggleEnabled(s, v)" />
            <NButton size="small" tertiary @click="onEdit(s)">编辑</NButton>
            <NPopconfirm @positive-click="onRemove(s)">
              <template #trigger>
                <NButton size="small" tertiary type="error">删除</NButton>
              </template>
              确定要删除「{{ s.name }}」吗？此操作不可撤销。
            </NPopconfirm>
          </NSpace>
        </div>
        <div class="mcp-list__meta">
          <span v-if="s.enabled && statusOf(s)?.connected" class="mcp-list__status is-ok">
            ● 已连接 · {{ statusOf(s)?.toolCount ?? 0 }} 个工具
          </span>
          <span v-else-if="s.enabled && statusOf(s)?.error" class="mcp-list__status is-err">
            ● 连接失败：{{ statusOf(s)?.error }}
          </span>
          <span v-else class="mcp-list__status">
            {{ s.enabled ? '连接中…' : '已停用' }}
          </span>
          <span class="mcp-list__target" :title="s.transport === 'stdio' ? s.command : s.url">
            {{ s.transport === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url }}
          </span>
        </div>
      </div>
    </div>

    <div class="mcp-add">
      <NButton type="primary" @click="onAdd">添加 MCP 服务器</NButton>
    </div>

    <McpServerDialog v-model:show="dialogShow" :server="editing" @saved="onSaved" />
  </NCard>
</template>

<style scoped>
.mcp-desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-3);
}
.mcp-empty {
  padding: 16px 0;
  text-align: center;
}
.mcp-empty__text {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
}
.mcp-add {
  margin-top: 12px;
}
.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mcp-list__item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mcp-list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mcp-list__info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mcp-list__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.mcp-list__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
  min-width: 0;
}
.mcp-list__status {
  flex-shrink: 0;
}
.mcp-list__status.is-ok {
  color: var(--success);
}
.mcp-list__status.is-err {
  color: var(--error);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-list__target {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 11px;
}
</style>
