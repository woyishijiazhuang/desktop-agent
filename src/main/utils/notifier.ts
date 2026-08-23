import { Notification, shell } from 'electron'
import { db } from '../database'
import { SETTING_NOTIFICATIONS_ENABLED } from '../agent/types'
import { ensureMainWindow } from '../service/window-manager'
import { createLogger } from './log'
import { rendererClient } from './render-client'
import icon from '../../../resources/icon.png?asset'

const log = createLogger('notifier')

/** 正文截断上限（字符）：通知栏只展示一行，超长无意义。 */
const MAX_BODY_CHARS = 120

/** 有成果文件时通知上附带的「打开文件」按钮文案。 */
const OPEN_FILE_ACTION_LABEL = '打开文件'

/** 等待 failed 事件的超时（ms）：超时后视为发送成功。 */
const FAILED_WAIT_MS = 1000

/**
 * macOS 通知失败引导：首次失败时提示用户检查权限 + 代码签名。
 * Electron 42+ 的 macOS 通知要求应用进行代码签名，否则静默失败。
 */
let failHintShown = false
function handleMacFailure(errorMsg: string): string {
  if (!failHintShown) {
    failHintShown = true
    const hint =
      'macOS 通知要求：1) 系统设置 → 通知 中为本应用开启权限；2) 应用需代码签名（开发阶段可用自签名证书）。'
    log.warn('桌面通知发送失败', { error: errorMsg, hint })
    rendererClient.ui.showToast({
      type: 'warning',
      content: `桌面通知发送失败：${errorMsg}。${hint}`,
      duration: 8000,
      closable: true,
      keepAliveOnHover: true
    })
  }
  return errorMsg
}

/** 打开通知目标路径（点通知主体或「打开文件」按钮共用）。 */
function openTarget(path: string): void {
  void shell.openPath(path).then((err) => {
    if (err) log.warn('打开通知目标失败', { path, error: err })
  })
}

/**
 * 发送桌面系统通知，返回发送结果。
 * 调用场景：
 * - agent 出错/失败（agent-manager / agent-service 兜底，fire-and-forget）
 * - agent 主动调用 notify 工具（需 await 拿到结果反馈给 agent）
 *
 * 正常结束不调用此函数，不打扰用户。
 * macOS 通知静默失败（无权限/未签名）时通过 failed 事件捕获，应用内 toast 提示用户。
 */
export async function notifyAgentFinished(input: {
  title: string
  body: string
  /** 点击通知后要打开的文件或目录路径（如刚生成的 PDF/Word、下载输出目录）。 */
  openPath?: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!Notification.isSupported()) {
      return { success: false, error: '系统不支持通知' }
    }
    // 用户在设置中关闭了通知开关，静默跳过
    if (db.getSetting<boolean>(SETTING_NOTIFICATIONS_ENABLED) === false) {
      return { success: false, error: '通知已被用户关闭' }
    }
    const body =
      input.body.length > MAX_BODY_CHARS ? `${input.body.slice(0, MAX_BODY_CHARS)}…` : input.body
    const n = new Notification({
      title: input.title,
      body,
      icon,
      ...(input.openPath
        ? {
            id: input.openPath,
            actions: [{ type: 'button' as const, text: OPEN_FILE_ACTION_LABEL }]
          }
        : {})
    })
    n.on('click', () => {
      if (input.openPath) openTarget(input.openPath)
      else ensureMainWindow()
    })
    n.on('action', (_event, actionIndex) => {
      if (actionIndex === 0 && input.openPath) openTarget(input.openPath)
    })

    // macOS：监听 failed 事件判断是否发送成功；非 macOS 直接视为成功
    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      if (process.platform === 'darwin') {
        n.on('failed', (_event, errorMsg) => {
          resolve({ success: false, error: handleMacFailure(errorMsg) })
        })
        // 无 failed 事件则在超时后视为成功
        setTimeout(() => resolve({ success: true }), FAILED_WAIT_MS)
      } else {
        resolve({ success: true })
      }
      n.show()
    })

    if (result.success) {
      log.debug('已发送桌面通知', {
        title: input.title,
        body: input.body.slice(0, 60),
        openPath: input.openPath
      })
    }
    return result
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.warn('发送桌面通知失败', { error: errorMsg })
    return { success: false, error: errorMsg }
  }
}
