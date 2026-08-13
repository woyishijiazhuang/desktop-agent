import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readFile } from 'node:fs/promises'
import { isDocumentFile, readAndExtractDocument } from '../../utils/doc-parser'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:read_file')

/** 纯文本文件默认截断上限：超出的部分不注入上下文，提示用 offset 续读。 */
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"读取 package.json 查看依赖"）。请务必填写。'
    })
  ),
  path: Type.String({
    description:
      '要读取的文件的绝对路径。支持纯文本（UTF-8）与常见文档（docx / pdf / xlsx / pptx / csv，自动解析为 Markdown）。'
  }),
  offset: Type.Optional(
    Type.Number({
      description:
        '起始行号（从 1 开始）。用于分段读取大文件，与 limit 配合只读取指定行范围。仅对纯文本文件生效。'
    })
  ),
  limit: Type.Optional(Type.Number({ description: '最多读取的行数。仅对纯文本文件生效。' }))
})

export const readFileTool: AgentTool<
  typeof params,
  { path: string; bytes: number; truncated?: boolean }
> = {
  name: 'read_file',
  label: '读取文件',
  description:
    '读取指定路径的文件内容。纯文本直接返回原文（超过 2000 行或 50KB 自动截断并提示继续读取，可用 offset/limit 分段读取）；Word/PDF/Excel/PPT/CSV 文档自动解析为 Markdown 后返回。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const start = Date.now()
    // 文档（docx/pdf/xlsx/pptx/csv）：走 mdize 解析为 Markdown；其余按 UTF-8 原文读取
    const content = isDocumentFile(p.path)
      ? await readAndExtractDocument(p.path)
      : await readText(p.path, p.offset, p.limit)
    log.debug('读取文件', {
      path: p.path,
      bytes: content.length,
      durationMs: Date.now() - start,
      isDocument: isDocumentFile(p.path)
    })
    return {
      content: [{ type: 'text', text: content }],
      details: { path: p.path, bytes: content.length }
    }
  }
}

/** 按 offset/limit 读取纯文本，超出 MAX_LINES / MAX_BYTES 时截断并附续读提示。 */
async function readText(path: string, offset?: number, limit?: number): Promise<string> {
  const text = await readFile(path, 'utf-8')
  const allLines = text.split('\n')
  const total = allLines.length
  const startIdx = offset ? Math.max(0, offset - 1) : 0
  if (startIdx >= total) {
    throw new Error(`offset ${offset} 超出文件总行数（共 ${total} 行）`)
  }
  const endIdx = limit !== undefined ? Math.min(startIdx + limit, total) : total
  let selected = allLines.slice(startIdx, endIdx).join('\n')

  // 截断：优先限行数，其次限字节（按行递减直到不超限）
  let truncated = false
  let outputLines = endIdx - startIdx
  let linesArr = selected.split('\n')
  if (linesArr.length > MAX_LINES) {
    linesArr = linesArr.slice(0, MAX_LINES)
    selected = linesArr.join('\n')
    outputLines = MAX_LINES
    truncated = true
  }
  let bytes = Buffer.byteLength(selected, 'utf-8')
  while (bytes > MAX_BYTES && linesArr.length > 1) {
    linesArr = linesArr.slice(0, linesArr.length - 1)
    selected = linesArr.join('\n')
    outputLines = linesArr.length
    bytes = Buffer.byteLength(selected, 'utf-8')
    truncated = true
  }

  if (!truncated && outputLines < total) {
    // 用户指定了范围但未截断：提示剩余行数，方便继续读取
    return `${selected}\n\n[还剩 ${total - (startIdx + outputLines)} 行未读取。如需继续，使用 offset=${startIdx + outputLines + 1}]`
  }
  if (truncated) {
    const shownEnd = startIdx + outputLines
    return `${selected}\n\n[内容较长，仅显示第 ${startIdx + 1}-${shownEnd} 行（共 ${total} 行）。如需继续，使用 offset=${shownEnd + 1}]`
  }
  return selected
}
