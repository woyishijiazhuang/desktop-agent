import type { Mdize } from 'mdize'
import { basename, extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createLogger } from './log'

const log = createLogger('docParser')

/**
 * 文档解析：基于 mdize（微软 MarkItDown 的 TS 移植）把 docx / pdf / xlsx / pptx / csv
 * 等文档转成 Markdown 文本，供 read_file 工具与聊天附件使用。
 *
 * - 纯文本（txt/md/json/xml）不走解析器，直接读 UTF-8 原文
 * - 解析结果有大小上限，防止超大文档撑爆模型上下文
 * - mdize 对 csv 等无魔数的纯文本格式需要显式 mimetype 才能命中转换器
 * - mdize 在模块顶层急切引入 pdfjs/tesseract 等重依赖，故惰性加载：
 *   仅首次实际解析文档时才动态 import，避免拖慢应用启动
 */

/** 需要解析器处理的文档扩展名。 */
const DOCUMENT_EXTS = new Set(['.docx', '.pdf', '.xlsx', '.pptx', '.csv'])

/** 扩展名 → mimetype（mdize 部分格式需显式 mimetype 才能匹配，如 csv）。 */
const MIME_BY_EXT: Record<string, string> = {
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf'
}

/** 解析提取文本的最大字符数（超出截断）。 */
export const MAX_EXTRACT_CHARS = 300_000

/** mdize 单例（惰性初始化，promise 缓存避免并发首次解析重复加载）。 */
let mdizePromise: Promise<Mdize> | null = null
async function getMdize(): Promise<Mdize> {
  if (!mdizePromise) {
    mdizePromise = import('mdize').then(({ Mdize }) => new Mdize())
  }
  return mdizePromise
}

/** 是否是需要解析器处理的文档（按扩展名判断）。 */
export function isDocumentFile(filePath: string): boolean {
  return DOCUMENT_EXTS.has(extname(filePath).toLowerCase())
}

/** 从文档字节解析为 Markdown 文本（失败抛错，超长截断）。 */
export async function extractDocumentText(buffer: Uint8Array, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase()
  const start = Date.now()
  const mdize = await getMdize()
  const result = await mdize.convertBuffer(Buffer.from(buffer), {
    filename: basename(filename),
    extension: ext.slice(1),
    mimetype: MIME_BY_EXT[ext]
  })
  const text = truncate(result.markdown ?? '')
  log.debug('文档解析完成', {
    filename,
    ext,
    inputBytes: buffer.byteLength,
    outputChars: text.length,
    durationMs: Date.now() - start
  })
  return text
}

/** 读取文件并解析（read_file 工具用）。 */
export async function readAndExtractDocument(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return extractDocumentText(buf, basename(filePath))
}

function truncate(text: string): string {
  if (text.length <= MAX_EXTRACT_CHARS) return text
  return `${text.slice(0, MAX_EXTRACT_CHARS)}\n\n[内容过长，已截断]`
}
