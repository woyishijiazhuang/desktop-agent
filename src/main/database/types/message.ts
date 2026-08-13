/**
 * 消息角色。标准 LLM 角色为 user/assistant/system/toolResult,
 * 但 AgentMessage 支持 declaration merging 扩展 custom role（UI-only 消息），
 * 故 DB 层不再用 CHECK 约束限制，存任意 string，由 convert 层负责类型安全。
 */
export type MessageRole = string

/** 消息扩展元数据 */
export type MessageMetadata = Record<string, unknown>

export interface Message {
  id: number
  sessionId: string
  role: MessageRole
  /**
   * JSON 解析后的消息内容。
   * - 标准 LLM 消息：Block[]（text/toolCall/thinking/image 等 block 数组）
   * - custom 消息：自定义对象（由 declaration merging 定义）
   * DB 层不关心内部结构，由 src/main/agent/convert.ts 负责与 AgentMessage 的互转。
   */
  content: unknown
  /** role='toolResult' 时对应的 tool_call_id（冗余列，便于按 id 查询配对） */
  toolCallId: string | null
  /** role='toolResult' 时的工具名（冗余列，便于展示） */
  toolName: string | null
  /** 生成此消息的模型 */
  model: string | null
  /**
   * 生成此消息的 provider（pi-ai 的 provider id，即 model_configs.id）。
   * 与 model 列配合可精确关联到模型配置（拿 displayName 等）。
   */
  provider: string | null
  /** 结束原因：stop / length / tool_calls / error 等 */
  finishReason: string | null
  /** Unix 毫秒时间戳，用于排序与范围查询 */
  timestamp: number
  metadata: MessageMetadata | null
}

export interface CreateMessageParams {
  sessionId: string
  role: MessageRole
  content?: unknown
  toolCallId?: string
  toolName?: string
  model?: string
  provider?: string
  finishReason?: string
  metadata?: MessageMetadata
}

export interface UpdateMessageParams {
  content?: unknown
  finishReason?: string
  /** 传 null 清除，undefined 不修改 */
  metadata?: MessageMetadata | null
}

/** 消息查询选项 */
export interface ListMessagesOptions {
  /** 仅返回 id > afterId 的消息（压缩后增量加载） */
  afterId?: number
  /** 仅返回 id < beforeId 的消息（分页向上加载） */
  beforeId?: number
  /** 页大小：指定时返回「最后 limit 条」（配合 beforeId/afterId 取边界前后的最后 limit 条），结果恒为 ASC */
  limit?: number
}

/** 全文搜索单条命中（消息级）。snippet 为匹配文本片段，供结果列表预览。 */
export interface MessageSearchHit {
  /** 命中消息的 DB id */
  messageId: number
  sessionId: string
  sessionTitle: string
  role: string
  timestamp: number
  snippet: string
}

/** 数据库行类型（内部）：messages 表 */
export interface MessageRow {
  id: number
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_name: string | null
  model: string | null
  provider: string | null
  finish_reason: string | null
  timestamp: number
  metadata: string | null
}

/** 全文搜索 JOIN 结果行（消息 + 所属会话标题）。 */
export interface MessageSearchRow {
  id: number
  session_id: string
  session_title: string
  role: string
  content: string
  tool_name: string | null
  timestamp: number
}
