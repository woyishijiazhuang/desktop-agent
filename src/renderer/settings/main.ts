import '@renderer/assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { initializeSafeRendererServices } from '@renderer/utils/ipc-guard'
// 设置内容视图的接收服务**裁剪集**：会话域（agentEvent.*）事件只投工作区窗口
// （main 侧收敛于 render-client.collectContentTargets），设置窗口无需注册；
// 其余全窗口广播类服务（ui / settingsSync / theme / modelConfigSync / updateEvents）
// 这里完整注册。任何漏配/能力漂移由守卫 warn 忽略兜底，不崩页面。
import { UiService } from '@renderer/service/ui-service'
import { SettingsSyncService } from '@renderer/service/settings-sync-service'
import { ThemeSyncService } from '@renderer/service/theme-sync-service'
import { ModelConfigSyncService } from '@renderer/service/model-config-sync-service'
import { UpdateEventsService } from '@renderer/service/update-events-service'
import App from './App.vue'
import router from './router'

initializeSafeRendererServices([
  UiService,
  SettingsSyncService,
  ThemeSyncService,
  ModelConfigSyncService,
  UpdateEventsService
])

const pinia = createPinia()
// 挂载前同步应用主题（<html>.dark + --primary* token），避免深色模式 FOUC
useThemeStore(pinia)
createApp(App).use(pinia).use(router).mount('#app')
