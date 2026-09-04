import { IpcService } from 'electron-ipc-service/renderer'
import type { WindowState } from '@main/service/window-service'
import type { ThemePalette } from '@main/service/theme-palettes'

/**
 * header 视图（标题栏，src/renderer/header/index.ts）注册的接收服务骨架。
 *
 * 本模块是「header 视图接收哪些推送」的唯一事实源：
 * - main 进程（render-client）在模块加载时遍历骨架类的方法，推导出哪些
 *   service.method 需要以 'all' 同时投递标题栏；其余推送一律只发内容视图；
 * - header/index.ts 以子类 override 的方式注入真实实现并注册（本模块不可含
 *   DOM / 渲染层逻辑，main 进程也会加载它）。
 *
 * 约定：header 想新增一个接收方法，先在对应骨架类声明签名（方法体留空占位），
 * 再到 header/index.ts 的子类里 override 实现；main 侧自动推导，无需改任何路由表。
 * 若只加在子类而未声明在骨架类，main 会把它当内容视图专属投递，标题栏收不到。
 */
export class HeaderUiService extends IpcService {
  static override readonly namespace = 'ui'

  /** 窗口状态同步（最大化/聚焦/置顶/原生标题栏模式）。 */
  windowStateChange(_state: WindowState): void {}
}

export class HeaderThemeService extends IpcService {
  static override readonly namespace = 'theme'

  /** 主题色变更推送（工作区自定义优先，否则全局默认），注入 --primary* CSS 变量。 */
  colorChanged(_palette: ThemePalette): void {}
}

/** header 视图注册的服务列表：render-client 据此推导推送目标。 */
export const headerViewServiceDefs = [HeaderUiService, HeaderThemeService] as const
