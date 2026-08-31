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

/** 品牌静态覆盖（非主色部分，浅/深共享）：圆角、字体族。主色随主题色 palette 动态取。 */
const brandStatic: GlobalThemeOverrides['common'] = {
  borderRadius: '8px',
  borderRadiusSmall: '6px',
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
  fontWeightStrong: '600'
}

/** 浅色主色覆盖：取自主题色 palette 的 light 组（默认紫罗兰），Naive UI 据此派生相关色。 */
const brand = computed<GlobalThemeOverrides['common']>(() => {
  const t = themeStore.tokensFor('light')
  return {
    ...brandStatic,
    primaryColor: t.primary,
    primaryColorHover: t.hover,
    primaryColorPressed: t.pressed,
    primaryColorSuppl: t.primary
  }
})

/** 深色模式表面色对齐（与浅色共享的非色 token 之外）。 */
const darkSurfaceStatic: GlobalThemeOverrides['common'] = {
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

/**
 * 深色模式额外覆盖：把 Naive UI 表面色对齐到 base.css 的 zinc 炭灰暗色调，
 * 避免与 --bg(#18181b) 不一致。主色取主题色 palette 的 dark 组（保证暗底对比度）。
 * 文字/边框/悬停色同样对齐 token，保证 Naive UI 组件与自绘组件视觉统一。
 */
const darkSurface = computed<GlobalThemeOverrides['common']>(() => {
  const t = themeStore.tokensFor('dark')
  return {
    ...brand.value,
    ...darkSurfaceStatic,
    primaryColor: t.primary,
    primaryColorHover: t.hover,
    primaryColorPressed: t.pressed,
    primaryColorSuppl: t.primary
  }
})

const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: themeStore.isDark ? darkSurface.value : brand.value
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
