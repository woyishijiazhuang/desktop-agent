<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, useMessage } from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import FindSkillCard from './FindSkillCard.vue'
import InstalledSkillsCard from './InstalledSkillsCard.vue'
import ToolSwitches from './ToolSwitches.vue'

/** 技能域工具。find_skill 开关已并入 FindSkillCard，这里只列安装/读取技能。 */
const SKILL_TOOLS = new Set(['install_skill', 'read_skill'])

const settings = useSettingsStore()
const message = useMessage()

const skillTools = computed(() => settings.tools.filter((t) => SKILL_TOOLS.has(t.name)))

async function onToggleEnabled(v: boolean): Promise<void> {
  await settings.saveSkillsEnabled(v)
  message.success(v ? '已启用本地技能' : '已关闭本地技能')
}
</script>

<template>
  <div>
    <!-- 技能总开关 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>技能</span>
      </template>
      <p class="settings-card__desc">
        Agent 通过技能搜索（find_skill）、安装（install_skill）与读取（read_skill）
        使用本地技能。关闭总开关后技能相关工具不再注入 Agent，下方的工具开关将被禁用。
      </p>
      <div class="data-row">
        <div class="data-row__info">
          <span class="data-row__label">启用本地技能</span>
          <span class="data-row__hint">关闭后 Agent 不再注入技能相关工具</span>
        </div>
        <NSwitch :value="settings.skillsEnabled" @update:value="onToggleEnabled" />
      </div>
    </NCard>

    <!-- 技能搜索：数据源配置 + 开关 -->
    <FindSkillCard class="settings-card" />

    <!-- 技能工具开关 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>技能工具</span>
      </template>
      <p class="settings-card__desc">
        控制 Agent 可调用的技能安装与读取工具。技能总开关关闭时此处不可调整，恢复后按原状态生效。
        修改后对当前会话下一轮生效。
      </p>
      <ToolSwitches :tools="skillTools" :disabled="!settings.skillsEnabled" />
    </NCard>

    <!-- 已安装技能管理 -->
    <InstalledSkillsCard class="settings-card" />
  </div>
</template>

<style scoped>
/* 卡片间距（子组件根节点带本组件 scope，可命中） */
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
</style>
