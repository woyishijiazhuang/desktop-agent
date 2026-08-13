<script setup lang="ts">
import { NSwitch, useMessage } from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import type { ToolInfo } from '@main/agent/types'

/**
 * 工具启用开关列表（通用组件）。
 * 供设置页「工具 / 技能 / 记忆」面板复用：展示工具名、描述与启用开关，
 * 切换后经 useSettingsStore.saveToolEnabled 持久化。
 * disabled 时开关置灰不可调（保持原值不变），用于功能域总开关关闭时的联动。
 */
withDefaults(defineProps<{ tools: ToolInfo[]; disabled?: boolean }>(), {
  disabled: false
})

const settings = useSettingsStore()
const message = useMessage()

async function onToggle(name: string, enabled: boolean): Promise<void> {
  const label = settings.tools.find((t) => t.name === name)?.label ?? name
  await settings.saveToolEnabled(name, enabled)
  message.success(`${enabled ? '已启用' : '已关闭'}：${label}`)
}
</script>

<template>
  <div class="tool-list">
    <div v-for="t in tools" :key="t.name" class="tool-list__item">
      <div class="tool-list__info">
        <span class="tool-list__name">{{ t.label }}</span>
        <span class="tool-list__desc" :title="t.description">{{ t.description }}</span>
      </div>
      <NSwitch :value="t.enabled" :disabled="disabled" @update:value="(v) => onToggle(t.name, v)" />
    </div>
  </div>
</template>

<style scoped>
.tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.tool-list__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
  margin-right: 12px;
}
.tool-list__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.tool-list__desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
