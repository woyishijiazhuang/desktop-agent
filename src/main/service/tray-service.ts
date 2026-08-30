import { app, Menu, Tray, nativeImage } from 'electron'
import trayColored from '../../../resources/tray-icon.png?asset'
import trayTemplate from '../../../resources/tray-icon-template.png?asset'
import { toggleMainWindow, showMainWindowAnd } from './window-service'
import { createLogger } from '../utils/log'

const log = createLogger('tray')

/**
 * 系统托盘：常驻入口 + 快捷操作。
 * - 点击图标：Windows/Linux 切换窗口显隐（macOS 点击弹出菜单）；
 * - 菜单项：显示/隐藏、新建对话、打开设置、退出。
 * 「关闭到托盘」开关位于设置页（window.closeToTray，默认关闭），
 * 开启后关窗不退出、Agent 后台任务可继续运行，经托盘唤回。
 * 显隐切换与动作广播见 window-service.toggleMainWindow / showMainWindowAnd。
 */

let tray: Tray | null = null

/**
 * 托盘图标：单张 @2x 源图，运行时按显示密度派生 @1x 表示
 *（低分屏不按原像素放大、高分屏不发虚），避免为 1x/2x 各存一份文件。
 * macOS 用白色圆角块镂空星模板（系统按菜单栏深浅色自动着色），其余平台用彩色徽章。
 */
function trayImage(): Electron.NativeImage {
  const isMac = process.platform === 'darwin'
  const twoX = isMac ? trayTemplate : trayColored
  const oneXWidth = isMac ? 18 : 16
  const image = nativeImage.createEmpty()
  image.addRepresentation({
    scaleFactor: 1,
    buffer: nativeImage.createFromPath(twoX).resize({ width: oneXWidth }).toPNG()
  })
  image.addRepresentation({
    scaleFactor: 2,
    buffer: nativeImage.createFromPath(twoX).toPNG()
  })
  if (isMac) image.setTemplateImage(true)
  return image
}

export function createTray(): void {
  if (tray) return

  tray = new Tray(trayImage())
  tray.setToolTip('桌面助手')
  const menu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏桌面助手',
      click: () => toggleMainWindow()
    },
    {
      label: '新建对话',
      click: () => showMainWindowAnd('new-chat')
    },
    {
      label: '打开设置',
      click: () => showMainWindowAnd('open-settings')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        log.info('托盘菜单点击退出')
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  // macOS 点击托盘图标默认弹出菜单；Windows/Linux 左键点击切换窗口显隐
  if (process.platform !== 'darwin') {
    tray.on('click', toggleMainWindow)
  }
  log.info('系统托盘已创建')
}
