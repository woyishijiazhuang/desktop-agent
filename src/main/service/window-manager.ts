import { BaseWindow, WebContentsView, nativeTheme, screen, shell } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { join } from 'path'
import { is, optimizer } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
// Windows 用多尺寸 ico（小帧内容撑满画布）：任务栏槽位仅 16~32px，直接缩带留白的
// 大图会导致任务栏图标偏小；macOS/Linux 仍走 icon.png（留白为 Dock 尺寸调校）
import winIcon from '../../../build/icon.ico?asset'
import { createLogger } from '../utils/log'
import { fileUrlToPath } from '../utils/file-url'
import { db } from '../database'
import { SETTING_CLOSE_TO_TRAY, SETTING_TITLE_BAR_MODE, type TitleBarMode } from '../agent/types'

const log = createLogger('window')

/**
 * BaseWindow + 双 WebContentsView 架构的窗口管理器。
 *
 * 背景：无边框 BrowserWindow 下整个窗口是单一 webContents，弹窗（NDialog mask /
 * dropdown / tooltip）会遮盖自定义标题栏。改为 BaseWindow 后：
 * - headerView：顶部 32px 独立视图（自定义标题栏），内容/弹窗永远无法遮盖它；
 * - contentView：其余区域承载应用本体，其内部弹窗被裁剪在自身边界内。
 *
 * 同时替代 BrowserWindow 的两处静态依赖：
 * - BrowserWindow.fromWebContents() → getWindowByWebContents()（注册表反查）；
 * - electron-ipc-service 的 createIpcMainClient（遍历 BrowserWindow.getAllWindows()）
 *   → broadcastToAllViews()（遍历本窗口全部视图）。
 */

/** 自定义标题栏高度（与 header 页面 body 高度保持一致）。 */
export const HEADER_HEIGHT = 32

/** 与渲染层 base.css 的 --bg token 对齐的主题底色（暗/亮）。resize 时 WebContentsView 重绘存在间隙，窗口自身底色需与内容一致，否则会闪现默认白底。 */
export const WINDOW_BG_DARK = '#18181b'
export const WINDOW_BG_LIGHT = '#ffffff'

/** Windows 原生标题栏（titleBarOverlay）配色，与 header 视图 --bg-soft / --text-1 token 对齐。 */
export const HEADER_BG_DARK = '#1f1f23'
export const HEADER_BG_LIGHT = '#fafafa'
export const HEADER_FG_DARK = '#f4f4f5'
export const HEADER_FG_LIGHT = '#18181b'

/** 按当前生效主题取窗口底色（nativeTheme 由主进程 themeSource 驱动，即应用主题）。 */
function currentWindowBg(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BG_DARK : WINDOW_BG_LIGHT
}

/**
 * 主题变化（切换模式 / 系统外观变化）时同步全部窗口底色与 Windows overlay 配色。
 * 渲染层经 prefers-color-scheme 自行跟随，主进程只需维护窗口/系统控件配色。
 */
nativeTheme.on('updated', () => {
  const bg = currentWindowBg()
  for (const win of BaseWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.setBackgroundColor(bg)
    if (
      process.platform === 'win32' &&
      db.getSetting<string>(SETTING_TITLE_BAR_MODE) !== 'custom'
    ) {
      const dark = nativeTheme.shouldUseDarkColors
      win.setTitleBarOverlay({
        color: dark ? HEADER_BG_DARK : HEADER_BG_LIGHT,
        symbolColor: dark ? HEADER_FG_DARK : HEADER_FG_LIGHT
      })
    }
  }
})

let mainWindow: BaseWindow | null = null
let headerView: WebContentsView | null = null
let contentView: WebContentsView | null = null
/** webContentsId → 所属 BaseWindow（供 WindowService 反查窗口）。 */
const windowByWebContents = new Map<number, BaseWindow>()

/** 应用退出标志：true 后窗口 close 不再拦截（托盘「退出」/ Cmd+Q 等真实退出流程）。 */
let quitting = false

/** 当前主窗口视图是否已加载完成（渲染层监听器就绪，可安全向渲染层推送托盘/菜单动作）。 */
let windowReady = false
/** 等待窗口就绪的 resolve 队列（ensureMainWindow 在窗口重建期间注册，窗口显示后统一唤醒）。 */
const windowReadyWaiters: Array<() => void> = []

/** Linux 原生标题栏模式：系统框接管，自绘 header 收起（高度 0）。Windows 原生模式改用 titleBarOverlay，header 仍可见。 */
let nativeFramed = false

/** 标记应用进入退出流程（before-quit 时置位，放行窗口关闭）。 */
export function markQuitting(): void {
  quitting = true
}

export interface MainWindowBounds {
  width: number
  height: number
  x: number
  y: number
}

/**
 * 按主屏工作区分辨率等比选择初始窗口尺寸，并居中到工作区（避开任务栏/Dock）。
 * - 宽取工作区 ~66%、高取 ~72%，保证不同分辨率下都有合适大小
 * - 用 min/max 约束：过小布局拥挤，过大在高分屏上内容密度失衡
 * - 最终再用工作区宽高封顶，确保窗口始终能完整放入屏幕
 */
function computeInitialBounds(): MainWindowBounds {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(Math.max(Math.round(workArea.width * 0.66), 960), 1800, workArea.width)
  const height = Math.min(Math.max(Math.round(workArea.height * 0.72), 680), 1200, workArea.height)
  const x = workArea.x + Math.floor((workArea.width - width) / 2)
  const y = workArea.y + Math.floor((workArea.height - height) / 2)
  return { width, height, x, y }
}

/**
 * BaseWindow 不触发 app 的 browser-window-created 事件，需手动为两个
 * WebContentsView 挂上快捷键（F12 开/关 DevTools，生产屏蔽 Ctrl/Cmd+R 等）。
 * watchWindowShortcuts 类型签名是 BrowserWindow，这里传最小结构即可。
 */
function wireViewShortcuts(): void {
  const close = (): void => mainWindow?.close()
  const header = headerView?.webContents
  const content = contentView?.webContents
  if (header)
    optimizer.watchWindowShortcuts({ webContents: header, close } as unknown as BrowserWindow)
  if (content)
    optimizer.watchWindowShortcuts({ webContents: content, close } as unknown as BrowserWindow)
}

/** 按当前窗口尺寸重排两个视图（窗口 resize / 全屏 / 最大化时触发）。 */
function layout(): void {
  if (!mainWindow || !headerView || !contentView) return
  const { width, height } = mainWindow.getContentBounds()
  if (nativeFramed) {
    // Linux 原生标题栏：系统框已提供窗口控制，自绘 header 收起
    headerView.setBounds({ x: 0, y: 0, width, height: 0 })
    contentView.setBounds({ x: 0, y: 0, width, height })
    return
  }
  headerView.setBounds({ x: 0, y: 0, width, height: HEADER_HEIGHT })
  contentView.setBounds({
    x: 0,
    y: HEADER_HEIGHT,
    width,
    height: Math.max(0, height - HEADER_HEIGHT)
  })
}

export function createMainWindow(bounds?: MainWindowBounds, replace = false): void {
  // replace=true 用于标题栏模式的无缝重建：旧窗口暂不销毁，等新窗口加载完成
  // 显示后再拆除旧窗口，避免「销毁 → 重建」之间的空窗期闪烁
  if (mainWindow && !replace) return

  const initialBounds = bounds ?? computeInitialBounds()
  const isMac = process.platform === 'darwin'
  // 标题栏模式（默认 native：优先当前平台原生窗口栏，设置页可切回自绘）
  const modeRaw = db.getSetting<string>(SETTING_TITLE_BAR_MODE)
  const titleBarMode: TitleBarMode = modeRaw === 'custom' ? 'custom' : 'native'
  // Linux 原生模式：系统标题栏接管，自绘 header 收起；
  // Windows 原生模式改用 titleBarOverlay（系统按钮 + 应用配色），header 保留为可随主题换色的标题栏
  nativeFramed = process.platform === 'linux' && titleBarMode === 'native'
  // 生效主题以主进程 nativeTheme 为准（themeSource 由设置驱动，应用主题可独立于系统）
  const dark = nativeTheme.shouldUseDarkColors

  const win = new BaseWindow({
    ...initialBounds,
    // 限制窗口最小尺寸，防止被拖到布局无法承载的极小状态
    minWidth: 960,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    // 原生标题栏模式下各平台展示系统窗口栏：
    // - macOS：titleBarStyle 'hidden' 保留红绿灯（frame:false 会隐藏它们）
    // - Windows：titleBarStyle 'hidden' + titleBarOverlay，隐藏系统标题栏但保留系统窗口按钮，
    //   标题栏底色/图标色由应用控制（可随主题变化）
    // - Linux：默认系统框（标题 + 最小化/最大化/关闭）
    // 自定义模式：无边框，由自绘 header 提供窗口控制
    title: '桌面助手',
    ...(isMac
      ? titleBarMode === 'native'
        ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 10 } }
        : { frame: false }
      : process.platform === 'win32' && titleBarMode === 'native'
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: {
              color: dark ? HEADER_BG_DARK : HEADER_BG_LIGHT,
              symbolColor: dark ? HEADER_FG_DARK : HEADER_FG_LIGHT,
              height: HEADER_HEIGHT
            }
          }
        : titleBarMode === 'native'
          ? {}
          : { frame: false }),
    // 按生效主题预置窗口底色（nativeTheme 已由设置驱动），避免首帧露出白底
    backgroundColor: currentWindowBg(),
    // Linux 窗口栏 / Windows 任务栏图标（开发态默认是 Electron 图标，这里显式指定品牌图标）
    ...(process.platform === 'win32'
      ? { icon: winIcon }
      : process.platform === 'linux'
        ? { icon }
        : {})
  })
  mainWindow = win
  // 新窗口视图未加载完成前不算就绪，托盘/菜单动作需等渲染层监听器注册后再发送
  windowReady = false
  // 自定义模式（macOS）：隐藏系统红绿灯，由自绘标题栏按钮接管窗口控制
  if (isMac && titleBarMode !== 'native') {
    win.setWindowButtonVisibility(false)
  }
  log.info('创建主窗口', { bounds: initialBounds, minSize: [960, 680], titleBarMode })

  const webPreferences = { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  headerView = new WebContentsView({ webPreferences })
  contentView = new WebContentsView({ webPreferences })
  // 视图首帧绘制前是透明的，会透出窗口底色；显式给视图也铺上主题底色，避免加载期间闪现白色
  const viewBg = currentWindowBg()
  headerView.setBackgroundColor(viewBg)
  contentView.setBackgroundColor(viewBg)
  mainWindow.contentView.addChildView(headerView)
  mainWindow.contentView.addChildView(contentView)
  windowByWebContents.set(headerView.webContents.id, mainWindow)
  windowByWebContents.set(contentView.webContents.id, mainWindow)

  // BaseWindow 无 ready-to-show，任一视图首帧渲染完成后显示窗口
  let shown = false
  const showOnce = (): void => {
    if (shown) return
    shown = true
    log.info('视图渲染完成，显示窗口')
    win.show()
  }
  headerView.webContents.once('did-finish-load', showOnce)
  contentView.webContents.once('did-finish-load', showOnce)
  // 渲染层监听器就绪的判定必须以内容视图（应用本体）为准：
  // 标题栏视图很小，几乎总是先于应用完成加载，若按其时机放行，托盘/菜单动作
  // 广播时应用还未注册监听器，消息会丢失（表现为只打开应用、不执行跳转）。
  contentView.webContents.once('did-finish-load', () => {
    windowReady = true
    for (const resolve of windowReadyWaiters) resolve()
    windowReadyWaiters.length = 0
  })
  headerView.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error('标题栏视图加载失败', { code, desc })
  })
  contentView.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error('内容视图加载失败', { code, desc })
  })

  // 外链一律交给系统浏览器
  contentView.webContents.setWindowOpenHandler((details) => {
    log.info('外链交由系统浏览器打开', { url: details.url })
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // file:// 链接（agent 回复的 `[文字](file:///...)` markdown 链接等）：
  // 渲染层已拦截点击并走 IPC（app.openLocalPath）打开本地文件，导航不会发生；
  // 此处兜底拦截极少数漏网的导航（如生产环境 file 源页面触发的同协议导航）。
  contentView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) return
    event.preventDefault()
    const path = fileUrlToPath(url)
    if (!path) {
      log.warn('file:// 链接解析路径失败', { url })
      return
    }
    log.info('打开本地路径', { url, path })
    void shell.openPath(path)
  })

  win.on('resize', layout)

  // 关闭到托盘：设置开启且非退出流程时拦截关闭、隐藏窗口。
  // 适用场景：Windows/Linux 上关窗默认会退出应用，拦截后 main 进程保持存活，
  // 正在后台运行的 Agent 任务不会中断，可从托盘随时唤回。
  win.on('close', (e) => {
    if (quitting) return
    if (db.getSetting<boolean>(SETTING_CLOSE_TO_TRAY)) {
      e.preventDefault()
      win.hide()
      log.info('关闭窗口：最小化到托盘')
    }
  })

  // BaseWindow 关闭时不会自动销毁子视图的 webContents，需手动 close 防止内存泄漏。
  // 实例守卫：标题栏模式切换会重建窗口，旧窗口的 closed 不得误清新窗口状态。
  win.on('closed', () => {
    if (mainWindow !== win) return
    log.info('主窗口已关闭')
    const closeView = (view: WebContentsView | null): void => {
      // webContents 在销毁瞬间可能已置空（Electron 41+ 行为），先判空再判 isDestroyed
      if (view && view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    }
    closeView(headerView)
    closeView(contentView)
    headerView = null
    contentView = null
    mainWindow = null
    windowByWebContents.clear()
  })

  layout()
  wireViewShortcuts()
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    headerView.webContents.loadURL(`${base}/header/index.html`)
    contentView.webContents.loadURL(base)
  } else {
    headerView.webContents.loadFile(join(__dirname, '../renderer/header/index.html'))
    contentView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 重建主窗口：标题栏模式切换后调用（frame/titleBarStyle 在构造时生效）。
 * 保留窗口位置与尺寸。
 *
 * 无缝切换策略：先创建新窗口（show:false，两个视图加载完成才显示），期间旧窗口
 * 保持可见；新窗口显示后再拆除旧窗口，消除「旧窗口销毁 → 新窗口加载」之间的
 * 空窗期闪烁。旧窗口用 destroy 绕过 close 拦截（关闭到托盘设置），且不触发 beforeunload。
 */
export function recreateMainWindow(): void {
  const old = mainWindow
  if (!old) return
  const bounds = old.getBounds()
  // createMainWindow 会立刻把模块级 headerView/contentView 指向新窗口的视图，
  // 旧视图需先在此保留引用，用于之后卸载与销毁
  const oldViews = [headerView, contentView].filter((v): v is WebContentsView => v != null)
  const oldIds = new Set(oldViews.map((v) => v.webContents.id))

  // 先建新窗口（替换模式），期间旧窗口保持可见
  createMainWindow(bounds, true)

  const newWin = mainWindow
  if (!newWin || newWin === old) return

  // 新窗口显示后再拆除旧窗口：位置尺寸相同，视觉上无缝切换
  newWin.once('show', () => {
    for (const view of oldViews) {
      try {
        old.contentView.removeChildView(view)
      } catch {
        // 视图已不在窗口上，忽略
      }
    }
    // 旧窗口 closed 处理器因 mainWindow 已换新会提前返回，注销旧视图的
    // 窗口反查条目需在此手动完成
    for (const id of oldIds) windowByWebContents.delete(id)
    old.destroy()
    // BaseWindow 销毁不会自动销毁子视图的 webContents，需手动 close 防内存泄漏
    for (const view of oldViews) {
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    }
  })
}

export function getMainWindow(): BaseWindow | null {
  return mainWindow
}

export function getHeaderView(): WebContentsView | null {
  return headerView
}

export function getContentView(): WebContentsView | null {
  return contentView
}

/** 由 IPC 消息来源 webContents 反查所属窗口（替代 BrowserWindow.fromWebContents）。 */
export function getWindowByWebContents(webContents: WebContents): BaseWindow | null {
  return windowByWebContents.get(webContents.id) ?? null
}

/** 向全部视图的 webContents 广播消息（fire-and-forget，替代 createIpcMainClient）。 */
export function broadcastToAllViews(channel: string, message: unknown): void {
  headerView?.webContents.send(channel, message)
  contentView?.webContents.send(channel, message)
}

/**
 * 显示主窗口；窗口已销毁则按初始尺寸重建（macOS 关窗后应用常驻，
 * 从托盘/程序坞唤回时需重建窗口）。
 *
 * 返回的 Promise 在窗口视图加载完成（渲染层就绪）后 resolve：
 * 托盘/菜单动作需等渲染层监听器注册完成再广播，否则消息会丢失
 *（典型场景：macOS 关窗后窗口销毁，重建是异步的，动作发送过早时渲染层还未加载）。
 */
export function ensureMainWindow(): Promise<void> {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (windowReady) return Promise.resolve()
  } else {
    createMainWindow(computeInitialBounds())
  }
  return new Promise((resolve) => {
    windowReadyWaiters.push(resolve)
  })
}
