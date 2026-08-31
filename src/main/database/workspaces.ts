import type { DatabaseSync } from 'node:sqlite'
import type { Workspace, WorkspaceRow, WorkspaceWithStats, UpsertWorkspaceParams } from './types'

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    workdir: row.workdir,
    name: row.name,
    bounds: row.bounds,
    themeColor: row.theme_color,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at
  }
}

/** 工作区域 API（index.ts 组装进 db 门面）。 */
export interface WorkspacesApi {
  listWorkspaces(): WorkspaceWithStats[]
  getWorkspace(workdir: string): Workspace | undefined
  /** 插入或更新工作区（workdir 为主键）。 */
  upsertWorkspace(workdir: string, params?: UpsertWorkspaceParams): Workspace
  /** 刷新 last_opened_at（窗口打开/聚焦时调用，用于启动恢复顺序）。 */
  touchWorkspace(workdir: string): void
  /** 设置工作区自定义主题色（ThemeColorKey；null = 恢复跟随全局默认）。 */
  setWorkspaceThemeColor(workdir: string, color: string | null): void
  /** 删除工作区行（会话删除由调用方负责：workspace.remove 先删会话再删行）。 */
  deleteWorkspace(workdir: string): void
}

/** 工作区 CRUD。 */
export function createWorkspacesApi(db: DatabaseSync): WorkspacesApi {
  const api: WorkspacesApi = {
    listWorkspaces(): WorkspaceWithStats[] {
      const rows = db
        .prepare(
          `SELECT w.*, (SELECT COUNT(*) FROM sessions s WHERE s.workdir = w.workdir AND s.deleted_at IS NULL) AS session_count
           FROM workspaces w
           ORDER BY w.last_opened_at DESC`
        )
        .all() as unknown as (WorkspaceRow & { session_count: number })[]
      return rows.map((r) => ({ ...toWorkspace(r), sessionCount: r.session_count }))
    },

    getWorkspace(workdir: string): Workspace | undefined {
      const row = db.prepare('SELECT * FROM workspaces WHERE workdir = ?').get(workdir) as
        WorkspaceRow | undefined
      return row ? toWorkspace(row) : undefined
    },

    upsertWorkspace(workdir: string, params?: UpsertWorkspaceParams): Workspace {
      const now = Date.now()
      db.prepare(
        `INSERT INTO workspaces (workdir, name, bounds, last_opened_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workdir) DO UPDATE SET
           name = COALESCE(excluded.name, workspaces.name),
           bounds = COALESCE(excluded.bounds, workspaces.bounds),
           last_opened_at = COALESCE(excluded.last_opened_at, workspaces.last_opened_at)`
      ).run(
        workdir,
        params?.name ?? basename(workdir) ?? workdir,
        params?.bounds ?? null,
        params?.lastOpenedAt ?? now,
        now
      )
      return api.getWorkspace(workdir)!
    },

    touchWorkspace(workdir: string): void {
      db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE workdir = ?').run(
        Date.now(),
        workdir
      )
    },

    setWorkspaceThemeColor(workdir: string, color: string | null): void {
      db.prepare('UPDATE workspaces SET theme_color = ? WHERE workdir = ?').run(color, workdir)
    },

    deleteWorkspace(workdir: string): void {
      db.prepare('DELETE FROM workspaces WHERE workdir = ?').run(workdir)
    }
  }
  return api
}

/** 取路径最后一段作为默认显示名（失败时回退原路径）。 */
function basename(p: string): string | null {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last ? last : null
}
