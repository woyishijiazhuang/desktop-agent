/**
 * 长期记忆条目（跨会话全局单层）。
 * - manual：用户手动添加，或 Agent 通过 add_memory 工具显式写入
 * - auto：历史版本由对话结束后台自动抽取生成（该功能已移除，不再产生新条目；
 *   已存在的自动条目保留展示，可手动编辑/删除）
 * 手动条目始终由用户或 Agent 工具控制，不受任何后台流程影响。
 */
export type MemorySource = 'manual' | 'auto'

/** 记忆分类（手动添加默认 general）。 */
export type MemoryCategory = 'general' | 'preference' | 'fact' | 'project'

export interface Memory {
  id: string
  content: string
  category: MemoryCategory
  source: MemorySource
  createdAt: number
  updatedAt: number
}

export interface CreateMemoryParams {
  content: string
  category?: MemoryCategory
  source?: MemorySource
}

export interface UpdateMemoryParams {
  content?: string
  category?: MemoryCategory
}

/** 数据库行类型（内部）：memories 表 */
export interface MemoryRow {
  id: string
  content: string
  category: string
  source: string
  created_at: number
  updated_at: number
}
