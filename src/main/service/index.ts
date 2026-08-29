import { initializeIpcMainServices } from 'electron-ipc-service'
import { AppService } from './app-service'
import { DbService } from './db-service'
import { WindowService } from './window-service'
import { ThemeService } from './theme-service'
import { AgentService } from '../agent/agent-service'
import { McpService } from '../agent/mcp/service'
import { ModelConfigService } from '../agent/model-config-service'
import { KnowledgeService } from './knowledge-service'
import { BashService } from './bash-service'
import { createLogger } from '../utils/log'

const log = createLogger('service')

// Register all services — this sets up IPC handlers in the main process
export const ipcMainServices = initializeIpcMainServices([
  AppService,
  DbService,
  WindowService,
  ThemeService,
  AgentService,
  McpService,
  ModelConfigService,
  KnowledgeService,
  BashService
])
void ipcMainServices
log.debug('IPC services 已注册', {
  namespaces: ['app', 'db', 'window', 'theme', 'agent', 'mcp', 'modelConfig', 'knowledge', 'bash']
})

// MCP 配置变更（增删改/启停）后驱逐全部内存 Agent：下一轮创建时重新拉取 MCP 工具集。
// 在 service 层接线，避免 mcp/service 反向依赖 agent-service 造成循环引用。
ipcMainServices.mcp.onConfigChanged(() => {
  void ipcMainServices.agent.evictAllSessions()
})

// Export the combined type for the renderer's createIpcRendererClient
export type IpcMainServices = typeof ipcMainServices
