/** 工作区：一个 workdir 绝对路径对应一个工作区（含专属窗口与会话集合）。 */
export interface Workspace {
  workdir: string
  /** 显示名（默认取目录 basename，可重命名）。 */
  name: string
  /** 窗口位置/尺寸（JSON 字符串，如 {"x":100,"y":80,"width":1200,"height":800}；null = 未记录）。 */
  bounds: string | null
  /** unix ms 时间戳，用于启动时恢复顺序。 */
  lastOpenedAt: number
  createdAt: number
}

/** 工作区 + 会话数（列表展示用）。 */
export interface WorkspaceWithStats extends Workspace {
  sessionCount: number
}

/** 数据库行类型（内部）：workspaces 表 */
export interface WorkspaceRow {
  workdir: string
  name: string
  bounds: string | null
  last_opened_at: number
  created_at: number
}

export interface UpsertWorkspaceParams {
  name?: string
  bounds?: string | null
  lastOpenedAt?: number
}
