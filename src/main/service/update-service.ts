import { app } from 'electron'
import { IpcService } from 'electron-ipc-service'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import { db } from '../database'
import { SETTING_AUTO_UPDATE_ENABLED } from '../agent/types'
import { createLogger } from '../utils/log'
import { rendererClient } from './render-client'
import { notifyAgentFinished } from './notifier'

const log = createLogger('updater')

/**
 * 自动更新（electron-updater）：
 * - 更新源由打包期写入的 app-update.yml 决定（electron-builder.yml publish: github，
 *   仓库 woyishijiazhuang/desktop-agent；发布用 `electron-builder --publish always` + GH_TOKEN）
 * - 仅打包版支持：开发态（app.isPackaged=false）经 dev-app-update.yml 可本地联调，
 *   但 macOS 开发态受签名限制会失败，故默认拒绝并给出提示
 * - 状态机单例：checking → available → downloading → downloaded；供设置页「关于」面板展示，
 *   状态经 rendererClient.updateEvents.onStatus 推送到各窗口内容视图
 */

/** 更新状态机阶段。 */
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'upToDate' | 'error'

/** 更新状态快照（主进程 → 渲染层推送 / 渲染层拉取共用结构）。 */
export interface UpdateState {
  /** 是否具备更新条件（打包版；macOS 尚需签名+公证才能实际安装更新）。 */
  supported: boolean
  /** 当前阶段（渲染层按钮/文案据此渲染）。 */
  phase: UpdatePhase
  /** 当前应用版本。 */
  currentVersion: string
  /** 新版本号（available/downloaded 阶段存在）。 */
  availableVersion?: string
  /** 新版本发布日期（ISO 字符串）。 */
  releaseDate?: string
  /** 发布说明（GitHub Release body，纯文本展示）。 */
  releaseNotes?: string
  /** 下载进度 0~100。 */
  percent?: number
  /** 瞬时下载速率（字节/秒）。 */
  bytesPerSecond?: number
  downloadedBytes?: number
  totalBytes?: number
  /** 最近一次错误（人类可读）。 */
  error?: string
  /** 最近一次检查时间戳。 */
  lastCheckedAt?: number
  /** 启动自动检查开关（settings 持久化，默认开启）。 */
  autoCheckEnabled: boolean
}

/** 自动检查开关默认值。 */
const DEFAULT_AUTO_CHECK_ENABLED = true
/** 启动后延迟自动检查（秒）：避开启动期窗口恢复与资源加载。 */
const STARTUP_CHECK_DELAY_MS = 8000
/** 周期兜底检查间隔（毫秒，4 小时）。 */
const PERIODIC_CHECK_INTERVAL_MS = 4 * 3600 * 1000
/** 下载进度推送节流（毫秒）：百分比高频回调只按节流推送到渲染层。 */
const PROGRESS_PUSH_THROTTLE_MS = 400

let wired = false
/** 最近一次检查是否由用户手动触发（决定「已是最新/出错」是否弹 toast）。 */
let lastCheckUserInitiated = false
/** 同一新版本已通知过（自动检查每会话只弹一次「发现新版本」）。 */
let availableNotified = false
let lastProgressPushAt = 0

const state: UpdateState = {
  supported: app.isPackaged,
  phase: 'idle',
  currentVersion: '',
  autoCheckEnabled: DEFAULT_AUTO_CHECK_ENABLED
}

/** 状态快照（渲染层经 IPC 读取/推送的都是值副本，避免跨进程引用共享对象）。 */
function snapshot(): UpdateState {
  return { ...state }
}

function pushState(): void {
  rendererClient.updateEvents.onStatus(snapshot())
}

function setPhase(phase: UpdatePhase): void {
  state.phase = phase
  pushState()
}

function toast(type: 'info' | 'success' | 'warning' | 'error', content: string): void {
  rendererClient.ui.showToast({ type, content, duration: 5000, closable: true })
}

/** 提取可展示的发布说明：GitHub API 的 releaseNotes 可能为 string / 分版本数组 / null。 */
function extractReleaseNotes(info: UpdateInfo): string | undefined {
  const notes = (info as UpdateInfo & { releaseNotes?: unknown }).releaseNotes
  if (typeof notes === 'string') return notes.trim() || undefined
  if (Array.isArray(notes)) {
    const list = notes as { version?: string; note?: string }[]
    const match = list.find((n) => n.version === info.version) ?? list[0]
    const text = match?.note?.trim()
    return text || undefined
  }
  return undefined
}

function applyUpdateInfo(info: UpdateInfo): void {
  state.availableVersion = info.version
  state.releaseDate = info.releaseDate
  state.releaseNotes = extractReleaseNotes(info)
}

/** 把 electron-updater 的原始错误转成对用户友好的文案。 */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (!app.isPackaged) {
    return '开发态不支持自动更新，请打包安装（macOS 还需代码签名 + 公证）后验证'
  }
  if (/network|net::|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return '无法连接更新服务器，请检查网络后重试'
  }
  // 保留原始信息但去重换行，便于在设置页展示具体原因
  return msg.replace(/\s*\n\s*/g, ' ').slice(0, 300)
}

/** 是否属于「源上还没有发布」类错误（404 / 找不到 latest 元数据）。这类不视为故障，按已最新处理。 */
function isNoReleaseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return !app.isPackaged || /404|Cannot (find|get) latest|no published/i.test(msg)
}

function handleError(err: unknown): void {
  const message = friendlyError(err)
  if (isNoReleaseError(err)) {
    // 更新源尚无发布记录（如首次发行前）：语义等同「已是最新」，不展示错误
    log.info('暂无可用更新（源上没有发布记录）', { error: message })
    state.phase = 'upToDate'
    state.error = undefined
    state.availableVersion = undefined
    state.lastCheckedAt = Date.now()
    pushState()
    if (lastCheckUserInitiated) toast('success', '已是最新版本')
    return
  }
  log.warn('自动更新失败', { error: message })
  state.phase = 'error'
  state.error = message
  state.lastCheckedAt = Date.now()
  pushState()
  if (lastCheckUserInitiated) toast('error', `检查更新失败：${message}`)
}

/** 注册 electron-updater 事件（幂等）；供 initAutoUpdateService 与首次 IPC 调用时调用。 */
function wireUpdater(): void {
  if (wired) return
  wired = true
  autoUpdater.logger = log as never
  // 只「发现」不自动下载，由用户在设置页确认后下载，避免流量静默消耗
  autoUpdater.autoDownload = false
  // 用户点击「重启安装」前退出应用（如托盘驻留时关机）则自动完成安装，不丢更新
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    availableNotified = false
    setPhase('checking')
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    applyUpdateInfo(info)
    state.error = undefined
    state.lastCheckedAt = Date.now()
    setPhase('available')
    if (!availableNotified) {
      availableNotified = true
      toast('info', `发现新版本 v${info.version}，可在「设置 → 关于」中下载更新`)
    }
  })
  autoUpdater.on('update-not-available', () => {
    state.availableVersion = undefined
    state.error = undefined
    state.lastCheckedAt = Date.now()
    setPhase('upToDate')
    if (lastCheckUserInitiated) toast('success', '已是最新版本')
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    state.phase = 'downloading'
    state.percent = Math.round(progress.percent)
    state.bytesPerSecond = progress.bytesPerSecond
    state.downloadedBytes = progress.transferred
    state.totalBytes = progress.total
    const now = Date.now()
    if (now - lastProgressPushAt < PROGRESS_PUSH_THROTTLE_MS) return
    lastProgressPushAt = now
    pushState()
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    applyUpdateInfo(info)
    state.percent = 100
    setPhase('downloaded')
    toast('success', `v${info.version} 已下载完成，重启应用即可完成更新`)
    // 托盘驻留/窗口被隐藏时用系统通知兜底提示（遵循用户通知开关）
    void notifyAgentFinished({
      title: '桌面助手更新已就绪',
      body: `新版本 v${info.version} 已下载完成，点击回到应用并重启完成更新`
    })
  })
  autoUpdater.on('error', (err: Error) => {
    handleError(err)
  })
}

/** 执行一次检查（内部共用：IPC 手动检查与启动/周期自动检查）。 */
async function runCheck(userInitiated: boolean): Promise<UpdateState> {
  lastCheckUserInitiated = userInitiated
  if (!app.isPackaged) {
    if (userInitiated) handleError(new Error('开发态不支持自动更新'))
    return snapshot()
  }
  // 检查/下载中忽略重复触发
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'downloaded') {
    return snapshot()
  }
  wireUpdater()
  setPhase('checking')
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    handleError(err)
  }
  return snapshot()
}

/**
 * 更新服务（IPC namespace `update`，渲染层经 mainClient.update.* 调用）。
 * 事件/状态推送走 rendererClient.updateEvents.onStatus（内容视图）。
 */
export class UpdateService extends IpcService {
  static override readonly namespace = 'update'

  /** 当前状态快照（设置页打开时拉取，弥补推送早于监听器注册而丢失的情况）。 */
  getState(): UpdateState {
    state.supported = app.isPackaged
    state.currentVersion = app.getVersion()
    state.autoCheckEnabled = db.getSetting<boolean>(SETTING_AUTO_UPDATE_ENABLED) !== false
    return snapshot()
  }

  /** 手动检查更新（quiet=false 会 toast 结果）。 */
  async checkForUpdates(quiet = false): Promise<UpdateState> {
    return runCheck(!quiet)
  }

  /** 下载已发现的新版本。 */
  async downloadUpdate(): Promise<UpdateState> {
    if (!app.isPackaged) {
      handleError(new Error('开发态不支持自动更新'))
      return snapshot()
    }
    if (state.phase !== 'available') {
      state.error = '没有可下载的版本，请先检查更新'
      pushState()
      return snapshot()
    }
    state.phase = 'downloading'
    state.error = undefined
    pushState()
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      handleError(err)
    }
    return snapshot()
  }

  /** 退出应用并静默安装更新（仅 downloaded 阶段有效）。 */
  install(): void {
    if (state.phase !== 'downloaded') return
    log.info('退出并安装更新', { version: state.availableVersion })
    // setImmediate 等当前 IPC 回执返回后再退出，避免渲染层收不到响应
    setImmediate(() => autoUpdater.quitAndInstall())
  }

  /** 设置「启动时自动检查更新」开关（持久化 settings 并广播）。 */
  setAutoCheckEnabled(enabled: boolean): void {
    db.setSetting(SETTING_AUTO_UPDATE_ENABLED, enabled)
    state.autoCheckEnabled = enabled
    log.info('设置自动检查更新', { enabled })
    pushState()
  }
}

/**
 * 启动接入（index.ts whenReady 后调用）：
 * 读取持久化开关，注册事件；打包版开启时做启动延迟检查 + 周期兜底检查。
 */
export function initAutoUpdateService(): void {
  state.currentVersion = app.getVersion()
  state.supported = app.isPackaged
  state.autoCheckEnabled = db.getSetting<boolean>(SETTING_AUTO_UPDATE_ENABLED) !== false
  wireUpdater()
  if (!app.isPackaged) {
    log.info('开发态运行：跳过自动检查更新（可通过 dev-app-update.yml 本地联调）')
    return
  }
  if (!state.autoCheckEnabled) return
  setTimeout(() => void runCheck(false), STARTUP_CHECK_DELAY_MS)
  setInterval(() => void runCheck(false), PERIODIC_CHECK_INTERVAL_MS)
}
