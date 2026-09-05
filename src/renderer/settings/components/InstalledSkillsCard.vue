<script setup lang="ts">
import { NCard, NTag, NSwitch, NButton, NPopconfirm, NSpace, useMessage } from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { FIND_SKILL_SOURCE_LABELS } from '@main/agent/types'

const settings = useSettingsStore()
const message = useMessage()

async function onToggle(id: string, enabled: boolean): Promise<void> {
  await settings.setSkillEnabled(id, enabled)
  message.success(
    `${enabled ? '已启用' : '已停用'}：${settings.installedSkills.find((s) => s.id === id)?.name ?? id}`
  )
}

async function onRemove(id: string): Promise<void> {
  await settings.uninstallSkill(id)
  message.success('技能已卸载')
}

async function onOpenDir(): Promise<void> {
  try {
    await settings.openSkillsDir()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <NCard size="small" class="settings-card">
    <template #header>
      <span>已安装技能</span>
    </template>
    <template #header-extra>
      <NTag :type="settings.installedSkills.length ? 'success' : 'default'" size="small" round>
        {{ settings.installedSkills.length }} 个
      </NTag>
      <NButton text type="primary" size="small" style="margin-left: 8px" @click="onOpenDir">
        打开目录
      </NButton>
    </template>

    <p class="settings-card__desc">
      Agent 从技能市场安装的技能存放在用户数据目录的 skills 文件夹。Agent 在对话中通过 read_skill
      自主发现并使用技能；启停与卸载即时生效，不影响正在进行的对话。
    </p>

    <!-- 空状态 -->
    <div v-if="settings.installedSkills.length === 0" class="skill-empty">
      <p class="skill-empty__text">
        暂无已安装技能。Agent 可在对话中搜索技能（find_skill）并自行安装（install_skill）。
      </p>
    </div>

    <!-- 已安装技能列表 -->
    <div v-else class="skill-list">
      <div v-for="s in settings.installedSkills" :key="s.id" class="skill-list__item">
        <div class="skill-list__main">
          <div class="skill-list__head">
            <span class="skill-list__name">{{ s.name }}</span>
            <NTag size="tiny" round>{{ FIND_SKILL_SOURCE_LABELS[s.source] }}</NTag>
            <NTag v-if="s.version" size="tiny" round>v{{ s.version }}</NTag>
            <NTag v-if="s.hasExtraFiles" type="info" size="tiny" round>含脚本</NTag>
            <NTag v-if="s.downloads > 0" size="tiny" round>{{ s.downloads }} 下载</NTag>
          </div>
          <p class="skill-list__desc" :title="s.description">{{ s.description || '（无描述）' }}</p>
          <span class="skill-list__id">{{ s.id }}</span>
        </div>
        <NSpace :size="8" align="center">
          <NSwitch size="small" :value="s.enabled" @update:value="(v) => onToggle(s.id, v)" />
          <NPopconfirm @positive-click="onRemove(s.id)">
            <template #trigger>
              <NButton size="small" tertiary type="error">删除</NButton>
            </template>
            将删除「{{ s.name }}」的本地文件与记录，确定吗？
          </NPopconfirm>
        </NSpace>
      </div>
    </div>
  </NCard>
</template>

<style scoped>
.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}

.skill-empty {
  padding: 20px 12px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.skill-empty__text {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
}

.skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skill-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.skill-list__main {
  flex: 1;
  min-width: 0;
}
.skill-list__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.skill-list__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.skill-list__desc {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-list__id {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
