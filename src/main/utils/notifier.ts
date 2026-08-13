import { Notification, shell } from 'electron'
import { getMainWindow, ensureMainWindow } from '../service/window-manager'
import { createLogger } from './log'
import icon from '../../../resources/icon.png?asset'

const log = createLogger('notifier')

/** 正文截断上限（字符）：通知栏只展示一行，超长无意义。 */
const MAX_BODY_CHARS = 120

/** 有成果文件时通知上附带的「打开文件」按钮文案。 */
const OPEN_FILE_ACTION_LABEL = '打开文件'

/** 打开通知目标路径（点通知主体或「打开文件」按钮共用）。 */
function openTarget(path: string): void {
  void shell.openPath(path).then((err) => {
    if (err) log.warn('打开通知目标失败', { path, error: err })
  })
}

/**
 * 发送桌面通知（agent 运行完成/失败时用）。
 * 规则：仅当主窗口不在前台（未聚焦）时弹出，避免用户正盯着应用还被通知打扰；
 * 最小化/隐藏到托盘时窗口未聚焦，同样会通知。
 * 点击行为：带 openPath（agent 生成的成果文件/目录）时，通知附带「打开文件」按钮，
 * 点击按钮或通知主体均用系统默认程序打开目标；否则唤起并聚焦主窗口。
 * 带 openPath 时以路径作为通知 id：同一成果再次完成会替换旧通知，避免通知堆积。
 * 通知不可用/无权限时静默跳过（try/catch），不影响主流程。
 */
export function notifyAgentFinished(input: {
  title: string
  body: string
  /** 点击通知后要打开的文件或目录路径（如刚生成的 PDF/Word、下载输出目录）。 */
  openPath?: string
}): void {
  try {
    if (!Notification.isSupported()) return
    const win = getMainWindow()
    if (win && win.isFocused()) return
    const body =
      input.body.length > MAX_BODY_CHARS ? `${input.body.slice(0, MAX_BODY_CHARS)}…` : input.body
    const n = new Notification({
      title: input.title,
      body,
      icon,
      // 同一成果路径只保留最新通知（同 id 的旧通知被替换）；无成果时走随机 UUID 默认行为
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
    // 「打开文件」按钮（darwin/win32）；actionIndex 对应 actions 数组下标
    n.on('action', (_event, actionIndex) => {
      if (actionIndex === 0 && input.openPath) openTarget(input.openPath)
    })
    n.show()
    log.debug('已发送桌面通知', {
      title: input.title,
      body: input.body.slice(0, 60),
      openPath: input.openPath
    })
  } catch (err) {
    // 通知授权被拒/系统不支持等：静默降级，不打断 agent 流程
    log.warn('发送桌面通知失败', { error: err instanceof Error ? err.message : String(err) })
  }
}
