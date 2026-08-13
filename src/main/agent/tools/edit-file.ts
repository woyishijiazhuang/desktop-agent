import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readFile, writeFile } from 'node:fs/promises'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:edit_file')

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"修正 README 中的命令示例"）。请务必填写。'
    })
  ),
  path: Type.String({ description: '要编辑的文件的绝对路径（文件必须已存在）' }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          '要替换的原文片段，必须在文件中唯一精确匹配（含换行与空白，可用 read_file 先读取原文）。'
      }),
      newText: Type.String({ description: '替换后的新文本' })
    }),
    {
      description:
        '一处或多处精确替换。每处 oldText 必须唯一匹配原文件且互不重叠；改动集中在同一块区域时应合并为一段，而不是发出相邻/嵌套的编辑。'
    }
  )
})

export interface EditFileDetails {
  path: string
  count: number
  firstChangedLine?: number
  diff: string
}

/** 单处替换的匹配结果（基于 LF 归一化后的内容）。 */
interface AppliedEdit {
  start: number
  end: number
  oldText: string
  newText: string
  line: number
}

/**
 * 编辑文件工具：对已存在文件做一处或多处精确文本替换（增量编辑）。
 * 与 write_file 的区别：只改动命中片段，其余内容原样保留，适合修改已有文档/代码；
 * 每次替换要求 oldText 在原文中唯一精确匹配，互不重叠，按逆序应用保证偏移稳定。
 * 保留 BOM 与原始行尾（LF/CRLF）。危险操作（DANGEROUS_TOOLS），执行前需权限确认。
 */
export const editFileTool: AgentTool<typeof params, EditFileDetails> = {
  name: 'edit_file',
  label: '编辑文件',
  description:
    '编辑已存在的文件：通过一处或多处「原文→新文本」精确替换实现增量修改，仅改动命中片段。适合修改文档或代码的局部内容，避免整体重写。',
  parameters: params,
  executionMode: 'sequential',
  async execute(_toolCallId, p) {
    if (!Array.isArray(p.edits) || p.edits.length === 0) {
      throw new Error('edits 必须包含至少一处替换')
    }
    const { bom, text } = stripBom(await readFile(p.path, 'utf-8'))
    const originalEnding = detectLineEnding(text)
    const content = normalizeToLF(text)
    const applied = matchEdits(content, p.path, p.edits)

    // 逆序应用，偏移不受已应用替换影响
    let result = content
    for (const e of [...applied].reverse()) {
      result = result.slice(0, e.start) + e.newText + result.slice(e.end)
    }

    const diff = buildDiff(applied)
    const firstChangedLine = applied[0]?.line
    await writeFile(p.path, bom + restoreLineEndings(result, originalEnding), 'utf-8')
    log.info('编辑文件', {
      path: p.path,
      editCount: applied.length,
      firstChangedLine,
      bytes: Buffer.byteLength(bom + restoreLineEndings(result, originalEnding), 'utf-8')
    })
    return {
      content: [
        {
          type: 'text',
          text: `已替换 ${applied.length} 处${firstChangedLine !== undefined ? `（首个改动在第 ${firstChangedLine} 行）` : ''}：\n${diff}`
        }
      ],
      details: { path: p.path, count: applied.length, firstChangedLine, diff }
    }
  }
}

/**
 * 逐条匹配 edits：全部基于原始内容查找（非增量），校验唯一性，再按位置排序检查重叠。
 * 任一处匹配失败即整体失败（不写盘），保证不会写出半成品。
 */
function matchEdits(
  content: string,
  path: string,
  edits: { oldText: string; newText: string }[]
): AppliedEdit[] {
  const applied: AppliedEdit[] = []
  for (const [i, edit] of edits.entries()) {
    const index = content.indexOf(edit.oldText)
    if (index === -1) {
      throw new Error(
        `第 ${i + 1} 处替换失败：未在 ${path} 中找到精确匹配的原文片段。请先用 read_file 读取文件原文，确保 oldText 与文件内容完全一致（含换行与空白）后重试。`
      )
    }
    if (content.indexOf(edit.oldText, index + 1) !== -1) {
      throw new Error(
        `第 ${i + 1} 处替换失败：该片段在文件中出现多次，不唯一。请提供包含更多上下文的唯一片段。`
      )
    }
    applied.push({
      start: index,
      end: index + edit.oldText.length,
      oldText: edit.oldText,
      newText: edit.newText,
      line: lineAt(content, index)
    })
  }
  // 重叠校验：按起始位置排序后，前一处不能侵入后一处的范围
  const sorted = [...applied].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error(`替换片段相互重叠，请合并为一段编辑：第 ${i} 处与第 ${i + 1} 处`)
    }
  }
  return sorted
}

/** 生成面向展示的简易 diff：每处替换输出 行号 + 删除/新增片段（截断超长行）。 */
function buildDiff(applied: AppliedEdit[]): string {
  const lines: string[] = []
  for (const e of applied) {
    lines.push(`@@ 第 ${e.line} 行 @@`)
    lines.push(`- ${truncateLine(e.oldText)}`)
    lines.push(`+ ${truncateLine(e.newText)}`)
  }
  return lines.join('\n')
}

/** 截断为单行展示（换行转义、超长省略）。 */
function truncateLine(text: string, max = 200): string {
  const oneLine = text.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

/** 位置 pos（0-indexed）在 LF 归一化内容中的行号（1-indexed）。 */
function lineAt(content: string, pos: number): number {
  let line = 1
  for (let i = 0; i < pos && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/** 剥离 UTF-8 BOM，返回 BOM 与正文。 */
function stripBom(text: string): { bom: string; text: string } {
  return text.charCodeAt(0) === 0xfeff ? { bom: '\uFEFF', text: text.slice(1) } : { bom: '', text }
}

/** 检测文件行尾风格（CRLF 优先，未检出视为 LF）。 */
function detectLineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}
