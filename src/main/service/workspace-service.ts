import { IpcService } from 'electron-ipc-service'
import { dialog, shell } from 'electron'
import { db } from '../database'
import { openWorkspaceWindow, closeWorkspaceWindow } from './window-manager'
import { deleteSessionAttachments } from '../agent/attachment'
import { readAgentMdRaw, writeAgentMd } from '../agent/agent-md'
import { createLogger } from '../utils/log'
import type { Workspace, WorkspaceWithStats } from '../database'

const log = createLogger('workspace')

/** 工作区会话被删除后的回调（service/index.ts 接线：驱逐这些会话的内存 Agent）。 */
export type SessionsRemovedHandler = (sessionIds: string[]) => Promise<void> | void

/**
 * 工作区管理服务（namespace `workspace`）：工作区 CRUD + 窗口联动 + agent.md 读写。
 * 工作区 = workdir 绝对路径 = 专属窗口 + 会话集合 + agent.md 项目记忆。
 * 会话数据按 workdir 隔离（sessions.workdir）；删除工作区时级联物理删除其会话。
 */
export class WorkspaceService extends IpcService {
  static override readonly namespace = 'workspace'
  private onSessionsRemoved: SessionsRemovedHandler | null = null

  setOnSessionsRemoved(handler: SessionsRemovedHandler): void {
    this.onSessionsRemoved = handler
  }

  /** 全部工作区 + 会话数（按 last_opened_at 倒序）。 */
  list(): WorkspaceWithStats[] {
    return db.listWorkspaces()
  }

  /** 新建工作区并打开其窗口（目录校验非空；已存在同名工作区则直接打开聚焦）。 */
  async create(dir: string, name?: string): Promise<Workspace> {
    const v = dir.trim()
    if (!v) throw new Error('工作目录不能为空')
    const ws = db.upsertWorkspace(v, { name: name?.trim() || undefined })
    await openWorkspaceWindow(v)
    log.info('新建工作区', { workdir: v, name: ws.name })
    return ws
  }

  rename(workdir: string, name: string): Workspace {
    const v = name.trim()
    if (!v) throw new Error('工作区名称不能为空')
    return db.upsertWorkspace(workdir, { name: v })
  }

  /** 打开工作区窗口（已打开则聚焦）。 */
  async open(workdir: string): Promise<void> {
    await openWorkspaceWindow(workdir)
  }

  /** 仅关闭窗口（工作区与会话保留，可从工作区列表重新打开）。 */
  close(workdir: string): void {
    closeWorkspaceWindow(workdir)
  }

  /**
   * 删除工作区：关窗 → 物理删除其全部会话（含附件文件）→ 删工作区行 →
   * 回调驱逐这些会话的内存 Agent（防悬挂引用与持久化 shell 残留）。
   * 至少保留一个工作区：删除最后一个会抛错（启动/兜底依赖默认工作区）。
   */
  async remove(workdir: string): Promise<void> {
    if (db.listWorkspaces().length <= 1) {
      throw new Error('至少需要保留一个工作区（启动与兜底依赖默认工作区）')
    }
    closeWorkspaceWindow(workdir)
    const sessionIds = [...db.listSessions(workdir), ...db.listDeletedSessions(workdir)].map(
      (s) => s.id
    )
    for (const id of sessionIds) {
      await deleteSessionAttachments(id).catch(() => undefined)
    }
    const count = db.deleteSessionsByWorkdir(workdir)
    db.deleteWorkspace(workdir)
    await this.onSessionsRemoved?.(sessionIds)
    log.info('删除工作区', { workdir, sessions: count })
  }

  /** 弹系统目录选择框新建工作区（用户取消返回 null）。 */
  async pickAndCreate(): Promise<Workspace | null> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择工作区目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || filePaths.length === 0) return null
    return this.create(filePaths[0])
  }

  /** 读取 {workdir}/agent.md 完整内容（编辑器用）；文件不存在返回 null。 */
  getAgentMd(workdir: string): string | null {
    return readAgentMdRaw(workdir)
  }

  /** 保存 {workdir}/agent.md（项目记忆，随项目存储）。 */
  saveAgentMd(workdir: string, content: string): void {
    writeAgentMd(workdir, content)
    log.info('已保存 agent.md', { workdir })
  }

  /** 在系统文件管理器中打开工作区目录（工作区标识卡片「打开文件夹」入口用）。 */
  async openFolder(workdir: string): Promise<void> {
    const err = await shell.openPath(workdir)
    if (err) throw new Error(`打开目录失败：${err}`)
    log.info('打开工作区目录', { workdir })
  }
}
