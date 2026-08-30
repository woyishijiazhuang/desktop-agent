import type { Message } from './message'

export type SessionStatus = 'active' | 'ended'

export interface Session {
  id: string
  title: string
  status: SessionStatus
  /** 所属工作区（workdir 绝对路径）：会话按工作区隔离。 */
  workdir: string
  model: string | null
  /** 会话级思考级别（ThinkingLevel 值；null = 沿用全局默认）。 */
  thinkingLevel: string | null
  systemPrompt: string | null
  /** 最终组装后的系统提示词快照（会话首次创建 Agent 时固化，重建直接复用；null = 尚未固化）。 */
  resolvedSystemPrompt: string | null
  parentSessionId: string | null
  /** 累计压缩摘要（用于 LLM 重放时替代旧消息） */
  compressSummary: string | null
  /** 最后一个被压缩的消息 id（含），重放时取 id > 此值 */
  compressLastIndex: number | null
  /** 压缩版本号（乐观锁） */
  compressVersion: number
  /** 软删除时间（unix ms；null = 未删除）。删除的会话进入回收站，到期或手动清空后物理删除。 */
  deletedAt: number | null
  /** 置顶：排序优先级高于时间，置顶组内仍按 last_active_at 倒序 */
  pinned: boolean
  /** 归档：从常规分组移入「已归档」组，不再参与置顶排序 */
  archived: boolean
  /** 当前计划（exit_plan_mode 批准后写入；null = 无计划）。 */
  plan: string | null
  /** unix ms 时间戳，与 messages.timestamp 统一格式。 */
  createdAt: number
  updatedAt: number
  /** 最后用户活动时间（会话列表排序键）：仅用户主动操作（发消息/进入/重命名/换模型）更新，后台流式不更新 */
  lastActiveAt: number
}

export interface CreateSessionParams {
  /** 所属工作区（workdir 绝对路径）。缺省时由 db 层回退到默认工作区（见 database/index.ts 的 resolveDefaultWorkdir）。 */
  workdir?: string
  title?: string
  model?: string
  thinkingLevel?: string
  systemPrompt?: string
  parentSessionId?: string
}

export interface UpdateSessionParams {
  title?: string
  status?: SessionStatus
  model?: string
  thinkingLevel?: string
  systemPrompt?: string
  /** 写入/清空（null）最终系统提示词快照。自定义提示词变更时由 updateSession 内部自动清空。 */
  resolvedSystemPrompt?: string | null
  /** 写入/清空（null）当前计划（exit_plan_mode 批准后由 main 写入）。 */
  plan?: string | null
  pinned?: boolean
  archived?: boolean
  /** 用户主动操作：为 true 时同步刷新 last_active_at（置顶会话列表） */
  touch?: boolean
}

/** 会话上下文（用于 LLM 重放） */
export interface SessionContext {
  session: Session
  compressSummary: string | null
  messages: Message[]
}

/** 会话列表分页参数（游标分页：lastActiveAt + id 复合游标，首页不传游标）。 */
export interface ListSessionsOptions {
  /** 按工作区过滤（workdir 绝对路径）；缺省返回全部工作区会话。 */
  workdir?: string
  /** 每页大小（默认 30） */
  limit?: number
  /** 游标：上一页最后一条非置顶会话的 lastActiveAt（仅在非置顶区间使用） */
  cursor?: number
  /** 游标辅助：cursor 对应会话的 id（同时间戳时防歧义） */
  cursorId?: string
}

/** 会话列表分页结果。 */
export interface ListSessionsResult {
  sessions: Session[]
  hasMore: boolean
}

/** 数据库行类型（内部）：sessions 表 */
export interface SessionRow {
  id: string
  title: string
  status: string
  workdir: string
  model: string | null
  thinking_level: string | null
  system_prompt: string | null
  resolved_system_prompt: string | null
  parent_session_id: string | null
  compress_summary: string | null
  compress_last_index: number | null
  compress_version: number
  deleted_at: number | null
  pinned: number
  archived: number
  plan: string | null
  created_at: number
  updated_at: number
  last_active_at: number
}
