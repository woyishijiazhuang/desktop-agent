import { app, BaseWindow, crashReporter } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
// pdfjs-dist（mdize 解析 PDF 用，主进程 Node 环境）依赖浏览器几何 API DOMMatrix，
// 其自带 polyfill 仅从 node-canvas 取（未安装）→ 提前注入第三方实现，避免解析 PDF 报
// 「DOMMatrix is not defined」。mdize 惰性加载，此处先注入即可覆盖后续所有文档解析。
import DOMMatrixPolyfill from '@thednp/dommatrix'
import { ipcMainServices } from './service'
import {
  getActiveWorkspaceWindow,
  markQuitting,
  restoreStartupWindows
} from './service/window-manager'
import { applyStoredThemeMode } from './service/theme-service'
import { createTray } from './service/tray-service'
import { createAppMenu } from './service/app-menu-service'
import { registerVoiceAssetScheme, installVoiceAssetProtocol } from './service/asset-protocol'
import icon from '../../resources/icon.png?asset'
// 副作用：初始化主进程文件日志（electron-log，捕获 console 写入 userData/logs/main.log）
import { createLogger } from './utils/log'
import { cleanupOrphanAttachments } from './agent/attachment'
import { bashSessionManager } from './agent/bash-session'
import { SETTING_CLOSE_TO_TRAY } from './agent/types'
import { db } from './database'

const log = createLogger('app')

// Node 主进程无 DOMMatrix 全局；注入 polyfill（仅当未定义时，避免覆盖未来 Electron 自带实现）
if (!('DOMMatrix' in globalThis)) {
  ;(globalThis as Record<string, unknown>).DOMMatrix = DOMMatrixPolyfill
}

// 应用显示名与打包产物（electron-builder productName）保持一致：
// 使菜单栏/Dock/任务栏/通知等各处不再以默认的 Electron 或包名 my-app 呈现。
// 注意需在 whenReady 之前设置；userData 路径在 db 模块 import 时已按旧名缓存，不受影响。
app.setName('桌面助手')

// 崩溃收集：本地落盘（不上报），dump 位于 app.getPath('crashDumps'），可在设置页打开查看
crashReporter.start({
  uploadToServer: false,
  compress: true
})

// 语音 VAD 资源协议（appasset://）：须在 app ready 前注册 scheme
registerVoiceAssetScheme()

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

  // 安装语音 VAD 资源协议处理器（appasset:// 供渲染进程 fetch onnx / ort wasm）
  installVoiceAssetProtocol()

  // 恢复工作区窗口：按 last_opened_at 倒序为每个工作区建窗口（无工作区时创建默认工作区）
  void restoreStartupWindows()
  createTray()
  createAppMenu()
  // 兜底清理孤儿附件（软删会话已到期/清空后残留的附件目录）
  void cleanupOrphanAttachments()
  // 启动时连接已启用的 MCP server（失败不影响启动，状态可在设置页查看）
  void ipcMainServices.mcp.connectAll()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    // 无窗口时恢复全部工作区窗口；窗口存在但被隐藏（关闭到托盘）时显示置前。
    if (BaseWindow.getAllWindows().length === 0) {
      log.info('Dock 图标激活，恢复工作区窗口')
      void restoreStartupWindows()
      return
    }
    // 有窗口时把最近的工作区窗口显示置前
    getActiveWorkspaceWindow()?.win.show()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
// 「关闭到托盘」开启时：全部窗口关闭后应用仍保留在托盘（后台 Agent 任务不中断），
// 可从托盘「显示/隐藏」唤回最近的工作区；关闭后不再恢复已关窗口。
app.on('window-all-closed', () => {
  log.info('全部窗口已关闭', { platform: process.platform })
  if (process.platform !== 'darwin' && !db.getSetting<boolean>(SETTING_CLOSE_TO_TRAY)) {
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
