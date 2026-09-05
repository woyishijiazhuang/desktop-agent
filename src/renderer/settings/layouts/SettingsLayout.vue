<script setup lang="ts">
// 设置窗口左侧栏 + 内容路由出口。
// 顶部 Provider 由 settings/App.vue 提供；本布局承载常驻导航，激活 tab 渲染进
// <router-view>（懒加载子路由，见 router/index.ts）。tab 合法性/持久化/跨窗口跳转在此收敛。
import { computed, onMounted, onUnmounted, watch } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NIcon, NScrollbar } from 'naive-ui'
import {
  OptionsOutline,
  CubeOutline,
  BuildOutline,
  ExtensionPuzzleOutline,
  GitNetworkOutline,
  FolderOpenOutline,
  StatsChartOutline,
  BookOutline,
  LibraryOutline,
  LayersOutline,
  MicOutline,
  InformationCircleOutline
} from '@vicons/ionicons5'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { SETTINGS_TAB_EVENT } from '@renderer/service/ui-service'
import { mainClient } from '@renderer/utils/main-client'
import { SETTING_SETTINGS_TAB, SETTINGS_TAB_KEYS, type SettingsTabKey } from '@main/agent/types'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const modelConfigs = useModelConfigsStore()

/** 左侧导航分类（key 与 SettingsTabKey / 子路由名对齐）。 */
const navItems: { key: SettingsTabKey; label: string; icon: Component }[] = [
  { key: 'general', label: '通用', icon: OptionsOutline },
  { key: 'workspace', label: '工作区', icon: LayersOutline },
  { key: 'models', label: '模型', icon: CubeOutline },
  { key: 'usage', label: '用量', icon: StatsChartOutline },
  { key: 'tools', label: '工具', icon: BuildOutline },
  { key: 'skills', label: '技能', icon: ExtensionPuzzleOutline },
  { key: 'memory', label: '记忆', icon: BookOutline },
  { key: 'knowledge', label: '知识库', icon: LibraryOutline },
  { key: 'mcp', label: 'MCP', icon: GitNetworkOutline },
  { key: 'voice', label: '语音', icon: MicOutline },
  { key: 'data', label: '数据与诊断', icon: FolderOpenOutline },
  { key: 'about', label: '关于', icon: InformationCircleOutline }
]

/** 由当前路由末段推导激活分类（非法/未匹配回退 general，保证高亮与持久化一致）。 */
const activeKey = computed<SettingsTabKey>(() => {
  const seg = route.path.split('/').pop() ?? ''
  return SETTINGS_TAB_KEYS.includes(seg as SettingsTabKey) ? (seg as SettingsTabKey) : 'general'
})

function goTab(key: SettingsTabKey): void {
  void router.push({ name: `settings-${key}` })
}

// 导航到合法 tab 时持久化：打开设置窗口时恢复上次位置（跨窗口导航的配置载体）
watch(
  activeKey,
  (tab) => {
    void mainClient.db.setSetting(SETTING_SETTINGS_TAB, tab)
  },
  { immediate: true }
)

onMounted(async () => {
  // 共享引导：设置 + 模型配置（各 Panel 进入对应 tab 时才挂载、自行加载其余数据）
  await Promise.all([settings.loadSettings(), modelConfigs.load()])
  // 跨窗口 tab 导航（工作区窗口「管理工作区」入口经 ui.settingsTab 推送，窗口已打开时实时切换）
  window.addEventListener(SETTINGS_TAB_EVENT, onSettingsTabEvent)
})

onUnmounted(() => {
  window.removeEventListener(SETTINGS_TAB_EVENT, onSettingsTabEvent)
})

/** 处理跨窗口 tab 导航：切到合法 tab，非法值忽略。 */
function onSettingsTabEvent(e: Event): void {
  const tab = (e as CustomEvent<string>).detail
  if (navItems.some((i) => i.key === tab)) {
    goTab(tab as SettingsTabKey)
  }
}
</script>

<template>
  <div class="settings-view">
    <!-- 左侧分类导航（常驻，切换不重载） -->
    <aside class="settings-nav">
      <div class="settings-nav__head">
        <h1 class="settings-nav__title">设置</h1>
      </div>

      <nav class="settings-nav__list">
        <div
          v-for="item in navItems"
          :key="item.key"
          class="settings-nav__item"
          :class="{ 'settings-nav__item--active': activeKey === item.key }"
          :title="item.label"
          @click="goTab(item.key)"
        >
          <NIcon :size="16" class="settings-nav__icon"><component :is="item.icon" /></NIcon>
          <span>{{ item.label }}</span>
        </div>
      </nav>
    </aside>

    <!-- 右侧内容区：懒加载子路由在此渲染（仅当前 tab 的 chunk） -->
    <NScrollbar class="settings-content">
      <div class="settings-content__inner">
        <router-view />
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
/* 整体：左侧导航 + 右侧内容（独立 Vue 前端，自身撑满窗口） */
.settings-view {
  height: 100vh;
  width: 100vw;
  min-width: 0;
  display: flex;
}

/* ===== 左侧导航 ===== */
.settings-nav {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  height: 100%;
}
.settings-nav__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 16px 16px 10px;
  cursor: pointer;
}
.settings-nav__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1);
}
.settings-nav__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  overflow-y: auto;
}
.settings-nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.settings-nav__item:hover {
  background: var(--hover-bg);
  color: var(--text-1);
}
.settings-nav__item--active {
  background: var(--primary-soft);
  color: var(--primary-pressed);
  font-weight: 600;
}
.settings-nav__icon {
  flex-shrink: 0;
}

/* ===== 右侧内容 ===== */
.settings-content {
  flex: 1;
  min-width: 0;
}
.settings-content__inner {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 40px 40px;
}
</style>
