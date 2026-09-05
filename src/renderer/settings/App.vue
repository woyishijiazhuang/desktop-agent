<script setup lang="ts">
// 设置窗口内容根组件（settings/index.html 入口）：与工作区 App.vue 一致的 Naive
// Provider 链与品牌主题（useNaiveTheme 共享），路由内容（SettingsLayout + 各 tab）经
// <router-view> 懒加载渲染。
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import { useNaiveTheme } from '@renderer/composables/useNaiveTheme'
import ToastBridge from '@renderer/components/ToastBridge.vue'

const { theme, themeOverrides } = useNaiveTheme()
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
