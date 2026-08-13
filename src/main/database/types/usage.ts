/** 用量统计时间范围：近 N 天；null = 全部历史。 */
export type UsageRangeDays = 7 | 30 | null

/** LLM 调用用途（usage_logs.kind）：对话 / 标题生成 / 压缩摘要 / 欢迎页建议生成。 */
export type UsageKind = 'chat' | 'title' | 'compress' | 'welcome'

/** 单次 LLM 调用用量记录（写入 usage_logs，用量统计的唯一数据源）。 */
export interface RecordUsageParams {
  sessionId: string
  kind: UsageKind
  /** provider（pi-ai provider id，即 model_configs.id） */
  provider: string | null
  model: string | null
  promptTokens: number
  completionTokens: number
  /** 本次调用成本（USD） */
  cost: number
  /** 调用完成时间（unix ms） */
  timestamp: number
}

/** 单日用量汇总（无数据的天补 0，保证图表连续）。 */
export interface UsageDayStat {
  /** YYYY-MM-DD（本地时区） */
  day: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  /** 当日 LLM 调用次数 */
  messageCount: number
}

/** 单模型用量汇总（按 usage_logs.provider + model 分组）。 */
export interface UsageModelStat {
  /** provider（pi-ai provider id，即 model_configs.id） */
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  /** 该模型的 LLM 调用次数 */
  messageCount: number
}

/** 用量统计总览：汇总数 + 按天趋势 + 按模型分布。 */
export interface UsageStats {
  /** 时间范围起点（unix ms；null = 全部）。用于前端标注统计区间。 */
  rangeStart: number | null
  /** 范围内涉及的会话数（distinct，排除回收站会话） */
  sessions: number
  /** 范围内全部消息数（含用户/工具等非计费消息；仅作数量展示，与 token 无关） */
  messages: number
  /** 范围内全部 LLM 调用次数（含对话/标题生成/压缩摘要） */
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 累计成本（USD） */
  cost: number
  /** 按天（覆盖整个区间，含 0 值日） */
  byDay: UsageDayStat[]
  /** 按模型（按 totalTokens 降序） */
  byModel: UsageModelStat[]
}
