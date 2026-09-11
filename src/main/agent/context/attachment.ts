import { app } from 'electron'
import { join, extname } from 'node:path'
import { mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises'
import { db } from '../database'
import { createLogger } from '../utils/log'

const log = createLogger('attachment')

/**
 * 本地附件存储：图片等大文件落盘到 userData/attachments/，DB 消息只存 file 引用。
 *
 * 目录结构：
 *   {userData}/attachments/{sessionId}/{uuid}.{ext}
 *
 * 消息 content 中 image block 的 data 字段形态：
 *   - 内存态（渲染层预览 / agent 输入）：base64（标准 pi-ai ImageContent）
 *   - DB 态：`file:{sessionId}/{uuid}.{ext}`（file: 前缀标记本地引用）
 *
 * 转换职责：
 *   - 落库：base64 → saveImageAttachment → data 换 file 引用（convert.persistMessageImages）
 *   - rehydrate：file 引用 → readAttachmentBase64 → 还原 base64（convert.rowsToAgentMessages）
 *   - 展示：file 引用 → readAttachmentDataUrl（渲染层经 IPC 调用）
 */

/** 附件根目录（按需惰性计算，app ready 后才能访问 userData）。 */
export function attachmentRoot(): string {
  return join(app.getPath('userData'), 'attachments')
}

/** 图片 MIME → 扩展名。 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
}

/** 扩展名 → MIME（读回时用于构造 data URL）。 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

/** 图片 MIME → 扩展名（未知类型回退 .png）。 */
export function extFromMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? '.png'
}

/** 扩展名 → MIME（未知回退 application/octet-stream）。 */
export function mimeFromExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** data 是否为本地附件引用（file: 前缀）。 */
export function isLocalFileRef(data: string): boolean {
  return data.startsWith('file:')
}

/** 从 file 引用提取相对 key（{sessionId}/{file}）。 */
export function fileRefToKey(data: string): string {
  return data.slice('file:'.length)
}

/** 将 file 引用构造成引用字符串（file:{key}）。 */
export function toFileRef(key: string): string {
  return `file:${key}`
}

/** 写图片附件（base64 解码落盘），返回相对 key。 */
export async function saveImageAttachment(
  sessionId: string,
  mimeType: string,
  base64: string
): Promise<string> {
  const dir = join(attachmentRoot(), sessionId)
  await mkdir(dir, { recursive: true })
  const key = `${sessionId}/${crypto.randomUUID()}${extFromMime(mimeType)}`
  await writeFile(join(attachmentRoot(), key), Buffer.from(base64, 'base64'))
  log.debug('保存图片附件', { sessionId, key, mimeType })
  return key
}

/** 读附件二进制并编码为 base64（rehydrate 还原 image block 用）。 */
export async function readAttachmentBase64(key: string): Promise<string> {
  const buf = await readFile(join(attachmentRoot(), key))
  return buf.toString('base64')
}

/** 读附件为 data URL（渲染进程展示用）。 */
export async function readAttachmentDataUrl(key: string): Promise<string> {
  const buf = await readFile(join(attachmentRoot(), key))
  return `data:${mimeFromExt(extname(key))};base64,${buf.toString('base64')}`
}

/** 删除某会话的全部附件（物理删除会话/清空回收站时调用）。 */
export async function deleteSessionAttachments(sessionId: string): Promise<void> {
  await rm(join(attachmentRoot(), sessionId), { recursive: true, force: true })
}

/** 删除单个附件文件（删除消息时调用，key = 相对路径）。 */
export async function deleteAttachmentFile(key: string): Promise<void> {
  await rm(join(attachmentRoot(), key), { force: true })
}

/**
 * 复制附件文件到目标会话目录（分支复制用），返回新 key。
 * 保留原文件名（uuid 全局唯一，不会冲突），源文件不动。
 */
export async function copyAttachmentToSession(
  key: string,
  targetSessionId: string
): Promise<string> {
  const fileName = key.slice(key.indexOf('/') + 1)
  const dir = join(attachmentRoot(), targetSessionId)
  await mkdir(dir, { recursive: true })
  const newKey = `${targetSessionId}/${fileName}`
  await copyFile(join(attachmentRoot(), key), join(attachmentRoot(), newKey))
  return newKey
}

/** 从消息 content 的 image block 提取全部本地文件引用 key（供删除消息时清理）。 */
export function collectFileRefs(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const keys: string[] = []
  for (const b of content as Record<string, unknown>[]) {
    if (b?.type === 'image' && typeof b.data === 'string' && isLocalFileRef(b.data)) {
      keys.push(fileRefToKey(b.data))
    }
  }
  return keys
}

/**
 * 清理孤儿附件：扫描 attachments 目录，删除不属于任何现存会话
 * （含回收站软删会话）的子目录。应用启动时兜底清理。
 */
export async function cleanupOrphanAttachments(): Promise<void> {
  const root = attachmentRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return // 目录不存在（从未有附件）
  }
  // 现存会话 = 未软删 + 软删（回收站数据保留，直到清空/到期）
  const known = new Set<string>()
  for (const s of db.listSessions()) known.add(s.id)
  for (const s of db.listDeletedSessions()) known.add(s.id)
  let removed = 0
  for (const name of entries) {
    if (known.has(name)) continue
    await rm(join(root, name), { recursive: true, force: true })
    removed++
  }
  if (removed > 0) log.info('清理孤儿附件', { removed })
}
