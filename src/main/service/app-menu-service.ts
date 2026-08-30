import { app, Menu } from 'electron'
import { getFocusedAppWindow } from './window-manager'
import { toggleMainWindow, showMainWindowAnd } from './window-service'
import { createLogger } from '../utils/log'

const log = createLogger('menu')

/**
 * 应用菜单（菜单栏）+ macOS Dock 右键菜单。
 * 此前未调用 Menu.setApplicationMenu，Electron 会挂默认英文菜单（File/Edit/View/...），
 * 与产品不符。这里改为与托盘一致的操作项，并补齐 macOS 标准应用菜单与编辑菜单
 *（编辑菜单缺失会导致 macOS 上 Cmd+C/V/X 等系统剪贴板快捷键失效）。
 * 显隐切换与动作广播见 window-service.toggleMainWindow / showMainWindowAnd。
 */

export function createAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 应用菜单（首项标题恒为应用名，由系统渲染）
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: '关于桌面助手', role: 'about' },
              { type: 'separator' },
              { label: '隐藏桌面助手', role: 'hide' },
              { label: '隐藏其他', role: 'hideOthers' },
              { label: '全部显示', role: 'unhide' },
              { type: 'separator' },
              { label: '退出桌面助手', role: 'quit' }
            ]
          } satisfies Electron.MenuItemConstructorOptions
        ]
      : []),
    // 与托盘一致的快捷操作
    {
      label: '操作',
      submenu: [
        { label: '显示/隐藏桌面助手', click: () => toggleMainWindow() },
        { label: '新建对话', click: () => showMainWindowAnd('new-chat') },
        { label: '打开设置', click: () => showMainWindowAnd('open-settings') },
        { type: 'separator' },
        ...(isMac
          ? [{ label: '关闭窗口', role: 'close' } satisfies Electron.MenuItemConstructorOptions]
          : [{ label: '退出', role: 'quit' } satisfies Electron.MenuItemConstructorOptions])
      ]
    },
    { label: '编辑', role: 'editMenu' },
    // 视图：F12 仅对聚焦视图生效（标题栏视图难以聚焦），故额外提供「标题栏开发者工具」
    {
      label: '视图',
      submenu: [
        { label: '刷新', role: 'reload' },
        { label: '强制刷新', role: 'forceReload' },
        { type: 'separator' },
        { label: '切换开发者工具', role: 'toggleDevTools' },
        {
          label: '标题栏开发者工具',
          click: () => {
            getFocusedAppWindow()?.headerView.webContents.toggleDevTools()
          }
        },
        { type: 'separator' },
        { label: '重置缩放', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' }
      ]
    },
    ...(isMac
      ? [{ label: '窗口', role: 'windowMenu' } satisfies Electron.MenuItemConstructorOptions]
      : [])
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // macOS Dock 右键菜单：与托盘操作一致（退出由系统菜单固定提供，不重复添加）
  if (isMac && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: '显示/隐藏桌面助手', click: () => toggleMainWindow() },
        { label: '新建对话', click: () => showMainWindowAnd('new-chat') },
        { label: '打开设置', click: () => showMainWindowAnd('open-settings') }
      ])
    )
  }
  log.info('应用菜单已设置')
}
