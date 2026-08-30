import { IpcService } from 'electron-ipc-service'
import { bashSessionManager, type BackgroundSessionInfo } from '../agent/bash-session'
import { rendererClient } from './render-client'
import { createLogger } from '../utils/log'

const log = createLogger('service:bash')

/**
 * 后台命令服务：桥接 BashSessionManager 与 renderer「后台命令面板」。
 * - 订阅后台会话变更（启动/退出/终止）→ 推送全量快照给 renderer（agentEvent 通道）；
 * - renderer 侧主动查询 / 终止 / 读取输出走本服务 IPC。
 */
export class BashService extends IpcService {
  static override readonly namespace = 'bash'

  constructor() {
    super()
    // 变更即推送全量快照（fire-and-forget；renderer 加载后另有 listBackground 兜底拉取）
    bashSessionManager.subscribe(() => {
      rendererClient.agentEvent.onBackgroundSessions(bashSessionManager.listBackground())
    })
  }

  /** 当前全部后台会话快照（面板初始化 / 手动刷新用）。 */
  listBackground(): BackgroundSessionInfo[] {
    return bashSessionManager.listBackground()
  }

  /** 终止后台任务（面板「终止」按钮）：shell 进程组 SIGTERM → 宽限期 → SIGKILL；下载任务 abort。 */
  killBackground(id: string): { ok: boolean; error?: string } {
    const task = bashSessionManager.getBackground(id)
    if (!task) return { ok: false, error: '后台任务不存在（可能已退出）' }
    log.info('面板终止后台任务', { id, command: task.command.slice(0, 120) })
    task.kill()
    return { ok: true }
  }

  /** 读取后台任务输出（tail=false 返回全量缓冲，供面板展示尾部输出；不影响 agent 增量游标）。 */
  readBackgroundOutput(id: string): { text: string; exited: boolean; exitCode: number | null } {
    const task = bashSessionManager.getBackground(id)
    if (!task) return { text: '', exited: true, exitCode: null }
    return task.read(false)
  }

  /** 移除已退出的后台任务（面板「×」按钮；运行中的任务请先终止）。 */
  removeBackground(id: string): { ok: boolean; error?: string } {
    return bashSessionManager.removeBackground(id)
  }
}
