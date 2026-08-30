import { initializeIpcRendererServices } from 'electron-ipc-service/renderer'
import { UiService } from './ui-service'
import { AgentEventService } from './agent-event-service'
import { SettingsSyncService } from './settings-sync-service'

// Register all services — main 进程通过 rendererClient.<namespace>.* 反向调用
export const ipcRendererServices = initializeIpcRendererServices([
  UiService,
  AgentEventService,
  SettingsSyncService
])

// Export the combined type for the main's createMainClient
export type IpcRendererServices = typeof ipcRendererServices
