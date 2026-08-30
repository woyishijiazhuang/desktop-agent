import { IpcService, useIpcMainContext } from 'electron-ipc-service'
import { rendererClientFor } from './render-client'
import { db, resolveDefaultWorkdir } from '../database'
import {
  getAppWindowByWebContents,
  getActiveWorkspaceWindow,
  openSettingsWindow as openSettingsWindowMain,
  openWorkspaceWindow,
  recreateAllWindows,
  setAlwaysOnTop,
  type AppWindow
} from './window-manager'
import { SETTING_TITLE_BAR_MODE, type TitleBarMode } from '../agent/types'
import type { SettingsTabKey } from '@renderer/service/ui-service'
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
  // 窗口身份（工作区架构）
  windowType: 'workspace' | 'settings' // 工作区窗口 / 设置窗口
  workdir: string | null // 所属工作区；设置窗口为 null
  /** 工作区显示名（标题栏展示；设置窗口为 null）。 */
  workspaceName: string | null
}

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

/** 切换最近聚焦工作区窗口显隐：可见且聚焦 → 隐藏；否则 → 显示并聚焦（托盘/菜单共用）。 */
export function toggleMainWindow(): void {
  const aw = getActiveWorkspaceWindow()
  if (aw && aw.win.isVisible()) {
    aw.win.hide()
    return
  }
  const workdir = aw?.workdir ?? db.listWorkspaces()[0]?.workdir ?? resolveDefaultWorkdir()
  void openWorkspaceWindow(workdir, { touch: false })
}

/**
 * 显示工作区窗口并向其渲染进程发送动作（托盘/菜单共用）。
 * 'new-chat' 定向到最近聚焦的工作区窗口；'open-settings' 打开设置独立窗口。
 */
export async function showMainWindowAnd(action: 'new-chat' | 'open-settings'): Promise<void> {
  if (action === 'open-settings') {
    await openSettingsWindowMain()
    return
  }
  const aw = await ensureActiveWorkspace()
  // macOS 关窗后窗口已销毁，等待视图加载完成（渲染层监听器就绪）再广播，避免动作丢失
  rendererClientFor(aw).ui.trayAction(action)
}

/** 确保存在工作区窗口并返回（缺省打开最近使用的工作区）。 */
async function ensureActiveWorkspace(): Promise<AppWindow> {
  const aw = getActiveWorkspaceWindow()
  if (aw) return aw
  const workdir = db.listWorkspaces()[0]?.workdir ?? resolveDefaultWorkdir()
  return openWorkspaceWindow(workdir, { touch: false })
}

/** 显示最近的工作区窗口（通知点击等场景，仅显示不切换显隐）。 */
export function showMainWindow(): void {
  void ensureActiveWorkspace()
}

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
    const aw = getAppWindowByWebContents(sender)
    // 窗口已关闭（退出/关闭流程中渲染进程的迟到请求）→ 注册表已清空，返回中性状态即可
    if (!aw) return this.neutralState()
    this.bindEvents(aw)
    return this.getWindowState(aw)
  }

  /**
   * 打开设置独立窗口（聊天窗口的设置按钮 / 托盘「打开设置」共用）。
   * 设置页只在独立设置窗口中展示：工作区窗口一律不渲染设置页（见 router 守卫），
   * 避免多个工作区窗口各自打开不同的设置页导致状态分叉。
   */
  async openSettingsWindow(): Promise<void> {
    await openSettingsWindowMain()
  }

  /** 打开设置独立窗口并导航到指定 tab（工作区标识卡片的「管理工作区」入口用）。 */
  async openSettingsTab(tab: SettingsTabKey): Promise<void> {
    const settingsAw = await openSettingsWindowMain()
    rendererClientFor(settingsAw).ui.settingsTab(tab)
  }
  private getWindowState(aw?: AppWindow): WindowState {
    const senderAw = aw ?? getAppWindowByWebContents(useIpcMainContext().sender)
    // close 等动作执行后窗口可能已销毁 / 不可解析（再调用状态读取会抛 Object has been destroyed），
    // 返回中性状态即可，调用方（即将关闭）不会再消费它。
    if (!senderAw || senderAw.win.isDestroyed()) return this.neutralState()
    const win = senderAw.win
    return {
      isMaximized: win.isMaximized(),
      isMinimized: win.isMinimized(),
      isFullScreen: win.isFullScreen(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      isFocused: win.isFocused(),
      isNativeTitleBar: this.titleBarMode === 'native' && process.platform !== 'linux',
      windowType: senderAw.workdir ? 'workspace' : 'settings',
      workdir: senderAw.workdir,
      workspaceName: senderAw.workdir ? (db.getWorkspace(senderAw.workdir)?.name ?? null) : null
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
      isNativeTitleBar: false,
      windowType: 'workspace',
      workdir: null,
      workspaceName: null
    }
  }
  // 触发窗口事件
  triggerWindowAction(action: WindowAction): WindowState {
    const { sender } = useIpcMainContext()
    const aw = getAppWindowByWebContents(sender)
    // 窗口已关闭（如退出流程中的迟到请求）：动作无意义，返回中性状态
    if (!aw) return this.neutralState()
    const win = aw.win
    log.debug('窗口动作', { action, workdir: aw.workdir })
    switch (action) {
      case 'enter-full-screen':
        win.setFullScreen(true)
        break
      case 'leave-full-screen':
        win.setFullScreen(false)
        break
      case 'always-on-top':
        setAlwaysOnTop(win, true)
        break
      case 'cancel-always-on-top':
        setAlwaysOnTop(win, false)
        break
      case 'native-title-bar':
      case 'cancel-native-title-bar': {
        const mode: TitleBarMode = action === 'native-title-bar' ? 'native' : 'custom'
        db.setSetting(SETTING_TITLE_BAR_MODE, mode)
        this.titleBarMode = mode
        // frame/titleBarStyle 在窗口构造时生效，需重建全部窗口；
        // 延后执行让本次 IPC 响应先送达渲染进程，再销毁旧窗口
        setImmediate(() => recreateAllWindows())
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
    return this.getWindowState(aw)
  }

  private bindEvents(aw: AppWindow): void {
    const { win } = aw
    // 幂等：renderer 重载（HMR/导航）会再次调用 initWindow，已绑定的窗口直接跳过，避免重复绑定与报错
    if (this.bindWindows.has(win.id)) return
    this.bindWindows.add(win.id)

    const emitState = (): void => {
      // 窗口状态只发给本窗口（多窗口下不得广播到其他窗口的标题栏）
      rendererClientFor(aw).ui.windowStateChange(this.getWindowState(aw))
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
