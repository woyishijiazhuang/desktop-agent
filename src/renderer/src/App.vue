<script setup lang="ts">
// 根组件：挂载 Naive UI 全局 Provider 链，确保所有页面 setup 内
// useMessage()/useDialog() 都在 Provider 子树。布局由 layouts/* 提供。
// 主题：useThemeStore 驱动 .dark 类（base.css/markstream 据此翻转），并联动
// NConfigProvider :theme=darkTheme 使 Naive UI 组件整体深色。
import { computed, onMounted, onUnmounted } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useThemeStore } from './store/useThemeStore'
import { useSessionStore } from './store/useSessionStore'
import { mainClient } from './utils/main-client'
import ToastBridge from './components/ToastBridge.vue'
import { TRAY_ACTION_EVENT, type TrayAction } from './service/ui-service'

const themeStore = useThemeStore()
const router = useRouter()

/** 品牌通用覆盖（浅/深色共享）：主色紫罗兰、圆角、字体族。主色用真实 hex，Naive UI 据此派生相关色。 */
const brand: GlobalThemeOverrides['common'] = {
  primaryColor: '#7c3aed',
  primaryColorHover: '#6d28d9',
  primaryColorPressed: '#5b21b6',
  primaryColorSuppl: '#7c3aed',
  borderRadius: '8px',
  borderRadiusSmall: '6px',
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
  fontWeightStrong: '600'
}

/**
 * 深色模式额外覆盖：把 Naive UI 表面色对齐到 base.css 的 zinc 炭灰暗色调，
 * 避免与 --bg(#18181b) 不一致。文字/边框/悬停色同样对齐 token，
 * 保证 Naive UI 组件与自绘组件视觉统一，呈现代码编辑器式中性暗色。
 */
const darkSurface: GlobalThemeOverrides['common'] = {
  ...brand,
  primaryColor: '#a78bfa',
  primaryColorHover: '#c4b5fd',
  primaryColorPressed: '#8b5cf6',
  primaryColorSuppl: '#a78bfa',
  bodyColor: '#18181b',
  cardColor: '#1f1f23',
  modalColor: '#1f1f23',
  popoverColor: '#1f1f23',
  inputColor: '#18181b',
  borderColor: '#2a2a2e',
  dividerColor: '#2a2a2e',
  textColorBase: '#f4f4f5',
  textColor1: '#f4f4f5',
  textColor2: '#a1a1aa',
  textColor3: '#71717a',
  hoverColor: '#27272a',
  tableHeaderColor: '#1f1f23'
}

const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: themeStore.isDark ? darkSurface : brand
}))

const theme = computed(() => (themeStore.isDark ? darkTheme : null))

/** 托盘菜单动作：新建对话 → 跳到对话页并进入临时空对话；打开设置 → 打开设置独立窗口。 */
function onTrayAction(e: Event): void {
  const action = (e as CustomEvent<TrayAction>).detail
  if (action === 'new-chat') {
    void router.push('/chat')
    void useSessionStore().startNewChat()
  } else if (action === 'open-settings') {
    void mainClient.window.openSettingsWindow()
  }
}

onMounted(() => window.addEventListener(TRAY_ACTION_EVENT, onTrayAction))
onUnmounted(() => window.removeEventListener(TRAY_ACTION_EVENT, onTrayAction))
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <ToastBridge />
        <router-view />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
