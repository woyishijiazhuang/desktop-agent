import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../database'
import type { FileChangeRow, FileChangeStatus } from '../database/file-history'
import { getSessionFsPolicy, isSandboxWriteAllowed } from '../agent/runtime/sandbox'
import { rendererClient } from './render-client'
import { createLogger } from '../utils/log'

const log = createLogger('file-history')

/** 记录撤销快照的文件大小上限：超过则跳过记录（status=skipped），与 write_file 的 1MB 上限同量级。 */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

// ==================== 对外类型（renderer 经 IPC 消费） ====================

/** 渲染侧展示的文件变更项（listSessionChanges 返回 / onFileChanges 推送）。 */
export interface FileChangeItem {
  logId: number
  sessionId: string
  toolCallId: string | null
  toolName: string
  path: string
  status: FileChangeStatus
  /** 是否可撤销（status === 'applied' 的便捷位）。 */
  undoable: boolean
  /** 不可撤销原因（skipped 记录原因；applied 为 null）。 */
  undoError: string | null
  createdAt: number
}

/** onFileChanges 推送载荷（首字段 sessionId 供 main 侧按工作区定向投递）。 */
export interface FileChangesPayload {
  sessionId: string
  items: FileChangeItem[]
}

export interface UndoResult {
  ok: boolean
  error?: string
  /** 文件已被外部修改（乐观锁校验失败）：UI 据此给出针对性提示。 */
  externalModified?: boolean
}

export interface RevertFailure {
  path: string
  error: string
}

export interface RevertResult {
  ok: boolean
  /** 成功回退的文件数。 */
  count: number
  /** 被跳过的文件及原因（外部修改 / 快照缺失等，逐文件报告）。 */
  failures: RevertFailure[]
  error?: string
}

// ==================== 快照仓库（blob store） ====================

/** 快照根目录：{userData}/file-history/blobs/{hash[0:2]}/{hash}（两级分片防单目录臃肿）。 */
function blobsRoot(): string {
  return path.join(app.getPath('userData'), 'file-history', 'blobs')
}

function blobPath(hash: string): string {
  return path.join(blobsRoot(), hash.slice(0, 2), hash)
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 内容寻址快照写入：tmp + rename 原子落盘；同 hash 已存在则跳过（幂等，天然去重）。 */
async function putBlob(hash: string, data: Buffer): Promise<void> {
  const target = blobPath(hash)
  if (existsSync(target)) return
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `${hash}.${process.pid}-${Date.now()}.tmp`)
  await writeFile(tmp, data)
  await rename(tmp, target)
}

/** 临时文件 + rename 的原子写回（撤销恢复用，tmp 与目标同目录保证同卷）。 */
async function atomicWrite(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.undo-${process.pid}-${Date.now()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, target)
}

/** 当前文件内容 sha256；文件不存在（或不可读）返回 null。 */
async function currentHash(file: string): Promise<string | null> {
  try {
    return sha256(await readFile(file))
  } catch {
    return null
  }
}

function toItem(row: FileChangeRow): FileChangeItem {
  return {
    logId: row.id,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    path: row.path,
    status: row.status,
    undoable: row.status === 'applied',
    undoError: row.undoError,
    createdAt: row.createdAt
  }
}

/** 推送文件变更状态到渲染侧（按 sessionId 归属工作区定向投递，见 render-client 的 extractSessionId）。 */
function pushFileChanges(sessionId: string, rows: FileChangeRow[]): void {
  if (rows.length === 0) return
  rendererClient.agentEvent.onFileChanges({ sessionId, items: rows.map(toItem) })
}

// ==================== 记录（工具包装层调用） ====================

/**
 * 记录用的规范化路径：绝对化 + 统一分隔符（win32 下折叠大小写）。
 * 同一物理文件在不同调用里若写成 `C:/a/b` 与 `C:\a\b`，原样落库会被同路径
 * superseded 校验（SQL 精确串比较）与会话级按 path 归组当成两个文件，故记录前归一。
 */
function normalizeRecordedPath(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * 包裹一次写文件工具执行：落盘前读原内容、落盘后读新内容，登记 file_change_log + 快照。
 * - 原内容暂存内存（≤2MB），只有 run() 成功返回才落快照与记录，失败/被拒（外层抛错）无任何残留；
 * - 二进制（含 NUL）/超限/读取失败 → 记 skipped 行（卡片展示不可撤销原因），不存快照；
 * - 记录链路任何失败只损失可撤销性，绝不影响工具本身的写入结果。
 */
export async function withFileChangeRecording(opts: {
  sessionId: string
  toolCallId: string
  toolName: string
  path: string
  run: () => Promise<unknown>
}): Promise<unknown> {
  const file = normalizeRecordedPath(opts.path)
  let before: Buffer | null = null
  let skipReason: string | null = null
  try {
    before = await readFile(file)
    if (before.includes(0)) skipReason = '二进制文件，不记录撤销快照'
    else if (before.length > MAX_SNAPSHOT_BYTES)
      skipReason = `文件超过 ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB，不记录撤销快照`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') before = null // 新建文件
    else skipReason = '无法读取原文件，不记录撤销快照'
  }
  const beforeHash = before !== null ? sha256(before) : null

  const result = await opts.run()

  try {
    const after = await readFile(file)
    const afterHash = sha256(after)
    if (!skipReason && before !== null) await putBlob(beforeHash as string, before)
    const logId = db.insertFileChange({
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      path: file,
      beforeHash,
      afterHash,
      bytes: after.length,
      status: skipReason ? 'skipped' : 'applied',
      undoError: skipReason
    })
    // 回读落库行推送（与 listSessionChanges 同一 toItem 映射，避免推送值与持久值分歧）
    const row = db.getFileChange(logId)
    if (row) pushFileChanges(opts.sessionId, [row])
  } catch (err) {
    log.warn('文件变更记录失败（不影响写入结果）', {
      path: file,
      error: err instanceof Error ? err.message : String(err)
    })
  }
  return result
}

// ==================== 撤销（用户触发，仅经 IPC） ====================

/**
 * 撤销写回的边界校验：与工具写入同一口径（沙箱开启时须在可写范围内），
 * realpath 解析防符号链接逃逸（日志里的路径被换成指向沙箱外的链接时拒绝）。
 * 目标与可写根必须都解析到真实路径再比较：策略里的根从不做归一（工作区 / 用户可写目录 /
 * os.tmpdir()），只解析目标会让链接类路径（macOS /var→/private/var、Windows junction
 * 工作区）与词法根失配，把写入时通过、本应合法的撤销误拒。
 */
async function assertUndoWritable(sessionId: string, target: string): Promise<void> {
  const policy = await getSessionFsPolicy(sessionId)
  if (!policy) return
  if (
    !isSandboxWriteAllowed(
      {
        allowWriteRoots: policy.allowWriteRoots.map(tryRealpath),
        denyReadRoots: policy.denyReadRoots.map(tryRealpath)
      },
      tryRealpath(target)
    )
  ) {
    throw new Error(`沙箱已开启：撤销目标「${target}」不在可写范围内，已拒绝`)
  }
}

/** realpath 解析（不存在 / 不可解析时退回原值，保持词法判定语义）。 */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 读取撤销快照；缺失（被 GC / 早期未记录）返回 null。 */
async function readBlob(hash: string): Promise<Buffer | null> {
  try {
    return await readFile(blobPath(hash))
  } catch {
    return null
  }
}

/**
 * 撤销单条改动（阶段一）。安全闸（任一不满足即拒绝）：
 * 1. status === 'applied'；
 * 2. 同路径无更晚的 applied 记录（superseded_by_later_ops，跨会话）；
 * 3. 乐观锁：当前文件 sha256 === after_hash（保护用户手工编辑 / 其他程序写入）。
 * 执行：新建（before_hash=null）→ 校验后删除文件；否则快照原子写回。
 */
export async function undoFileChange(logId: number, sessionId: string): Promise<UndoResult> {
  const row = db.getFileChange(logId)
  if (!row || row.sessionId !== sessionId) {
    return { ok: false, error: '撤销记录不存在（会话可能已被清理）' }
  }
  if (row.status === 'undone') return { ok: false, error: '该改动已被撤销' }
  if (row.status === 'superseded') return { ok: false, error: '该改动已因整批撤销被作废' }
  if (row.status === 'skipped') {
    return { ok: false, error: row.undoError ?? '该改动未记录快照，无法撤销' }
  }
  if (row.status !== 'applied') return { ok: false, error: '该改动当前不可撤销' }

  if (db.hasAppliedFileChangeAfter(row.path, row.id)) {
    return {
      ok: false,
      error:
        '该文件在此之后还有其它改动：请撤销最新一次改动，或使用会话菜单的「撤销本会话的文件改动」'
    }
  }

  const cur = await currentHash(row.path)
  if (cur !== row.afterHash) {
    return {
      ok: false,
      externalModified: true,
      error: '文件已被外部修改（或删除），为避免丢失你的改动，已拒绝撤销'
    }
  }

  try {
    await assertUndoWritable(sessionId, row.path)
    if (row.beforeHash === null) {
      await rm(row.path)
    } else {
      const blob = await readBlob(row.beforeHash)
      if (!blob) return { ok: false, error: '撤销快照数据缺失（可能已被清理），无法撤销' }
      await atomicWrite(row.path, blob)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  db.updateFileChangeStatus(logId, 'undone')
  const updated = db.getFileChange(logId)
  if (updated) pushFileChanges(sessionId, [updated])
  log.info('撤销文件改动', {
    logId,
    path: row.path,
    toolName: row.toolName,
    created: row.createdAt
  })
  return { ok: true }
}

/**
 * 撤销本会话全部已应用改动（阶段三 oops，等价回退到本会话首次改动前）。
 * 逐文件校验（期望状态 = 按时间线重放 applied/skipped→after、undone→before），
 * 外部修改过 / 快照缺失的文件跳过并在 failures 报告，其余照常回退：
 * 首条记录 before_hash=null → 删除文件；最早一条 applied 标 undone、其余标 superseded（cascade）。
 */
export async function undoSessionFileChanges(sessionId: string): Promise<RevertResult> {
  const rows = db.listFileChangesBySession(sessionId)
  // 子代理（task）复用宿主会话 id 记录，无需合并父子会话
  const appliedByPath = new Map<string, FileChangeRow[]>()
  for (const r of rows) {
    if (r.status !== 'applied') continue
    const list = appliedByPath.get(r.path)
    if (list) list.push(r)
    else appliedByPath.set(r.path, [r])
  }
  if (appliedByPath.size === 0) return { ok: true, count: 0, failures: [] }

  const failures: RevertFailure[] = []
  let count = 0
  for (const [file, appliedRows] of appliedByPath) {
    const allRows = rows.filter((r) => r.path === file)
    const first = allRows[0]
    const targetHash = first.beforeHash

    // 期望当前状态：从首条记录前重放（superseded/failed 不改变状态；skipped 的写入确实发生）
    let expected: string | null = first.beforeHash
    for (const r of allRows) {
      if (r.status === 'applied' || r.status === 'skipped') expected = r.afterHash
      else if (r.status === 'undone') expected = r.beforeHash
    }
    const cur = await currentHash(file)
    if (cur !== expected) {
      failures.push({ path: file, error: '文件已被外部修改，已跳过' })
      continue
    }
    // 目标快照缺失前置判断：首条 skipped 即未存快照（二进制/超限/读取失败），
    // 且 skipped 行永不落 blob（beforeHash 为 null 时更不代表「新建」）——
    // 必须拒绝，否则会落进下面的「本会话新建」分支误删会话前已存在的文件
    if (first.status === 'skipped') {
      failures.push({
        path: file,
        error: `本会话首次改动未记录快照（${first.undoError ?? '原因未知'}），无法完整回退`
      })
      continue
    }

    try {
      await assertUndoWritable(sessionId, file)
      if (targetHash === null) {
        if (expected !== null) await rm(file) // 本会话新建的文件：校验后删除（本就不存在则无事可做）
      } else {
        const blob = await readBlob(targetHash)
        if (!blob) throw new Error('快照数据缺失（可能已被清理）')
        await atomicWrite(file, blob)
      }
      db.updateFileChangeStatus(appliedRows[0].id, 'undone')
      for (const r of appliedRows.slice(1)) db.updateFileChangeStatus(r.id, 'superseded')
      count++
    } catch (err) {
      failures.push({ path: file, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const updatedRows = db.listFileChangesBySession(sessionId)
  pushFileChanges(sessionId, updatedRows)
  log.info('撤销会话文件改动', { sessionId, files: count, skipped: failures.length })
  return { ok: true, count, failures }
}

/** 会话全部文件变更（卡片按 toolCallId 建立映射）。 */
export function listSessionFileChanges(sessionId: string): FileChangeItem[] {
  return db.listFileChangesBySession(sessionId).map(toItem)
}

// ==================== 清理（blob GC） ====================

/**
 * 快照 GC：删除已无任何 log 行引用的孤儿 blob（含 undone/superseded 行的引用——
 * 会话级回退的目标可能是已被单条撤销的首条记录，不能只看 applied）。
 * 记录行由 FK 级联随会话物理删除清掉（回收站软删除保留），此处只回收磁盘：
 * 触发点 = 服务构造（启动）/ 清空回收站 / 到期清理 / 工作区删除。
 */
export async function gcFileHistoryBlobs(): Promise<number> {
  const referenced = db.listReferencedBeforeHashes()
  const root = blobsRoot()
  let removed = 0
  let shards: string[]
  try {
    shards = await readdir(root)
  } catch {
    return 0 // 目录不存在 = 从未记录过快照
  }
  for (const shard of shards) {
    const shardDir = path.join(root, shard)
    let entries: string[]
    try {
      entries = await readdir(shardDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (referenced.has(name)) continue
      await rm(path.join(shardDir, name), { force: true })
      removed++
    }
  }
  if (removed > 0) log.info('文件快照 GC 完成', { removed })
  return removed
}
