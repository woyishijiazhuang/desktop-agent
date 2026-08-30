import { IpcService } from 'electron-ipc-service/renderer'
import { useWindowStore } from '../store/useWindowStore'
import type { WindowState } from 'src/main/service/window-service'
import { showToast } from '../utils/toast'
import type { ShowToastOptions } from '../utils/toast'

/** 托盘动作 → 渲染侧事件名。App.vue 监听后执行导航/新建对话。
 * 不在此处直接 import vue-router/.vue：service/ 目录会被 tsconfig.node.json 纳入
 * plain tsc 检查，跨到 .vue 会解析失败（见 tsconfig.node.json include）。
 */
export const TRAY_ACTION_EVENT = 'tray-action'

/** 设置页 tab 导航 → 渲染侧事件名。SettingsView 监听后切换 activeTab（跨窗口导航用）。 */
export const SETTINGS_TAB_EVENT = 'settings-tab'

/** 设置页可导航的 tab 键（与 SettingsView.navItems 的 key 对应）。 */
export type SettingsTabKey =
  | 'general'
  | 'workspace'
  | 'models'
  | 'usage'
  | 'tools'
  | 'skills'
  | 'memory'
  | 'knowledge'
  | 'mcp'
  | 'data'
  | 'about'

/** 托盘动作类型。 */
export type TrayAction = 'new-chat' | 'open-settings'

export class UiService extends IpcService {
  static override readonly namespace = 'ui'

  /** main 进程经 rendererClient.ui.showToast(options) 弹出全局 toast。 */
  showToast(options: ShowToastOptions): void {
    showToast(options)
  }

  async windowStateChange(state: WindowState): Promise<void> {
    const windowStore = useWindowStore()
    Object.assign(windowStore.state, state)
  }

  /** 托盘菜单动作（main 进程已确保窗口显示，此处仅转发给 App.vue 处理）。 */
  trayAction(action: TrayAction): void {
    window.dispatchEvent(new CustomEvent<TrayAction>(TRAY_ACTION_EVENT, { detail: action }))
  }

  /**
   * 设置窗口 tab 导航（跨窗口）：工作区窗口点击「管理工作区」等入口时，
   * main 进程确保设置窗口打开后定向推送，SettingsView 据此切换 activeTab。
   */
  settingsTab(tab: SettingsTabKey): void {
    window.dispatchEvent(new CustomEvent<SettingsTabKey>(SETTINGS_TAB_EVENT, { detail: tab }))
  }
}
