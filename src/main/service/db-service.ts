import { IpcService } from 'electron-ipc-service'
import { app, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { db } from '../database'
import {
  deleteSessionAttachments,
  copyAttachmentToSession,
  isLocalFileRef,
  fileRefToKey,
  toFileRef
} from '../agent/attachment'
import { extractMessageText } from '../utils/message-text'
import { createLogger } from '../utils/log'
import type {
  Session,
  Message,
  SessionStatus,
  MessageRole,
  MessageMetadata,
  CreateSessionParams,
  UpdateSessionParams,
  CreateMessageParams,
  UpdateMessageParams,
  ListMessagesOptions,
  SessionContext,
  MessageSearchHit,
  Setting,
  Memory,
  MemoryCategory,
  MemorySource,
  CreateMemoryParams,
  UpdateMemoryParams,
  McpServerRow,
  McpTransport,
  CreateMcpServerParams,
  UpdateMcpServerParams,
  UsageRangeDays,
  UsageStats,
  KbDocument,
  KbDocumentStatus,
  KbChunk,
  KbSearchHit,
  KbEmbeddingStats,
  KbEmbeddingLog
} from '../database'

// 重新导出类型，方便渲染进程引用
export type {
  Session,
  Message,
  SessionStatus,
  MessageRole,
  MessageMetadata,
  CreateSessionParams,
  UpdateSessionParams,
  CreateMessageParams,
  UpdateMessageParams,
  ListMessagesOptions,
  SessionContext,
  MessageSearchHit,
  Setting,
  Memory,
  MemoryCategory,
  MemorySource,
  CreateMemoryParams,
  UpdateMemoryParams,
  McpServerRow,
  McpTransport,
  CreateMcpServerParams,
  UpdateMcpServerParams,
  UsageRangeDays,
  UsageStats,
  KbDocument,
  KbDocumentStatus,
  KbChunk,
  KbSearchHit,
  KbEmbeddingStats,
  KbEmbeddingLog
}

/** 会话导出格式。 */
export type SessionExportFormat = 'markdown' | 'json'

const log = createLogger('dbService')

export class DbService extends IpcService {
  static override readonly namespace = 'db'

  // ==================== 会话 CRUD ====================

  createSession(params?: CreateSessionParams): Session {
    return db.createSession(params)
  }

  getSession(id: string): Session | undefined {
    return db.getSession(id)
  }

  listSessions(): Session[] {
    return db.listSessions()
  }

  updateSession(id: string, params: UpdateSessionParams): Session {
    return db.updateSession(id, params)
  }

  /** 清空全部会话的最终系统提示词快照（全局默认提示词变更后调用，使各会话下次重建时重新组装）。 */
  clearResolvedSystemPrompts(): void {
    db.clearResolvedSystemPrompts()
  }

  /** 用户主动触碰会话（刷新 last_active_at，置顶列表）。返回更新后的会话。 */
  touchSession(id: string): Session {
    return db.touchSession(id)
  }

  /**
   * 从源会话分叉新会话（分支对话）：复制分支点（不含）之前的全部历史，继承会话配置。
   * 随后把历史 user 消息中的图片附件文件复制到新会话目录并改写 file 引用，
   * 避免源会话删除（回收站清空）后分叉历史中的图片失效。
   */
  async forkSession(sourceSessionId: string, upToMessageId: number): Promise<Session> {
    const session = db.forkSession(sourceSessionId, upToMessageId)
    // 复制图片附件：遍历新会话的 user 消息，复制 file: 引用指向的附件文件并改写引用。
    for (const row of db.listMessagesBySession(session.id)) {
      if (row.role !== 'user' || !Array.isArray(row.content)) continue
      const blocks = row.content as Record<string, unknown>[]
      const refs = blocks
        .filter(
          (b): b is Record<string, unknown> & { data: string } =>
            b?.type === 'image' && typeof b.data === 'string' && isLocalFileRef(b.data)
        )
        .map((b) => fileRefToKey(b.data))
      if (refs.length === 0) continue
      // 旧 key → 新 key；复制失败（源文件已丢失）则沿用原引用，仍可读时不受影响
      const copied = new Map<string, string>()
      for (const key of refs) {
        if (copied.has(key)) continue
        try {
          copied.set(key, await copyAttachmentToSession(key, session.id))
        } catch (err) {
          log.warn('分支复制附件失败，沿用原引用', { key, error: err })
        }
      }
      if (copied.size === 0) continue
      db.updateMessage(row.id, {
        content: blocks.map((b) => {
          if (b?.type === 'image' && typeof b.data === 'string' && isLocalFileRef(b.data)) {
            const newKey = copied.get(fileRefToKey(b.data))
            return newKey ? { ...b, data: toFileRef(newKey) } : b
          }
          return b
        })
      })
    }
    return session
  }

  /** 软删除会话（进入回收站，不物理删除）。 */
  deleteSession(id: string): void {
    db.deleteSession(id)
  }

  // ==================== 回收站清理 ====================

  /** 回收站中的会话数量。 */
  countTrashSessions(): number {
    return db.countTrashSessions()
  }

  /** 物理删除全部软删除会话（清空回收站），返回删除的会话数。删除后同步清理其附件文件。 */
  async purgeTrash(): Promise<number> {
    const deleted = db.listDeletedSessions()
    for (const s of deleted) {
      await deleteSessionAttachments(s.id)
    }
    const count = db.purgeTrash()
    if (count > 0) log.info('清空回收站', { count })
    return count
  }

  /** 物理删除删除时间超过 days 天的软删除会话（到期清理），返回删除的会话数。 */
  purgeExpiredDeletedSessions(days: number): number {
    const count = db.purgeExpiredDeletedSessions(days)
    if (count > 0) log.info('清理到期软删除会话', { days, count })
    return count
  }

  // ==================== 消息 CRUD ====================

  createMessage(params: CreateMessageParams): Message {
    return db.createMessage(params)
  }

  getMessage(id: number): Message | undefined {
    return db.getMessage(id)
  }

  listMessagesBySession(sessionId: string, options?: ListMessagesOptions): Message[] {
    return db.listMessagesBySession(sessionId, options)
  }

  updateMessage(id: number, params: UpdateMessageParams): Message {
    return db.updateMessage(id, params)
  }

  deleteMessage(id: number): void {
    db.deleteMessage(id)
  }

  deleteMessagesBySession(sessionId: string): void {
    db.deleteMessagesBySession(sessionId)
  }

  // ==================== 压缩 / 上下文 ====================

  compressSession(
    sessionId: string,
    upToIndex: number,
    summary: string,
    expectedVersion: number
  ): Session {
    return db.compressSession(sessionId, upToIndex, summary, expectedVersion)
  }

  getSessionContext(sessionId: string): SessionContext {
    return db.getSessionContext(sessionId)
  }

  // ==================== 全文搜索 ====================

  /** 全文搜索消息文本，返回命中列表（按消息 id 倒序）。 */
  searchMessages(query: string, limit?: number): MessageSearchHit[] {
    return db.searchMessages(query, limit)
  }

  // ==================== 长期记忆 ====================

  /** 全部记忆条目（按更新时间倒序）。 */
  listMemories(): Memory[] {
    return db.listMemories()
  }

  /** 新增记忆条目（手动添加）。 */
  addMemory(params: CreateMemoryParams): Memory {
    return db.addMemory(params)
  }

  /** 更新记忆条目。 */
  updateMemory(id: string, params: UpdateMemoryParams): Memory {
    return db.updateMemory(id, params)
  }

  /** 删除单条记忆。 */
  deleteMemory(id: string): void {
    db.deleteMemory(id)
  }

  /** 清空全部记忆，返回删除条数。 */
  deleteAllMemories(): number {
    return db.deleteAllMemories()
  }

  /** 记忆全文搜索（记忆管理页）。 */
  searchMemories(query: string, limit?: number): Memory[] {
    return db.searchMemories(query, limit)
  }

  // ==================== 会话导出 ====================

  /**
   * 导出会话为 Markdown / JSON：弹系统保存对话框选择路径后写入文件。
   * 返回保存路径；用户取消时返回 null。
   */
  async exportSession(sessionId: string, format: SessionExportFormat): Promise<string | null> {
    const session = db.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const messages = db.listMessagesBySession(sessionId)
    const ext = format === 'markdown' ? 'md' : 'json'
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: format === 'markdown' ? '导出会话为 Markdown' : '导出会话为 JSON',
      defaultPath: `${sanitizeFilename(session.title)}-${yyyymmdd()}.${ext}`,
      filters:
        format === 'markdown'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    const content =
      format === 'markdown'
        ? sessionToMarkdown(session, messages)
        : JSON.stringify(
            {
              app: '桌面助手',
              appVersion: app.getVersion(),
              exportedAt: new Date().toISOString(),
              session,
              messages
            },
            null,
            2
          )
    await writeFile(filePath, content, 'utf-8')
    log.info('导出会话', { sessionId, format, filePath, messageCount: messages.length })
    return filePath
  }

  // ==================== 设置项（JSON） ====================
  // 注意：模型配置与加密 key 不在此暴露，由 src/main/agent/model-config.ts
  // 直接使用 db 单例操作，避免渲染进程接触加密后的 key。

  getSetting<T = unknown>(key: string): T | undefined {
    return db.getSetting<T>(key)
  }

  setSetting(key: string, value: unknown): void {
    db.setSetting(key, value)
  }

  deleteSetting(key: string): void {
    db.deleteSetting(key)
  }

  // ==================== 用量统计 ====================

  /** 用量/Token 统计（近 N 天 / 全部）：汇总 + 按天趋势 + 按模型分布。 */
  getUsageStats(rangeDays?: UsageRangeDays): UsageStats {
    return db.getUsageStats(rangeDays ?? null)
  }

  // ==================== 工具方法 ====================

  getDbPath(): string {
    return db.getDbPath()
  }
}

// ==================== 导出辅助 ====================

/** 去除文件名中的非法字符，控制长度（空标题回退「会话」）。 */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
  return cleaned || '会话'
}

/** 本地时区 yyyymmdd（导出默认文件名用）。 */
function yyyymmdd(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** 时间戳格式化为「yyyy-MM-dd HH:mm」。 */
function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 将会话渲染为 Markdown 文档（含元信息与全部消息）。 */
function sessionToMarkdown(session: Session, messages: Message[]): string {
  const roleLabel: Record<string, string> = {
    user: '用户',
    assistant: '助手',
    toolResult: '工具结果'
  }
  const lines: string[] = []
  lines.push(`# ${session.title}`, '')
  lines.push(
    `- 创建时间：${formatDateTime(session.createdAt)}`,
    `- 最后活动：${formatDateTime(session.lastActiveAt)}`,
    `- 消息数：${messages.length}`,
    '',
    '---',
    ''
  )
  for (const row of messages) {
    const header = `### ${roleLabel[row.role] ?? row.role} · ${formatDateTime(row.timestamp)}`
    lines.push(header, '')
    if (row.role === 'toolResult') {
      const body = extractMessageText(row.content) || '（无输出）'
      lines.push(`\`\`\`\n${body}\n\`\`\``, '')
      continue
    }
    const parts: string[] = []
    if (Array.isArray(row.content)) {
      for (const b of row.content as Record<string, unknown>[]) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          const quoted = (b.thinking as string)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
          parts.push(`> 思考过程：\n${quoted}`)
        } else if (b.type === 'toolCall') {
          parts.push(
            `**工具调用：** \`${String(b.name ?? '')}\`\n\n\`\`\`json\n${JSON.stringify(b.args ?? {}, null, 2)}\n\`\`\``
          )
        }
      }
    } else if (typeof row.content === 'string') {
      parts.push(row.content)
    }
    lines.push(parts.length > 0 ? parts.join('\n\n') : '（空消息）', '')
  }
  return lines.join('\n')
}
