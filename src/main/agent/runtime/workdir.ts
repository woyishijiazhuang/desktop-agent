import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { db } from '../database'

/**
 * 工作目录解析（会话级）。
 *
 * 工作区架构下 workdir 是会话属性（sessions.workdir，即工作区窗口绑定的目录）：
 * - Agent 创建与工具执行按会话归属的工作区解析目录；
 * - resolveSessionWorkdir 提供 sessionId → workdir，配内存缓存避免每次工具调用查库。
 * 返回前确保目录存在（自动创建），避免 bash 默认 cwd 指向不存在的目录。
 */

/** sessionId → workdir 内存缓存（Agent 创建时写入，驱逐/删除时清理）。 */
const workdirCache = new Map<string, string>()

/** 登记会话工作区（Agent 创建/会话落库时调用）。 */
export function cacheSessionWorkdir(sessionId: string, workdir: string): void {
  workdirCache.set(sessionId, workdir)
}

/** 清除会话工作区缓存（Agent 驱逐/会话删除时调用）。 */
export function dropSessionWorkdir(sessionId: string): void {
  workdirCache.delete(sessionId)
}

/** 解析会话所属工作区：缓存命中 > 会话行 > undefined。 */
export function resolveSessionWorkdir(sessionId: string): string | undefined {
  const hit = workdirCache.get(sessionId)
  if (hit !== undefined) return hit
  const session = db.getSession(sessionId)
  if (!session) return undefined
  if (session.workdir) workdirCache.set(sessionId, session.workdir)
  return session.workdir || undefined
}

/** 兜底工作目录（会话缺失时的默认值，落在用户数据目录，开发/生产一致）。 */
function defaultWorkdir(): string {
  return join(app.getPath('userData'), 'work')
}

/** 解析会话工作目录并确保存在（Agent 创建/工具执行用；会话缺失时回退默认目录）。 */
export function resolveAgentSessionWorkdir(sessionId: string): string {
  const dir = resolveSessionWorkdir(sessionId) ?? defaultWorkdir()
  mkdirSync(dir, { recursive: true })
  return dir
}
