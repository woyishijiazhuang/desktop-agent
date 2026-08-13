import '@renderer/assets/base.css'
import './index.css'
import { initializeIpcRendererServices, IpcService } from 'electron-ipc-service/renderer'
import type { WindowState } from '@main/service/window-service'
import type { AgentEventPayload, PermissionRequest } from '@main/agent/types'
import type { Session } from '@main/service/db-service'
import { mainClient } from '@renderer/utils/main-client'

/**
 * 标题栏视图（独立 webContents，位于窗口顶部 32px）。
 * - 纯 HTML/CSS/JS，不引入 Vue/Pinia/Naive UI，保持轻量；
 * - 主题：主进程 nativeTheme 为唯一真源，本视图经 prefers-color-scheme 同步跟随，
 *   据此维护 <html>.dark 翻转 base.css token；
 * - 窗口状态：主进程广播 windowStateChange 到全部视图，本视图只消费 ui 服务。
 */

/** 生效主题随主进程 themeSource 变化，给 <html> 落 .dark。 */
const themeMq = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme(): void {
  document.documentElement.classList.toggle('dark', themeMq.matches)
}
applyTheme()
// 主进程切换主题模式 / system 下系统外观变化时同步本视图
themeMq.addEventListener('change', applyTheme)

let windowState: WindowState | null = null

function render(state: WindowState): void {
  windowState = state
  document.documentElement.classList.toggle('win-max', state.isMaximized)
  document.documentElement.classList.toggle('win-focused', state.isFocused)
  document.documentElement.classList.toggle('win-on-top', state.isAlwaysOnTop)
  // 原生标题栏模式（macOS 红绿灯 / Windows overlay 系统按钮）：隐藏自绘窗口控制按钮
  document.documentElement.classList.toggle('win-native', state.isNativeTitleBar)
  const maximizeBtn = document.getElementById('btn-maximize') as HTMLButtonElement
  maximizeBtn.title = state.isMaximized ? '还原' : '最大化'
  const pinBtn = document.getElementById('btn-pin') as HTMLButtonElement
  pinBtn.title = state.isAlwaysOnTop ? '取消置顶' : '置顶窗口'
}

/** 接收 main 推送的窗口状态（广播同时到达内容视图与本视图）。 */
class HeaderUiService extends IpcService {
  static override readonly namespace = 'ui'
  windowStateChange(state: WindowState): void {
    render(state)
  }
  /** 托盘动作由主应用内容视图处理，本视图空实现防止派发报错。 */
  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
  trayAction(_action: 'new-chat' | 'open-settings'): void {}
}

/**
 * 主应用在内容视图注册了 agentEvent 服务，广播同样会到达本视图。
 * 提供同 namespace 的空实现，避免消息派发时 services[ns] 为 undefined 抛错。
 */
class NoopAgentEventService extends IpcService {
  static override readonly namespace = 'agentEvent'
  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
  onEvent(_payload: AgentEventPayload): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
  onPermissionRequest(_req: PermissionRequest): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
  onSessionUpdate(_session: Session): void {}
}

initializeIpcRendererServices([HeaderUiService, NoopAgentEventService])

// 初始状态（广播可能早于注册到达，故主动拉取一次）
void mainClient.window.initWindow().then(render)

const pinBtn = document.getElementById('btn-pin') as HTMLButtonElement
const minimizeBtn = document.getElementById('btn-minimize') as HTMLButtonElement
const maximizeBtn = document.getElementById('btn-maximize') as HTMLButtonElement
const closeBtn = document.getElementById('btn-close') as HTMLButtonElement

pinBtn.addEventListener('click', () => {
  void mainClient.window
    .triggerWindowAction(windowState?.isAlwaysOnTop ? 'cancel-always-on-top' : 'always-on-top')
    .then(render)
})
minimizeBtn.addEventListener('click', () => {
  void mainClient.window.triggerWindowAction('minimize').then(render)
})
maximizeBtn.addEventListener('click', () => {
  void mainClient.window
    .triggerWindowAction(windowState?.isMaximized ? 'unmaximize' : 'maximize')
    .then(render)
})
closeBtn.addEventListener('click', () => {
  void mainClient.window.triggerWindowAction('close')
})
