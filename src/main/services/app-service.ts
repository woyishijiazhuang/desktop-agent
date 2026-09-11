import { app, shell } from 'electron'
import { IpcService } from 'electron-ipc-service'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { getLogFilePath, clearLogFile, createLogger } from '../utils/log'
import { fileUrlToPath } from '../utils/file-url'

const log = createLogger('appService')

export class AppService extends IpcService {
  static override readonly namespace = 'app'

  getAppVersion(): string {
    return app.getVersion()
  }

  /**
   * 在系统默认浏览器打开外部链接。
   * 仅允许 http/https 协议，防止 file:/javascript: 等协议被利用。
   */
  async openExternal(url: string): Promise<void> {
    let protocol: string
    try {
      protocol = new URL(url).protocol
    } catch {
      throw new Error(`无效的 URL: ${url}`)
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new Error(`仅支持 http/https 链接，收到: ${protocol}`)
    }
    log.info('在系统浏览器打开链接', { url })
    await shell.openExternal(url)
  }

  /**
   * 用系统默认程序打开本地文件/目录（渲染层点击 `[文字](file:///...)` markdown 链接）。
   * 渲染层只允许 file:// 协议的链接进入；此处再解码并校验为绝对路径，
   * 防止伪造协议（javascript: 等）或相对路径被利用。
   */
  async openLocalPath(fileUrl: string): Promise<void> {
    const path = fileUrlToPath(fileUrl)
    if (!path || !path.startsWith('/')) {
      throw new Error(`无效的本地文件链接: ${fileUrl}`)
    }
    log.info('打开本地文件', { fileUrl, path })
    const err = await shell.openPath(path)
    if (err) throw new Error(`无法打开文件: ${err}`)
  }

  // ==================== 开机自启 ====================

  /** Linux 自启 .desktop 文件名（固定 ASCII 名，避免中文文件名问题）。 */
  private static readonly linuxAutostartFile = 'desktop-agent.desktop'

  /** Linux 自启文件路径：$XDG_CONFIG_HOME/autostart 或 ~/.config/autostart
   *  （app.getPath('appData') 在 Linux 上即上述目录，与 XDG autostart 规范一致）。 */
  private static linuxAutostartFilePath(): string {
    return join(app.getPath('appData'), 'autostart', AppService.linuxAutostartFile)
  }

  /** Linux 自启的启动目标：AppImage 用 APPIMAGE 环境变量（运行时 execPath 是临时挂载点，路径不稳定），
   *  其余打包格式（deb 等）用可执行文件路径。 */
  private static linuxLaunchTarget(): string {
    return process.env.APPIMAGE ?? process.execPath
  }

  /**
   * 是否已设置为开机自启。
   * macOS/Windows 登录项状态由系统持久化；Linux 无原生支持，Electron API 为空操作，
   * 故改由 XDG autostart 目录下的 .desktop 文件判断。
   */
  getAutoLaunch(): boolean {
    if (process.platform === 'linux') {
      return existsSync(AppService.linuxAutostartFilePath())
    }
    return app.getLoginItemSettings().openAtLogin
  }

  /** 设置/取消开机自启。 */
  setAutoLaunch(enabled: boolean): void {
    if (process.platform === 'linux') {
      AppService.setLinuxAutoLaunch(enabled)
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled })
    }
    log.info('设置开机自启', { enabled })
  }

  /** Linux：写/删 XDG autostart .desktop 文件实现开机自启。 */
  private static setLinuxAutoLaunch(enabled: boolean): void {
    const filePath = AppService.linuxAutostartFilePath()
    if (!enabled) {
      rmSync(filePath, { force: true })
      return
    }
    // 仅打包后允许写入（开发态 execPath 为 electron 二进制，自启指向它没有意义）
    if (!app.isPackaged) {
      log.warn('开发态下跳过 Linux 开机自启设置')
      return
    }
    const content =
      [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${app.getName()}`,
        `Exec="${AppService.linuxLaunchTarget()}"`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true'
      ].join('\n') + '\n'
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
  }

  // ==================== 日志与崩溃诊断 ====================

  /** 日志与崩溃目录路径（设置页展示与一键打开）。日志目录取 electron-log 实际运行目录。 */
  getDiagnosticsInfo(): { logDir: string; crashDumpsDir: string } {
    return {
      logDir: dirname(getLogFilePath()),
      crashDumpsDir: app.getPath('crashDumps')
    }
  }

  /** 在系统文件管理器中打开指定诊断目录（仅限日志/崩溃两类白名单目录）。 */
  async openDiagnosticsDir(which: 'logs' | 'crashes'): Promise<void> {
    const dir = which === 'logs' ? dirname(getLogFilePath()) : app.getPath('crashDumps')
    // 首次运行日志文件尚未创建时，先确保目录存在再打开
    await mkdir(dir, { recursive: true })
    log.info('打开诊断目录', { which, dir })
    const err = await shell.openPath(dir)
    if (err) throw new Error(`无法打开目录: ${err}`)
  }

  /** 清空日志文件内容（保留文件本身，日志继续写入）。 */
  clearLogs(): boolean {
    log.info('清空日志文件')
    return clearLogFile()
  }
}
