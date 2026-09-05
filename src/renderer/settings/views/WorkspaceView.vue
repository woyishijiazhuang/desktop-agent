<script setup lang="ts">
// 工作区 tab 页面：卡片外壳 + 文案（原 SettingsView 工作区区块），面板进入本 tab 才懒加载
import { NCard } from 'naive-ui'
import WorkspacePanel from '../components/WorkspacePanel.vue'
</script>

<template>
  <NCard size="small" class="settings-card">
    <template #header>
      <span>工作区</span>
    </template>
    <p class="settings-card__desc">
      工作区 = 一个项目目录（workdir）+ 专属窗口 + 该目录下的会话与 agent.md
      项目记忆。可同时打开多个工作区窗口，会话按工作区隔离。删除工作区会一并删除其全部会话。
    </p>
    <WorkspacePanel />
  </NCard>
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
</style>
