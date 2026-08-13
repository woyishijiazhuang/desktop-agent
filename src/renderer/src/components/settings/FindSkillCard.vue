<script setup lang="ts">
import { computed, ref } from 'vue'
import { NCard, NSpace, NButton, NSelect, NAlert, NSwitch, useMessage } from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { mainClient } from '@renderer/utils/main-client'
import {
  FIND_SKILL_SOURCE_LABELS,
  FIND_SKILL_SOURCE_HOMEPAGES,
  type FindSkillSource
} from '@main/agent/types'

/** find_skill 工具在工具注册表中的 name。 */
const FIND_SKILL_TOOL = 'find_skill'

const settings = useSettingsStore()
const message = useMessage()

/** 技能搜索工具当前启用状态。 */
const enabled = computed(
  () => settings.tools.find((t) => t.name === FIND_SKILL_TOOL)?.enabled ?? false
)

async function onToggle(value: boolean): Promise<void> {
  await settings.saveToolEnabled(FIND_SKILL_TOOL, value)
  message.success(`${value ? '已启用' : '已关闭'}：技能搜索`)
}

// ---- 数据源配置 ----
const findSkillTesting = ref(false)
const findSkillTestResult = ref<{ ok: boolean; error?: string } | null>(null)

const findSkillSourceOptions: { value: FindSkillSource; label: string }[] = [
  { value: 'byte', label: FIND_SKILL_SOURCE_LABELS.byte },
  { value: 'tencent', label: FIND_SKILL_SOURCE_LABELS.tencent }
]

/** 切换数据源：立即落库；工具执行时实时读取，无需驱逐 Agent。 */
async function onSourceChange(source: FindSkillSource): Promise<void> {
  await settings.saveFindSkillSource(source)
  findSkillTestResult.value = null
  message.success(`技能搜索数据源已切换为：${FIND_SKILL_SOURCE_LABELS[source]}`)
}

async function onTest(): Promise<void> {
  findSkillTesting.value = true
  findSkillTestResult.value = null
  try {
    findSkillTestResult.value = await settings.testFindSkill(settings.findSkillSource)
  } catch (err) {
    findSkillTestResult.value = {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    findSkillTesting.value = false
  }
}

function openHomepage(): void {
  void mainClient.app.openExternal(FIND_SKILL_SOURCE_HOMEPAGES[settings.findSkillSource])
}
</script>

<template>
  <NCard size="small" class="settings-card">
    <template #header>
      <span>技能搜索（Find Skill）</span>
    </template>

    <!-- 启用开关 -->
    <div class="tool-toggle">
      <div class="tool-toggle__info">
        <span class="tool-toggle__name">启用技能搜索</span>
        <span class="tool-toggle__desc">
          开启后 Agent 可在选定的平台上查找可复用的 AI Agent 技能。关闭后工具不再注入，下一轮生效。
        </span>
      </div>
      <NSwitch :value="enabled" :disabled="!settings.skillsEnabled" @update:value="onToggle" />
    </div>

    <!-- 数据源配置 -->
    <p class="config-desc">
      字节 Find Skill 与腾讯 SkillHub 均提供公开 API，无需配置 Key。切换后对当前会话下一轮生效。
    </p>
    <div class="source-row">
      <div class="source-row__info">
        <span class="source-row__label">数据源</span>
        <span class="source-row__hint">{{
          FIND_SKILL_SOURCE_HOMEPAGES[settings.findSkillSource]
        }}</span>
      </div>
      <NSpace :size="8" align="center">
        <NSelect
          :value="settings.findSkillSource"
          :options="findSkillSourceOptions"
          size="small"
          style="width: 180px"
          @update:value="(v) => onSourceChange(v as FindSkillSource)"
        />
        <NButton size="small" :loading="findSkillTesting" @click="onTest">测试连接</NButton>
        <NButton text type="primary" size="small" @click="openHomepage">前往官网 →</NButton>
      </NSpace>
    </div>
    <NAlert
      v-if="findSkillTestResult"
      :type="findSkillTestResult.ok ? 'success' : 'error'"
      :show-icon="true"
      class="source-alert"
    >
      {{
        findSkillTestResult.ok ? '连接成功' : `连接失败：${findSkillTestResult.error ?? '未知错误'}`
      }}
    </NAlert>
  </NCard>
</template>

<style scoped>
/* 开关 + 配置合并区块 */
.tool-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  margin-bottom: 12px;
}
.tool-toggle__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tool-toggle__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.tool-toggle__desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}
.config-desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}
.source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.source-row__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin-right: 12px;
}
.source-row__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.source-row__hint {
  font-size: 12px;
  color: var(--text-3);
}
.source-alert {
  margin-top: 12px;
}
</style>
