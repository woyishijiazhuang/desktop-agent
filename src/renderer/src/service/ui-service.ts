import { IpcService } from 'electron-ipc-service/renderer'
import { useWindowStore } from '../store/useWindowStore'
import type { WindowState } from 'src/main/service/window-service'
import { showToast } from '../utils/toast'
import type { ShowToastOptions } from '../utils/toast'

/**
 * 托盘动作 → 渲染侧事件名。App.vue 监听后执行导航/新建对话。
 * 不在此处直接 import vue-router/.vue：service/ 目录会被 tsconfig.node.json 纳入
 * plain tsc 检查，跨到 .vue 会解析失败（见 tsconfig.node.json include）。
 */
export const TRAY_ACTION_EVENT = 'tray-action'

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
}
