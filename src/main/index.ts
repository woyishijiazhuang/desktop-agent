import { app, BaseWindow, crashReporter } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import { ipcMainServices } from './service'
import {
  createMainWindow,
  ensureMainWindow,
  getMainWindow,
  markQuitting
} from './service/window-manager'
import { applyStoredThemeMode } from './service/theme-service'
import { createTray } from './service/tray-service'
import { createAppMenu } from './service/app-menu-service'
import { SETTING_ALWAYS_ON_TOP } from './service/window-service'
import { db } from './database'
import icon from '../../resources/icon.png?asset'
// 副作用：初始化主进程文件日志（electron-log，捕获 console 写入 userData/logs/main.log）
import { createLogger } from './utils/log'
import { cleanupOrphanAttachments } from './agent/attachment'
import { bashSessionManager } from './agent/tools/bash-session'

const log = createLogger('app')

// 应用显示名与打包产物（electron-builder productName）保持一致：
// 使菜单栏/Dock/任务栏/通知等各处不再以默认的 Electron 或包名 my-app 呈现。
// 注意需在 whenReady 之前设置；userData 路径在 db 模块 import 时已按旧名缓存，不受影响。
app.setName('桌面助手')

// 崩溃收集：本地落盘（不上报），dump 位于 app.getPath('crashDumps')，可在设置页打开查看
crashReporter.start({
  uploadToServer: false,
  compress: true
})

app.whenReady().then(() => {
  log.info('应用启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
    userData: app.getPath('userData')
  })

  // Set app user model id for windows（与 electron-builder appId 对齐，保证任务栏图标分组/通知归属正确）
  electronApp.setAppUserModelId('com.desktop-agent.app')

  // macOS：开发态（未打包）Dock 图标默认是 Electron 圆形图标，这里运行时设为品牌图标。
  // 打包后由 app bundle 内的 icns 提供，此处覆盖使两端表现一致。
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  // 应用主题唯一真源：启动时按 settings 恢复 nativeTheme.themeSource，
  // 渲染层（含标题栏视图）经 prefers-color-scheme 自动跟随
  applyStoredThemeMode()

  createMainWindow()
  createTray()
  createAppMenu()
  // 兜底清理孤儿附件（软删会话已到期/清空后残留的附件目录）
  void cleanupOrphanAttachments()
  // 启动时连接已启用的 MCP server（失败不影响启动，状态可在设置页查看）
  void ipcMainServices.mcp.connectAll()
  // 恢复窗口置顶偏好（设置页可开关，persisted in settings）
  if (db.getSetting<boolean>(SETTING_ALWAYS_ON_TOP)) {
    getMainWindow()?.setAlwaysOnTop(true)
    log.info('已恢复窗口置顶偏好')
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    // 窗口存在但被隐藏（关闭到托盘）时同样显示置前。
    if (BaseWindow.getAllWindows().length === 0) {
      log.info('Dock 图标激活，重建主窗口')
    }
    ensureMainWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  log.info('全部窗口已关闭', { platform: process.platform })
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  log.info('应用退出')
  // 放行窗口 close（托盘「退出」/ Cmd+Q）：否则关闭到托盘设置会拦截真实退出
  markQuitting()
  // 回收全部持久化 shell 与后台命令进程，避免孤儿进程
  bashSessionManager.disposeAll()
})
