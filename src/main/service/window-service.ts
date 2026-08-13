import { BaseWindow } from 'electron'
import { IpcService, useIpcMainContext } from 'electron-ipc-service'
import { rendererClient } from '../utils/render-client'
import { db } from '../database'
import { getWindowByWebContents, recreateMainWindow } from './window-manager'
import { SETTING_TITLE_BAR_MODE, type TitleBarMode } from '../agent/types'
import { createLogger } from '../utils/log'

const log = createLogger('window')

export interface WindowState {
  // 窗口状态
  isMaximized: boolean // 是否最大化
  isMinimized: boolean // 是否最小化
  isFullScreen: boolean // 是否全屏
  isAlwaysOnTop: boolean // 是否置顶
  isFocused: boolean // 是否聚焦
  isNativeTitleBar: boolean // 原生标题栏模式（macOS 红绿灯 / Windows overlay 系统按钮），自绘窗口控制隐藏
}

/** 窗口置顶偏好设置键（settings 表，启动时恢复）。 */
export const SETTING_ALWAYS_ON_TOP = 'window.alwaysOnTop'

export type WindowAction =
  | 'hide'
  | 'show'
  | 'close'
  | 'maximize'
  | 'unmaximize'
  | 'minimize'
  | 'restore'
  | 'enter-full-screen'
  | 'leave-full-screen'
  | 'always-on-top'
  | 'cancel-always-on-top'
  | 'native-title-bar'
  | 'cancel-native-title-bar'

export class WindowService extends IpcService {
  static override readonly namespace = 'window'
  private bindWindows: Set<number> = new Set()
  /** 标题栏模式（与 settings 表同步；isNativeTitleBar 据此推导）。 */
  private titleBarMode: TitleBarMode =
    db.getSetting<string>(SETTING_TITLE_BAR_MODE) === 'custom' ? 'custom' : 'native'
  constructor() {
    super()
  }
  initWindow(): WindowState {
    const { sender } = useIpcMainContext()
    const win = getWindowByWebContents(sender)
    // 窗口已关闭（退出/关闭流程中渲染进程的迟到请求）→ 注册表已清空，返回中性状态即可
    if (!win) return this.neutralState()
    this.bindEvents(win)
    return this.getWindowState(win)
  }
  private getWindowState(win?: BaseWindow): WindowState {
    const senderWin = win ?? getWindowByWebContents(useIpcMainContext().sender)
    // close 等动作执行后窗口可能已销毁 / 不可解析（再调用状态读取会抛 Object has been destroyed），
    // 返回中性状态即可，调用方（即将关闭）不会再消费它。
    if (!senderWin || senderWin.isDestroyed()) return this.neutralState()
    return {
      isMaximized: senderWin.isMaximized(),
      isMinimized: senderWin.isMinimized(),
      isFullScreen: senderWin.isFullScreen(),
      isAlwaysOnTop: senderWin.isAlwaysOnTop(),
      isFocused: senderWin.isFocused(),
      isNativeTitleBar: this.titleBarMode === 'native' && process.platform !== 'linux'
    }
  }
  /** 窗口不可用（未注册 / 已销毁）时的中性状态。 */
  private neutralState(): WindowState {
    return {
      isMaximized: false,
      isMinimized: false,
      isFullScreen: false,
      isAlwaysOnTop: false,
      isFocused: false,
      isNativeTitleBar: false
    }
  }
  // 触发窗口事件
  triggerWindowAction(action: WindowAction): WindowState {
    const { sender } = useIpcMainContext()
    const win = getWindowByWebContents(sender)
    // 窗口已关闭（如退出流程中的迟到请求）：动作无意义，返回中性状态
    if (!win) return this.neutralState()
    log.debug('窗口动作', { action })
    switch (action) {
      case 'enter-full-screen':
        win.setFullScreen(true)
        break
      case 'leave-full-screen':
        win.setFullScreen(false)
        break
      case 'always-on-top':
        win.setAlwaysOnTop(true)
        // 置顶偏好持久化：重启后由 main/index.ts 恢复
        db.setSetting(SETTING_ALWAYS_ON_TOP, true)
        break
      case 'cancel-always-on-top':
        win.setAlwaysOnTop(false)
        db.setSetting(SETTING_ALWAYS_ON_TOP, false)
        break
      case 'native-title-bar':
      case 'cancel-native-title-bar': {
        const mode: TitleBarMode = action === 'native-title-bar' ? 'native' : 'custom'
        db.setSetting(SETTING_TITLE_BAR_MODE, mode)
        this.titleBarMode = mode
        // frame/titleBarStyle 在窗口构造时生效，需重建窗口；
        // 延后执行让本次 IPC 响应先送达渲染进程，再销毁旧窗口
        setImmediate(() => recreateMainWindow())
        break
      }
      default: {
        const fn = (win as unknown as Record<string, unknown>)[action]
        if (typeof fn !== 'function') {
          throw new Error(`Invalid window action: ${action}`)
        }
        ;(fn as () => void).call(win)
      }
    }
    return this.getWindowState(win)
  }

  private bindEvents(win: BaseWindow): void {
    // 幂等：renderer 重载（HMR/导航）会再次调用 initWindow，已绑定的窗口直接跳过，避免重复绑定与报错
    if (this.bindWindows.has(win.id)) return
    this.bindWindows.add(win.id)

    const emitState = (): void => {
      rendererClient.ui.windowStateChange(this.getWindowState(win))
    }

    const events: string[] = [
      'maximize',
      'unmaximize',
      'minimize',
      'restore',
      'enter-full-screen',
      'leave-full-screen',
      'always-on-top-changed',
      'focus',
      'blur'
    ]
    events.forEach((event) => {
      win.on(event as never, emitState as () => void)
    })
  }
}
