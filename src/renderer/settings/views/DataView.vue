<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NCard, NButton, NPopconfirm, NSpace, useMessage } from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'

const message = useMessage()

/** 回收站中的会话数量。 */
const trashCount = ref(0)

/** 日志 / 崩溃目录路径（展示与打开用）。 */
const diagInfo = ref<{ logDir: string; crashDumpsDir: string } | null>(null)

/** 应用版本。 */
const appVersion = ref('')

async function loadTrashCount(): Promise<void> {
  trashCount.value = await mainClient.db.countTrashSessions()
}

/** 手动清空回收站（物理删除全部软删除会话）。 */
async function onPurgeTrash(): Promise<void> {
  await mainClient.db.purgeTrash()
  trashCount.value = 0
  message.success('回收站已清空')
}

async function openDiagDir(which: 'logs' | 'crashes'): Promise<void> {
  try {
    await mainClient.app.openDiagnosticsDir(which)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** 清空日志文件内容（保留文件，日志继续写入）。 */
async function onClearLogs(): Promise<void> {
  await mainClient.app.clearLogs()
  message.success('日志已清空')
}

onMounted(async () => {
  await Promise.all([
    loadTrashCount(),
    mainClient.app.getDiagnosticsInfo().then((info) => (diagInfo.value = info)),
    mainClient.app.getAppVersion().then((v) => (appVersion.value = v))
  ])
})
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>数据管理</span>
      </template>
      <p class="settings-card__desc">
        删除的会话会移入回收站，保留 30
        天后自动彻底删除。你也可以随时手动清空回收站，被清空的会话及其消息无法恢复。
      </p>
      <div class="data-row">
        <span class="data-row__text">
          回收站中有 <strong>{{ trashCount }}</strong> 个已删除会话
        </span>
        <NPopconfirm :disabled="trashCount === 0" @positive-click="onPurgeTrash">
          <template #trigger>
            <NButton size="small" tertiary type="error" :disabled="trashCount === 0">
              清空回收站
            </NButton>
          </template>
          将彻底删除回收站中的 {{ trashCount }} 个会话及其消息，且无法恢复。确定吗？
        </NPopconfirm>
      </div>
    </NCard>

    <NCard size="small" class="settings-card">
      <template #header>
        <span>诊断与日志</span>
      </template>
      <p class="settings-card__desc">
        日志记录主进程运行信息，崩溃转储在应用异常退出时生成。可在此查看目录排查问题。
      </p>
      <div class="data-row">
        <div class="data-row__info">
          <span class="data-row__label">日志目录</span>
          <code class="data-row__path">{{ diagInfo?.logDir }}</code>
        </div>
        <NSpace :size="8" align="center">
          <NButton size="small" tertiary :disabled="!diagInfo" @click="openDiagDir('logs')">
            打开
          </NButton>
          <NPopconfirm @positive-click="onClearLogs">
            <template #trigger>
              <NButton size="small" tertiary type="error">清空</NButton>
            </template>
            将清空日志文件内容，确定吗？
          </NPopconfirm>
        </NSpace>
      </div>
      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">崩溃转储目录</span>
          <code class="data-row__path">{{ diagInfo?.crashDumpsDir }}</code>
        </div>
        <NButton size="small" tertiary :disabled="!diagInfo" @click="openDiagDir('crashes')">
          打开
        </NButton>
      </div>
      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">应用版本</span>
        </div>
        <span class="data-row__text">{{ appVersion }}</span>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.settings-card {
  margin-bottom: 16px;
}
.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}

.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.data-row--gap {
  margin-top: 8px;
}
.data-row__text {
  font-size: 13px;
  color: var(--text-2);
}
.data-row__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin-right: 12px;
}
.data-row__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.data-row__hint {
  font-size: 12px;
  color: var(--text-3);
}
.data-row__path {
  font-size: 11px;
  color: var(--text-3);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 380px;
}
</style>
