<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { NCard, NIcon, NScrollbar } from 'naive-ui'
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
import GeneralPanel from '@renderer/components/settings/GeneralPanel.vue'
import WorkspacePanel from '@renderer/components/settings/WorkspacePanel.vue'
import ModelsPanel from '@renderer/components/settings/ModelsPanel.vue'
import UsagePanel from '@renderer/components/settings/UsagePanel.vue'
import ToolsPanel from '@renderer/components/settings/ToolsPanel.vue'
import SkillsPanel from '@renderer/components/settings/SkillsPanel.vue'
import MemoryPanel from '@renderer/components/settings/MemoryPanel.vue'
import KnowledgePanel from '@renderer/components/settings/KnowledgePanel.vue'
import McpPanel from '@renderer/components/settings/McpPanel.vue'
import VoicePanel from '@renderer/components/settings/VoicePanel.vue'
import DataPanel from '@renderer/components/settings/DataPanel.vue'
import AboutPanel from '@renderer/components/settings/AboutPanel.vue'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { SETTINGS_TAB_EVENT } from '@renderer/service/ui-service'
import { mainClient } from '@renderer/utils/main-client'
import { useRoute } from 'vue-router'
import { SETTING_SETTINGS_TAB, SETTINGS_TAB_KEYS, type SettingsTabKey } from '@main/agent/types'

const settings = useSettingsStore()
const modelConfigs = useModelConfigsStore()
const route = useRoute()

/**
 * 初始 tab 同步取自 URL query：主进程创建设置窗口时把目标 tab / 上次位置经 ?tab= 注入，
 * 首帧即读到正确值，无需等待异步 IPC（否则先渲染默认 tab 再切换到配置值造成跳动）。
 */
function initialSettingsTab(): SettingsTabKey {
  const t = route.query.tab
  return typeof t === 'string' && SETTINGS_TAB_KEYS.includes(t as SettingsTabKey)
    ? (t as SettingsTabKey)
    : 'general'
}

/** 当前激活的分类（持久化于 settings 的 ui.settingsTab，打开设置窗口时恢复上次位置）。 */
const activeTab = ref<SettingsTabKey>(initialSettingsTab())

/** 左侧导航分类（key 与 SettingsTabKey 对齐，用于 tab 持久化与合法性校验）。 */
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

// 切换 tab 时持久化：打开设置窗口时恢复上次位置（跨窗口导航的配置载体）
watch(activeTab, (tab) => {
  void mainClient.db.setSetting(SETTING_SETTINGS_TAB, tab)
})

onMounted(async () => {
  // 共享引导：设置 + 模型配置（各 Panel 自行加载自身数据）
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
    activeTab.value = tab as SettingsTabKey
  }
}
</script>

<template>
  <div class="settings-view">
    <!-- 左侧分类导航 -->
    <aside class="settings-nav">
      <div class="settings-nav__head">
        <h1 class="settings-nav__title">设置</h1>
      </div>

      <nav class="settings-nav__list">
        <div
          v-for="item in navItems"
          :key="item.key"
          class="settings-nav__item"
          :class="{ 'settings-nav__item--active': activeTab === item.key }"
          :title="item.label"
          @click="activeTab = item.key"
        >
          <NIcon :size="16" class="settings-nav__icon"><component :is="item.icon" /></NIcon>
          <span>{{ item.label }}</span>
        </div>
      </nav>
    </aside>

    <!-- 右侧内容区：各 Panel 常驻挂载（v-show 切页保留状态） -->
    <NScrollbar class="settings-content">
      <div v-show="activeTab === 'general'" class="settings-content__inner">
        <GeneralPanel />
      </div>

      <div v-show="activeTab === 'workspace'" class="settings-content__inner">
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
      </div>

      <div v-show="activeTab === 'models'" class="settings-content__inner">
        <ModelsPanel />
      </div>

      <div v-show="activeTab === 'usage'" class="settings-content__inner">
        <NCard size="small" class="settings-card">
          <template #header>
            <span>用量统计</span>
          </template>
          <UsagePanel :active="activeTab === 'usage'" />
        </NCard>
      </div>

      <div v-show="activeTab === 'tools'" class="settings-content__inner">
        <ToolsPanel />
      </div>

      <div v-show="activeTab === 'skills'" class="settings-content__inner">
        <SkillsPanel />
      </div>

      <div v-show="activeTab === 'memory'" class="settings-content__inner">
        <MemoryPanel />
      </div>

      <div v-show="activeTab === 'knowledge'" class="settings-content__inner">
        <KnowledgePanel />
      </div>

      <div v-show="activeTab === 'mcp'" class="settings-content__inner">
        <McpPanel />
      </div>

      <div v-show="activeTab === 'voice'" class="settings-content__inner">
        <VoicePanel />
      </div>

      <div v-show="activeTab === 'data'" class="settings-content__inner">
        <DataPanel />
      </div>

      <div v-show="activeTab === 'about'" class="settings-content__inner">
        <AboutPanel />
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
/* 整体：左侧导航 + 右侧内容 */
.settings-view {
  flex: 1;
  min-width: 0;
  display: flex;
  height: 100%;
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
