import { useIpcMainContext } from 'electron-ipc-service'
import { getWorkspaceByWebContents } from './window-manager'

/**
 * IPC 工作区作用域解析。
 *
 * 多窗口下，工作区相关的数据（会话列表/创建）必须落在**发送方窗口所属工作区**，
 * 不能让 A 工作区的窗口读写 B 工作区的会话。方案：作用域方法内部调用本函数，
 * 以 IPC 消息来源 webContents 反查工作区（见 window-manager.getWorkspaceByWebContents），
 * 渲染层无需显式传参、也无法跨区访问。
 *
 * 主进程内部调用（无 IPC 上下文）返回 undefined，调用方按「全部工作区/缺省」处理。
 */
export function resolveScopedWorkdir(): string | undefined {
  try {
    return getWorkspaceByWebContents(useIpcMainContext().sender)?.workdir
  } catch {
    // 非 IPC 上下文（主进程内部调用）或发送方非工作区窗口（设置窗口）
    return undefined
  }
}
