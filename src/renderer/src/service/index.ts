import { initializeSafeRendererServices } from '../utils/ipc-guard'
import { UiService } from './ui-service'
import { AgentEventService } from './agent-event-service'
import { SettingsSyncService } from './settings-sync-service'
import { ThemeSyncService } from './theme-sync-service'
import { ModelConfigSyncService } from './model-config-sync-service'
import { UpdateEventsService } from './update-events-service'

// Register all services — main 进程通过 rendererClient.<namespace>.* 反向调用。
// 使用容错守卫注册（utils/ipc-guard）：本内容视图（工作区 SPA）注册全量服务，
// 守卫保证任何投递/能力配置漂移都只是 warn 忽略，不崩页面。
export const ipcRendererServices = initializeSafeRendererServices([
  UiService,
  AgentEventService,
  SettingsSyncService,
  ThemeSyncService,
  ModelConfigSyncService,
  UpdateEventsService
])

// Export the combined type for the main's createMainClient
export type IpcRendererServices = typeof ipcRendererServices
