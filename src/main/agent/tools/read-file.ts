import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { nativeImage } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { isDocumentFile, readAndExtractDocument } from '../../utils/doc-parser'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:read_file')

/** 纯文本文件默认截断上限：超出的部分不注入上下文，提示用 offset 续读。 */
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024
/** 图片大小上限：超过则不注入（各提供方 base64 上限约 5MB）。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 超限图片压缩目标：最长边上限（视觉模型按固定图块缩放理解，超高分辨率增益有限）。 */
const COMPRESS_MAX_EDGE = 2048
/** 超限图片压缩 JPEG 质量。 */
const COMPRESS_JPEG_QUALITY = 85
/** 可自动压缩的图片格式（GIF 动图不压缩：展平为单帧会丢动画语义，直接按超限拒绝）。 */
const COMPRESSIBLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** 二进制检测窗口：开头 8KB 内含 NUL 字节即判定为二进制。 */
const BINARY_SNIFF_BYTES = 8192

/** 提供方普遍支持的图片类型（BMP 提供方多不支持，不在此列；SVG 是文本直接按文本读）。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"读取 package.json 查看依赖"）。请务必填写。'
    })
  ),
  path: Type.String({
    description:
      '要读取的文件的绝对路径。支持纯文本（UTF-8）、图片（png/jpg/gif/webp，需多模态模型）与常见文档（docx / pdf / xlsx / pptx / csv，自动解析为 Markdown）。'
  }),
  offset: Type.Optional(
    Type.Number({
      description:
        '起始行号（从 1 开始）。用于分段读取大文件，与 limit 配合只读取指定行范围。仅对纯文本文件生效。'
    })
  ),
  limit: Type.Optional(Type.Number({ description: '最多读取的行数。仅对纯文本文件生效。' }))
})

export interface ReadFileDetails {
  path: string
  bytes: number
  truncated?: boolean
  /** 为 true 时返回了 image block（仅多模态模型）。 */
  image?: boolean
}

/**
 * 创建 read_file 工具实例。
 * supportsImages 由当前会话模型的 input 能力决定（model.input 含 'image'）：
 * - 支持：图片文件返回 image content block（base64），供多模态模型直接查看；
 * - 不支持：返回文本提示而非 image block —— pi-ai 不会按模型能力过滤，
 *   image block 发给纯文本模型会在下一次模型调用时被提供方以 400 拒绝，导致整回合中断。
 */
export function createReadFileTool(
  supportsImages: boolean
): AgentTool<typeof params, ReadFileDetails> {
  return {
    name: 'read_file',
    label: '读取文件',
    description:
      '读取指定路径的文件内容。纯文本直接返回原文并带行号（超过 2000 行或 50KB 自动截断并提示继续读取，可用 offset/limit 分段读取）；Word/PDF/Excel/PPT/CSV 文档自动解析为 Markdown 后返回；图片文件返回图像内容（需多模态模型支持）。',
    parameters: params,
    executionMode: 'parallel',
    async execute(_toolCallId, p) {
      const start = Date.now()
      // 三种形态分流：文档（mdize 解析）→ 图片（多模态注入/提示）→ 纯文本（行号输出）
      if (isDocumentFile(p.path)) {
        const content = await readAndExtractDocument(p.path)
        log.debug('读取文件', {
          path: p.path,
          bytes: content.length,
          durationMs: Date.now() - start,
          isDocument: true
        })
        return {
          content: [{ type: 'text', text: content }],
          details: { path: p.path, bytes: content.length }
        }
      }

      const buf = await readFile(p.path)
      const mime = IMAGE_MIME_BY_EXT[extname(p.path).toLowerCase()]
      if (mime && looksLikeImage(buf)) {
        const bytes = buf.byteLength
        if (supportsImages && bytes <= MAX_IMAGE_BYTES) {
          log.debug('读取图片', { path: p.path, bytes, durationMs: Date.now() - start })
          return {
            content: [
              { type: 'image', data: buf.toString('base64'), mimeType: mime },
              {
                type: 'text',
                text: `[图片：${basename(p.path)}，${Math.round(bytes / 1024)}KB，${mime}]`
              }
            ],
            details: { path: p.path, bytes, image: true }
          }
        }
        // 超限但可压缩：自动降分辨率 + 转 JPEG 后注入（视觉模型按图块缩放理解，压缩无损于理解）
        if (supportsImages && COMPRESSIBLE_MIME.has(mime)) {
          const compressed = compressImage(buf)
          if (compressed && compressed.byteLength < bytes && compressed.byteLength <= MAX_IMAGE_BYTES) {
            log.debug('读取图片（超限已自动压缩）', {
              path: p.path,
              originalBytes: bytes,
              compressedBytes: compressed.byteLength
            })
            return {
              content: [
                { type: 'image', data: compressed.toString('base64'), mimeType: 'image/jpeg' },
                {
                  type: 'text',
                  text: `[图片：${basename(p.path)}，原 ${Math.round(bytes / 1024 / 1024)}MB，已自动压缩至 ${Math.round(compressed.byteLength / 1024)}KB 以适配模型上限]`
                }
              ],
              details: { path: p.path, bytes, image: true, compressed: true }
            }
          }
        }
        // 不支持图片 / 图片过大且无法压缩：返回文本提示而非 image block（image block 发给纯文本模型会被提供方 400 拒绝）
        const text = !supportsImages
          ? `(当前模型不支持图片输入，无法查看图片内容。\n文件：${basename(p.path)}（${Math.round(bytes / 1024)}KB，${mime}）。\n建议：请用户切换多模态模型后重试，或请用户用文字描述图片内容。)`
          : `(图片过大：${basename(p.path)} 为 ${Math.round(bytes / 1024 / 1024)}MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限，且无法自动压缩（可能是动图或非可转码格式），未注入。建议压缩或缩小分辨率后重试。)`
        log.debug('读取图片被拦截', { path: p.path, bytes, supportsImages })
        return { content: [{ type: 'text', text }], details: { path: p.path, bytes } }
      }

      if (isBinary(buf)) {
        throw new Error(
          `二进制文件不支持读取：${basename(p.path)}（${extname(p.path) || '未知扩展名'}，${Math.round(buf.byteLength / 1024)}KB）。若是文档请确认扩展名正确，否则无法作为文本注入上下文。`
        )
      }

      const result = readText(buf, p.offset, p.limit)
      log.debug('读取文本文件', {
        path: p.path,
        bytes: Buffer.byteLength(result.rawSelected, 'utf-8'),
        truncated: result.truncated,
        durationMs: Date.now() - start
      })
      return {
        content: [{ type: 'text', text: result.text }],
        details: {
          path: p.path,
          bytes: Buffer.byteLength(result.rawSelected, 'utf-8'),
          truncated: result.truncated
        }
      }
    }
  }
}

/** 注册表占位实例（仅用于 UI 展示 name/label/description，实际执行走 buildTools 按模型能力创建的实例）。 */
export const readFileTool = createReadFileTool(false)

/**
 * 超限图片自动压缩：降分辨率（最长边 ≤ COMPRESS_MAX_EDGE）+ 转 JPEG。
 * 视觉模型内部按固定图块缩放理解，超高分辨率对理解增益有限，压缩基本无损于可用性。
 * 解码失败（nativeImage 不支持的编码）返回 null，调用方回退原拒绝提示。
 */
function compressImage(buf: Buffer): Buffer | null {
  try {
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    if (width <= 0 || height <= 0) return null
    const longest = Math.max(width, height)
    const scale = Math.min(1, COMPRESS_MAX_EDGE / longest)
    const resized =
      scale < 1
        ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
        : img
    const jpeg = resized.toJPEG(COMPRESS_JPEG_QUALITY)
    return jpeg.byteLength > 0 ? jpeg : null
  } catch (err) {
    log.warn('图片自动压缩失败', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** 魔数校验：扩展名声称是图片时验证真实格式，防止文本文件伪装成图片破坏请求。 */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false
  return (
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) || // PNG
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || // JPEG
    (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) || // GIF
    (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45) // WEBP (RIFF....WEBP)
  )
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

interface ReadTextResult {
  text: string
  /** 未加行号的选中原文（用于 details.bytes 统计）。 */
  rawSelected: string
  truncated: boolean
}

/** 按 offset/limit 读取纯文本并附加行号（cat -n 风格），超出上限时截断并附续读提示。 */
function readText(buf: Buffer, offset?: number, limit?: number): ReadTextResult {
  const allLines = buf.toString('utf-8').split('\n')
  // 尾部换行产生的末尾空元素不算一行（对齐 cat -n 语义）
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  const total = allLines.length
  const startIdx = offset ? Math.max(0, offset - 1) : 0
  if (startIdx >= total) {
    throw new Error(`offset ${offset} 超出文件总行数（共 ${total} 行）`)
  }
  const endIdx = limit !== undefined ? Math.min(startIdx + limit, total) : total

  // 截断：优先限行数，其次限字节（按行递减直到不超限）
  let truncated = false
  let linesArr = allLines.slice(startIdx, endIdx)
  if (linesArr.length > MAX_LINES) {
    linesArr = linesArr.slice(0, MAX_LINES)
    truncated = true
  }
  while (Buffer.byteLength(linesArr.join('\n'), 'utf-8') > MAX_BYTES && linesArr.length > 1) {
    linesArr = linesArr.slice(0, linesArr.length - 1)
    truncated = true
  }
  const outputLines = linesArr.length

  // 行号右对齐 + tab，便于模型按行号定位；edit_file 的 oldText 需去掉行号前缀
  const width = String(startIdx + outputLines).length
  const numbered = linesArr
    .map((l, i) => `${String(startIdx + i + 1).padStart(width)}\t${l}`)
    .join('\n')

  if (truncated) {
    const shownEnd = startIdx + outputLines
    return {
      text: `${numbered}\n\n[内容较长，仅显示第 ${startIdx + 1}-${shownEnd} 行（共 ${total} 行）。如需继续，使用 offset=${shownEnd + 1}]`,
      rawSelected: linesArr.join('\n'),
      truncated: true
    }
  }
  if (outputLines < total) {
    return {
      text: `${numbered}\n\n[还剩 ${total - (startIdx + outputLines)} 行未读取。如需继续，使用 offset=${startIdx + outputLines + 1}]`,
      rawSelected: linesArr.join('\n'),
      truncated: false
    }
  }
  return { text: numbered, rawSelected: linesArr.join('\n'), truncated: false }
}
