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
import { db, resolveDefaultWorkdir } from '../database'
import { SETTING_TITLE_BAR_MODE, type TitleBarMode } from '../agent/types'

const log = createLogger('window')

/** 窗口置顶偏好设置键（settings 表，见 setAlwaysOnTop）。 */
export const SETTING_ALWAYS_ON_TOP = 'window.alwaysOnTop'

/** 上次退出时处于打开状态的工作区窗口（string[]，启动时据此恢复）。 */
export const SETTING_OPEN_WORKSPACES = 'workspace.openWindows'

/**
 * BaseWindow + 双 WebContentsView 架构的多窗口管理器。
 *
 * 背景：无边框 BrowserWindow 下整个窗口是单一 webContents，弹窗（NDialog mask /
 * dropdown / tooltip）会遮盖自定义标题栏。改为 BaseWindow 后：
 * - headerView：顶部 32px 独立视图（自定义标题栏），内容/弹窗永远无法遮盖它；
 * - contentView：其余区域承载应用本体，其内部弹窗被裁剪在自身边界内。
 *
 * 多窗口模型（工作区架构）：
 * - 工作区窗口：每个绑定一个 workdir，展示该工作区的会话（session 按 workdir 隔离）；
 * - 设置窗口：不绑定 workdir，承载全局设置（独立窗口，见 openSettingsWindow）。
 * 同一 workdir 只允许一个窗口；窗口位置/尺寸写回 workspaces.bounds 供下次恢复。
 *
 * 同时替代 BrowserWindow 的两处静态依赖：
 * - BrowserWindow.fromWebContents() → getAppWindowByWebContents()（注册表反查）；
 * - electron-ipc-service 的 createIpcMainClient（遍历 BrowserWindow.getAllWindows()）
 *   → sendToAppWindow() / broadcastToViews()（按窗口/工作区定向发送）。
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

// ==================== 应用窗口模型 ====================

/** 应用窗口：工作区窗口（workdir 非空）或设置窗口（workdir 为 null）。 */
export interface AppWindow {
  win: BaseWindow
  headerView: WebContentsView
  contentView: WebContentsView
  /** 所属工作区（workdir 绝对路径）；null = 设置窗口。 */
  workdir: string | null
  /** 内容视图渲染层监听器是否已就绪（可安全向渲染层推送托盘/菜单动作）。 */
  ready: boolean
}

/** 全部应用窗口（工作区窗口 + 设置窗口）。 */
const appWindows: AppWindow[] = []
/** webContentsId → 所属 AppWindow（供 IPC 反查窗口/工作区）。 */
const windowByWebContents = new Map<number, AppWindow>()
/** 等待窗口就绪的 resolve 队列（窗口重建期间注册，加载完成后统一唤醒）。 */
const readyWaiters = new Map<AppWindow, Array<() => void>>()

/** 应用退出标志：true 后窗口 close 不再拦截（托盘「退出」/ Cmd+Q 等真实退出流程）。 */
let quitting = false
/** 最近聚焦的工作区窗口（托盘「显示隐藏」/「新建对话」目标）。 */
let activeWorkspace: AppWindow | null = null

/** Linux 原生标题栏模式：系统框接管，自绘 header 收起（高度 0）。Windows 原生模式改用 titleBarOverlay，header 仍可见。 */
let nativeFramed = false

/** 窗口关闭守卫（service/index.ts 注册）：返回 'allow' 放行关闭；'blocked' 表示已阻止
 *（如弹确认框后用户取消，或守卫内部已处理销毁）。用于「正在生成时关窗需确认」。 */
export type WindowCloseGuard = (aw: AppWindow) => Promise<'allow' | 'blocked'>
let windowCloseGuard: WindowCloseGuard | null = null

/** 注册窗口关闭守卫（在 service/index.ts 中接线，避免 window-manager 反向依赖 agent）。 */
export function setWindowCloseGuard(guard: WindowCloseGuard): void {
  windowCloseGuard = guard
}

/** 标记应用进入退出流程（before-quit 时置位，放行窗口关闭）。 */
export function markQuitting(): void {
  // 先记录当前打开的工作区窗口，再放行关闭：窗口关闭会逐个触发 closed 清理，
  // 若在 closed 中再持久化会把列表清空，故退出前必须提前落盘。
  persistOpenWorkspaces()
  quitting = true
}

/**
 * 把当前打开的工作区窗口列表写入 settings（启动时 restoreStartupWindows 据此恢复）。
 * 只统计**可见**的窗口：关闭到托盘（hide）视为已关闭，不应在下次启动时恢复；
 * 最小化仍算可见（isVisible 为 true）。打开/关闭工作区窗口时更新；
 * 退出流程由 markQuitting 在窗口关闭前持久化。
 */
function persistOpenWorkspaces(): void {
  try {
    db.setSetting(
      SETTING_OPEN_WORKSPACES,
      appWindows
        .filter((aw) => aw.workdir !== null && aw.win.isVisible())
        .map((aw) => aw.workdir as string)
    )
  } catch (err) {
    log.warn('保存打开的工作区列表失败', { error: err })
  }
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
 * 设置窗口初始尺寸：设置界面相对轻量，窗口取工作区 ~50% 宽 / ~62% 高并居中，
 * 明显小于工作区窗口（66%×72%），避免打开时铺满大屏。
 */
function computeSettingsBounds(): MainWindowBounds {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(Math.max(Math.round(workArea.width * 0.5), 760), 1120, workArea.width)
  const height = Math.min(Math.max(Math.round(workArea.height * 0.62), 560), 820, workArea.height)
  const x = workArea.x + Math.floor((workArea.width - width) / 2)
  const y = workArea.y + Math.floor((workArea.height - height) / 2)
  return { width, height, x, y }
}

// ==================== 窗口创建与生命周期 ====================

/** 等待窗口视图加载完成（渲染层就绪）。已就绪直接 resolve。 */
function waitForReady(aw: AppWindow): Promise<void> {
  if (aw.ready) return Promise.resolve()
  return new Promise((resolve) => {
    const list = readyWaiters.get(aw) ?? []
    list.push(resolve)
    readyWaiters.set(aw, list)
  })
}

/** 显示并聚焦窗口（最小化时先恢复）。 */
function showWindow(aw: AppWindow): void {
  const { win } = aw
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * BaseWindow 不触发 app 的 browser-window-created 事件，需手动为两个
 * WebContentsView 挂上快捷键（F12 开/关 DevTools，生产屏蔽 Ctrl/Cmd+R 等）。
 * watchWindowShortcuts 类型签名是 BrowserWindow，这里传最小结构即可。
 */
function wireViewShortcuts(aw: AppWindow): void {
  const close = (): void => aw.win.close()
  optimizer.watchWindowShortcuts({
    webContents: aw.headerView.webContents,
    close
  } as unknown as BrowserWindow)
  optimizer.watchWindowShortcuts({
    webContents: aw.contentView.webContents,
    close
  } as unknown as BrowserWindow)
}

/** 按当前窗口尺寸重排两个视图（窗口 resize / 全屏 / 最大化时触发）。 */
function layout(aw: AppWindow): void {
  const { win, headerView, contentView } = aw
  const { width, height } = win.getContentBounds()
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

/** 加载应用视图：工作区窗口加载聊天页；设置窗口加载 #/settings。 */
function loadAppViews(aw: AppWindow): void {
  const isSettings = aw.workdir === null
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    aw.headerView.webContents.loadURL(`${base}/header/index.html`)
    aw.contentView.webContents.loadURL(isSettings ? `${base}/#/settings` : base)
  } else {
    aw.headerView.webContents.loadFile(join(__dirname, '../renderer/header/index.html'))
    aw.contentView.webContents.loadFile(
      join(__dirname, '../renderer/index.html'),
      isSettings ? { hash: '/settings' } : undefined
    )
  }
}

/**
 * 创建应用窗口（工作区窗口或设置窗口）。workdir 非空时：
 * - 位置/尺寸变更写回 workspaces.bounds（重启恢复）；
 * - 聚焦时登记为 activeWorkspace（托盘动作目标）。
 */
function createAppWindow(workdir: string | null, bounds?: MainWindowBounds): AppWindow {
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
    // 限制窗口最小尺寸，防止被拖到布局无法承载的极小状态；设置窗口允许更小
    minWidth: workdir === null ? 720 : 960,
    minHeight: workdir === null ? 520 : 680,
    show: false,
    autoHideMenuBar: true,
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
  // 恢复窗口置顶偏好（设置页可开关，持久化在 settings 表，见 setAlwaysOnTop）
  if (db.getSetting<boolean>(SETTING_ALWAYS_ON_TOP)) {
    win.setAlwaysOnTop(true)
  }
  // 自定义模式（macOS）：隐藏系统红绿灯，由自绘标题栏按钮接管窗口控制
  if (isMac && titleBarMode !== 'native') {
    win.setWindowButtonVisibility(false)
  }

  const webPreferences = { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  const headerView = new WebContentsView({ webPreferences })
  const contentView = new WebContentsView({ webPreferences })
  const aw: AppWindow = { win, headerView, contentView, workdir, ready: false }
  // 视图首帧绘制前是透明的，会透出窗口底色；显式给视图也铺上主题底色，避免加载期间闪现白色
  const viewBg = currentWindowBg()
  headerView.setBackgroundColor(viewBg)
  contentView.setBackgroundColor(viewBg)
  win.contentView.addChildView(headerView)
  win.contentView.addChildView(contentView)
  windowByWebContents.set(headerView.webContents.id, aw)
  windowByWebContents.set(contentView.webContents.id, aw)
  appWindows.push(aw)
  log.info('创建应用窗口', {
    workdir,
    bounds: initialBounds,
    titleBarMode,
    windowCount: appWindows.length
  })

  // BaseWindow 无 ready-to-show，任一视图首帧渲染完成后显示窗口
  let shown = false
  const showOnce = (): void => {
    if (shown) return
    shown = true
    win.show()
  }
  headerView.webContents.once('did-finish-load', showOnce)
  contentView.webContents.once('did-finish-load', showOnce)
  // 渲染层监听器就绪的判定必须以内容视图（应用本体）为准：
  // 标题栏视图很小，几乎总是先于应用完成加载，若按其时机放行，托盘/菜单动作
  // 广播时应用还未注册监听器，消息会丢失（表现为只打开应用、不执行跳转）。
  contentView.webContents.once('did-finish-load', () => {
    aw.ready = true
    const waiters = readyWaiters.get(aw)
    if (waiters) {
      for (const resolve of waiters) resolve()
      readyWaiters.delete(aw)
    }
  })
  headerView.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error('标题栏视图加载失败', { workdir, code, desc })
  })
  contentView.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error('内容视图加载失败', { workdir, code, desc })
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

  win.on('resize', () => layout(aw))

  // 工作区窗口专属行为：位置记忆 + 聚焦登记
  if (workdir) {
    const persistBounds = (): void => {
      try {
        db.upsertWorkspace(workdir, { bounds: JSON.stringify(win.getBounds()) })
      } catch (err) {
        log.warn('保存窗口位置失败', { workdir, error: err })
      }
    }
    win.on('resize', persistBounds)
    win.on('moved', persistBounds)
    win.on('focus', () => {
      activeWorkspace = aw
      // 聚焦时刷新窗口标题（工作区重命名后，原生标题栏/任务栏显示最新名称）
      updateAppWindowTitle(aw)
    })
    if (!activeWorkspace) activeWorkspace = aw
  }

  // 关闭窗口即真正关闭（销毁）：不拦截、不隐藏。
  // 「关闭到托盘」的语义由 window-all-closed 承载（全部窗口关闭后应用保留在托盘，
  // 后台 Agent 任务继续运行，可从托盘唤回），不再是"隐藏单个窗口"。
  // 关闭守卫：工作区有会话正在生成时先弹确认（确认后中断生成再关闭），
  // 避免 AI 静默后台运行、触发审批/askUser 而无人处理；最小化不经过 close，不受影响。
  let closeConfirmed = false
  win.on('close', (e) => {
    if (quitting || closeConfirmed) return
    const guard = windowCloseGuard
    if (!guard) return
    // 先阻止默认关闭，异步询问守卫后再决定；'allow' 时置位标志重新 close
    e.preventDefault()
    void guard(aw).then((decision) => {
      if (decision === 'allow') {
        closeConfirmed = true
        win.close()
      }
    })
  })

  // BaseWindow 关闭时不会自动销毁子视图的 webContents，需手动 close 防止内存泄漏。
  // 按 AppWindow 实例清理注册表，标题栏模式重建时旧窗口的 closed 不得误清新窗口状态。
  win.on('closed', () => {
    const idx = appWindows.indexOf(aw)
    if (idx >= 0) appWindows.splice(idx, 1)
    for (const [id, w] of windowByWebContents) {
      if (w === aw) windowByWebContents.delete(id)
    }
    if (activeWorkspace === aw) activeWorkspace = null
    // webContents 在销毁瞬间可能已置空（Electron 41+ 行为），先判空再判 isDestroyed
    const closeView = (view: WebContentsView): void => {
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    }
    closeView(headerView)
    closeView(contentView)
    // 退出流程中 markQuitting 已在窗口关闭前持久化，此处跳过避免清空列表
    if (!quitting) persistOpenWorkspaces()
    log.info('应用窗口已关闭', { workdir })
  })

  layout(aw)
  wireViewShortcuts(aw)
  updateAppWindowTitle(aw)
  loadAppViews(aw)
  return aw
}

// ==================== 工作区窗口 ====================

/**
 * 打开工作区窗口：已存在则显示并聚焦；否则创建（优先恢复 workspaces.bounds）。
 * 返回的 Promise 在窗口视图加载完成（渲染层就绪）后 resolve。
 * touch=true（默认）时刷新 last_opened_at（启动恢复应传 false，避免重排恢复顺序）。
 */
export async function openWorkspaceWindow(
  workdir: string,
  opts?: { bounds?: MainWindowBounds; touch?: boolean }
): Promise<AppWindow> {
  const existing = getWorkspaceWindow(workdir)
  if (existing) {
    showWindow(existing)
    if (opts?.touch !== false) db.touchWorkspace(workdir)
    // 从托盘/菜单重新显示隐藏窗口：同步打开列表（含已显示状态）
    persistOpenWorkspaces()
    return existing
  }
  const ws = db.getWorkspace(workdir)
  const bounds =
    opts?.bounds ?? (ws?.bounds ? (JSON.parse(ws.bounds) as MainWindowBounds) : undefined)
  const aw = createAppWindow(workdir, bounds)
  showWindow(aw)
  if (opts?.touch !== false) db.touchWorkspace(workdir)
  persistOpenWorkspaces()
  await waitForReady(aw)
  return aw
}

/** 关闭工作区窗口（仅关窗，工作区与会话保留；重新打开见 openWorkspaceWindow）。 */
export function closeWorkspaceWindow(workdir: string): void {
  getWorkspaceWindow(workdir)?.win.close()
}

/** 强制销毁工作区窗口（绕过关闭守卫；用于删除工作区等已二次确认的销毁场景）。 */
export function forceCloseWorkspaceWindow(workdir: string): void {
  getWorkspaceWindow(workdir)?.win.destroy()
}

/** 全部工作区窗口（按打开顺序）。 */
export function getWorkspaceWindows(): AppWindow[] {
  return appWindows.filter((aw) => aw.workdir !== null)
}

export function getWorkspaceWindow(workdir: string): AppWindow | undefined {
  return appWindows.find((aw) => aw.workdir === workdir)
}

/** 最近聚焦的工作区窗口（托盘/菜单「显示隐藏」「新建对话」目标）。 */
export function getActiveWorkspaceWindow(): AppWindow | undefined {
  return activeWorkspace ?? getWorkspaceWindows()[0]
}

// ==================== 设置窗口 ====================

/** 打开设置窗口（单例；已存在则显示聚焦）。窗口尺寸取专用初始值，明显小于工作区窗口。 */
export async function openSettingsWindow(): Promise<AppWindow> {
  const existing = appWindows.find((aw) => aw.workdir === null)
  if (existing) {
    showWindow(existing)
    return existing
  }
  const aw = createAppWindow(null, computeSettingsBounds())
  showWindow(aw)
  await waitForReady(aw)
  return aw
}

export function getSettingsWindow(): AppWindow | undefined {
  return appWindows.find((aw) => aw.workdir === null)
}

// ==================== 启动恢复与全局重建 ====================

/**
 * 启动时恢复工作区窗口：优先恢复「上次退出时打开」的工作区窗口（settings 的
 * workspace.openWindows，退出时由 markQuitting 落盘）；无记录（首次启动）或
 * 记录的窗口均已失效时，打开默认工作区（用户数据目录下的 work，与迁移逻辑一致）。
 */
export async function restoreStartupWindows(): Promise<void> {
  const saved = db.getSetting<string[]>(SETTING_OPEN_WORKSPACES) ?? []
  const existing = new Set(db.listWorkspaces().map((w) => w.workdir))
  if (saved.length > 0) {
    for (const workdir of saved) {
      if (existing.has(workdir)) await openWorkspaceWindow(workdir, { touch: false })
    }
    // 保存的窗口全部失效（工作区已被删除）时兜底打开默认工作区
    if (getWorkspaceWindows().length === 0) {
      await openDefaultWorkspace()
    }
    return
  }
  log.info('无上次打开记录，打开默认工作区')
  await openDefaultWorkspace()
}

/** 打开默认工作区：优先用户数据目录下 work 的既有行，否则取最早创建的工作区，都没有则注册新建。 */
async function openDefaultWorkspace(): Promise<void> {
  const defaultDir = resolveDefaultWorkdir()
  const workspaces = db.listWorkspaces()
  const target =
    workspaces.find((w) => w.workdir === defaultDir)?.workdir ??
    workspaces[0]?.workdir ??
    db.upsertWorkspace(defaultDir).workdir
  await openWorkspaceWindow(target, { touch: false })
}

/**
 * 重建全部应用窗口：标题栏模式切换后调用（frame/titleBarStyle 在构造时生效）。
 * 保留各窗口位置尺寸。无缝策略：新窗口 show:false 创建，**旧窗口保持可见**，
 * 待新窗口视图加载完成自动 show（同位置覆盖）后再 destroy 旧窗口；
 * 绝不能提前 hide 旧窗口——否则全部旧窗口瞬间消失、再逐个加载出现，造成明显闪烁。
 * destroy 绕过 close 拦截（关闭到托盘设置）。
 */
export function recreateAllWindows(): void {
  // 当前聚焦窗口（通常是触发切换的设置窗口）最后重建：其新窗口最后 show、保持在最上层，
  // 否则设置窗口可能被随后显示的工作区窗口盖住。
  const list = [...appWindows].sort((a, b) => Number(a.win.isFocused()) - Number(b.win.isFocused()))
  for (const aw of list) {
    const bounds = aw.win.getBounds()
    const replacement = createAppWindow(aw.workdir, bounds)
    replacement.win.once('show', () => aw.win.destroy())
  }
}

// ==================== 访问器 ====================

/** 取路径末段作为默认工作区名（workspaces 行缺失时兜底，与 database 迁移逻辑一致）。 */
function fallbackWorkspaceName(workdir: string): string {
  const parts = workdir.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last || workdir
}

/**
 * 同步应用窗口标题：工作区窗口显示「工作区名 - 桌面助手」，设置窗口显示「设置 - 桌面助手」。
 * 原生标题栏场景（Linux 系统框 / Windows titleBarOverlay / macOS 隐藏式标题栏）与任务栏
 * 均以窗口标题展示工作区名，与自绘 header 内的工作区名保持一致；重命名后在聚焦时刷新。
 */
export function updateAppWindowTitle(aw: AppWindow): void {
  if (aw.workdir) {
    const name = db.getWorkspace(aw.workdir)?.name ?? fallbackWorkspaceName(aw.workdir)
    aw.win.setTitle(`${name} - 桌面助手`)
  } else {
    aw.win.setTitle('设置 - 桌面助手')
  }
}

export function getAppWindowByWebContents(webContents: WebContents): AppWindow | undefined {
  return windowByWebContents.get(webContents.id)
}

/** 由 IPC 消息来源 webContents 反查所属工作区（替代 BrowserWindow.fromWebContents 的作用域判定）。 */
export function getWorkspaceByWebContents(
  webContents: WebContents
): { workdir: string } | undefined {
  const aw = windowByWebContents.get(webContents.id)
  return aw?.workdir ? { workdir: aw.workdir } : undefined
}

/** 最近聚焦的应用窗口（菜单「标题栏开发者工具」等）。 */
export function getFocusedAppWindow(): AppWindow | undefined {
  for (const win of BaseWindow.getAllWindows()) {
    if (win.isFocused() && !win.isDestroyed()) {
      return appWindows.find((aw) => aw.win === win)
    }
  }
  return activeWorkspace ?? appWindows[0]
}

/** 设置窗口置顶并持久化偏好（重启后 createAppWindow 恢复）。 */
export function setAlwaysOnTop(win: BaseWindow, on: boolean): void {
  win.setAlwaysOnTop(on)
  db.setSetting(SETTING_ALWAYS_ON_TOP, on)
}

// ==================== 推送 ====================

/** 视图广播目标。 */
export type ViewTarget = 'all' | 'header' | 'content'

/** 向单个应用窗口的指定视图发送消息（fire-and-forget，替代 createIpcMainClient）。
 * 窗口销毁瞬间（closed 清理前）可能仍有在途事件，逐视图判 isDestroyed 避免
 * 向已销毁的 webContents.send 抛「Object has been destroyed」。 */
export function sendToAppWindow(
  aw: AppWindow | undefined,
  channel: string,
  message: unknown,
  target: ViewTarget = 'all'
): void {
  if (!aw || aw.win.isDestroyed()) return
  const headerAlive = aw.headerView.webContents && !aw.headerView.webContents.isDestroyed()
  const contentAlive = aw.contentView.webContents && !aw.contentView.webContents.isDestroyed()
  if ((target === 'header' || target === 'all') && headerAlive) {
    aw.headerView.webContents.send(channel, message)
  }
  if ((target === 'content' || target === 'all') && contentAlive) {
    aw.contentView.webContents.send(channel, message)
  }
}

/** 向指定工作区的窗口发送消息。 */
export function sendToWorkspace(
  workdir: string,
  channel: string,
  message: unknown,
  target: ViewTarget = 'all'
): void {
  sendToAppWindow(getWorkspaceWindow(workdir), channel, message, target)
}

/** 向全部应用窗口广播（主题/模型配置等全局事件）。 */
export function broadcastToViews(
  channel: string,
  message: unknown,
  target: ViewTarget = 'all'
): void {
  for (const aw of appWindows) sendToAppWindow(aw, channel, message, target)
}
