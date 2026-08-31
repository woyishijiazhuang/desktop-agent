import { initializeIpcMainServices } from 'electron-ipc-service'
import { dialog } from 'electron'
import { AppService } from './app-service'
import { DbService } from './db-service'
import { WindowService } from './window-service'
import { ThemeService } from './theme-service'
import { AgentService } from '../agent/agent-service'
import { McpService } from '../agent/mcp/service'
import { ModelConfigService } from '../agent/model-config-service'
import { KnowledgeService } from './knowledge-service'
import { BashService } from './bash-service'
import { WorkspaceService } from './workspace-service'
import { VoiceService } from './voice-service'
import { setWindowCloseGuard } from './window-manager'
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
  BashService,
  WorkspaceService,
  VoiceService
])
void ipcMainServices
log.debug('IPC services 已注册', {
  namespaces: [
    'app',
    'db',
    'window',
    'theme',
    'agent',
    'mcp',
    'modelConfig',
    'knowledge',
    'bash',
    'workspace',
    'voice'
  ]
})

// MCP 配置变更（增删改/启停）后驱逐全部内存 Agent：下一轮创建时重新拉取 MCP 工具集。
// 在 service 层接线，避免 mcp/service 反向依赖 agent-service 造成循环引用。
ipcMainServices.mcp.onConfigChanged(() => {
  void ipcMainServices.agent.evictAllSessions()
})

// 工作区删除后驱逐其会话的内存 Agent（防悬挂引用与持久化 shell 残留）。
// 在 service 层接线，避免 workspace-service 反向依赖 agent-service 造成循环引用。
ipcMainServices.workspace.setOnSessionsRemoved(async (sessionIds) => {
  for (const id of sessionIds) {
    await ipcMainServices.agent.evictSession(id)
  }
})

// 窗口关闭守卫：工作区有会话正在生成时弹确认，确认后中断生成再关闭。
// 目的：不让 AI 完全静默后台运行（可能触发工具审批/ask_user 而无人处理）；
// 用户取消则保持窗口；最小化不经过 close，不受影响。
setWindowCloseGuard(async (aw) => {
  const workdir = aw.workdir
  if (!workdir) return 'allow'
  if (!ipcMainServices.agent.hasRunningSessions(workdir)) return 'allow'
  const { response } = await dialog.showMessageBox(aw.win, {
    type: 'warning',
    buttons: ['取消', '关闭并中断'],
    defaultId: 0,
    cancelId: 0,
    title: '会话正在生成',
    message: '该工作区有会话正在生成，关闭窗口将中断它',
    detail:
      '继续关闭会中止正在进行的对话（含可能等待确认的工具操作）；已生成的内容已保存，可重新打开窗口继续。'
  })
  if (response !== 1) return 'blocked'
  await ipcMainServices.agent.abortSessionsByWorkdir(workdir)
  return 'allow'
})

// Export the combined type for the renderer's createIpcRendererClient
export type IpcMainServices = typeof ipcMainServices
