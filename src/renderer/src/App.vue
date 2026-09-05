<script setup lang="ts">
// 根组件：挂载 Naive UI 全局 Provider 链，确保所有页面 setup 内
// useMessage()/useDialog() 都在 Provider 子树。布局由 layouts/* 提供。
// 主题：useThemeStore 驱动 .dark 类（base.css/markstream 据此翻转），并联动
// NConfigProvider :theme=darkTheme 使 Naive UI 组件整体深色。
import { onMounted, onUnmounted } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useSessionStore } from './store/useSessionStore'
import { useNaiveTheme } from './composables/useNaiveTheme'
import { mainClient } from './utils/main-client'
import ToastBridge from './components/ToastBridge.vue'
import { TRAY_ACTION_EVENT, type TrayAction } from './service/ui-service'

const { theme, themeOverrides } = useNaiveTheme()
const router = useRouter()

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
