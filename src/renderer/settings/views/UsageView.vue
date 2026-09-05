<script setup lang="ts">
// 用量统计 tab 页面：卡片外壳 + 文案（原 SettingsView 用量区块），面板进入本 tab 才懒加载。
// 路由即「已激活」，故 :active 恒为 true（挂载即拉取统计，切走卸载后回来自动刷新）。
import { NCard } from 'naive-ui'
import UsagePanel from '../components/UsagePanel.vue'
</script>

<template>
  <NCard size="small" class="settings-card">
    <template #header>
      <span>用量统计</span>
    </template>
    <UsagePanel :active="true" />
  </NCard>
</template>

<style scoped>
.settings-card {
  margin-bottom: 16px;
}
</style>
