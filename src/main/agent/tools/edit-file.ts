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
          '要替换的原文片段，必须在文件中唯一精确匹配（含换行与空白）。read_file 输出带行号前缀，复制原文时请去掉行号与制表符前缀。'
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

    const diff = buildDiff(content, result, applied, p.path)
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
 * 匹配失败时附带近似候选诊断（空白差异 / 大小写差异 / 行号前缀误粘贴），
 * 让模型能在下一轮直接用错误信息中给出的文件原文修正重试，避免反复试错。
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
      throw new Error(buildMismatchError(content, path, i + 1, edit.oldText))
    }
    if (content.indexOf(edit.oldText, index + 1) !== -1) {
      throw new Error(
        `第 ${i + 1} 处替换失败：该片段在文件中出现多次，不唯一。请扩大 oldText 范围，包含更多上下文使其唯一。`
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

/** 匹配失败的诊断信息：依次尝试行号前缀误粘贴、空白差异、大小写差异，给出可复制的文件原文。 */
function buildMismatchError(content: string, path: string, index: number, oldText: string): string {
  const head = `第 ${index} 处替换失败：未在 ${path} 中找到精确匹配的原文片段。`
  const tail = '请改用错误信息中给出的文件原文片段（缩进与空白须完全一致）重新调用。'
  const hints: string[] = []

  // read_file 输出带行号前缀（如 "  12\tfoo"），模型误把前缀带进 oldText 是高频错误
  if (/^\s*\d+\t/m.test(oldText)) {
    hints.push('检测到 oldText 含 read_file 的行号前缀（数字+制表符），请去掉行号后重试。')
  }

  // 空白差异：把 oldText 的空白串视为「一个或多个任意空白字符」再匹配
  const wsRegex = whitespaceTolerantRegex(oldText)
  if (wsRegex) {
    const hits = findAll(content, wsRegex)
    if (hits.length === 1) {
      const [text, start] = hits[0]
      return `${head}\n但发现 1 处仅空白/换行有差异的匹配（第 ${lineAt(content, start)} 行），文件中的实际内容为：\n${clip(text)}\n${tail}`
    }
  }

  // 大小写差异：忽略大小写后可唯一命中
  const lower = content.toLowerCase()
  const probe = oldText.toLowerCase()
  const first = lower.indexOf(probe)
  if (first !== -1 && lower.indexOf(probe, first + 1) === -1) {
    return `${head}\n但发现 1 处仅大小写有差异的匹配（第 ${lineAt(content, first)} 行），文件中的实际内容为：\n${clip(content.slice(first, first + oldText.length))}\n${tail}`
  }

  return hints.length > 0
    ? `${head}\n${hints.join('\n')}`
    : `${head}\n请先用 read_file 读取该区域原文（可配合 offset/limit），确保 oldText 与文件内容逐字符一致后重试。`
}

/** 构造空白容忍正则：oldText 的每个空白串 → \s+（可匹配不同缩进/换行风格）。无法构造时返回 null。 */
function whitespaceTolerantRegex(oldText: string): RegExp | null {
  const parts = oldText.split(/\s+/).filter((s) => s.length > 0)
  if (parts.length === 0) return null
  try {
    return new RegExp(parts.map(escapeRegex).join('\\s+'))
  } catch {
    return null
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 收集正则全部命中（返回 [匹配文本, 起始位置]，上限防灾难回溯）。 */
function findAll(content: string, re: RegExp): [string, number][] {
  const hits: [string, number][] = []
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = g.exec(content)) !== null && hits.length < 3) {
    hits.push([m[0], m.index])
    if (m[0].length === 0) g.lastIndex++
  }
  return hits
}

/** 候选片段裁剪：最长 500 字符，超长保留首尾。 */
function clip(text: string, max = 500): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n……（中略）……\n${text.slice(-half)}`
}

/**
 * 生成标准 unified diff（每处替换一个 hunk，带 2 行上下文，相邻 hunk 重叠时合并）。
 * 新侧内容直接取自实际写入的 result（按字符偏移映射），hunk 区域内用 LCS 行对比，
 * 因此对任意对齐方式（行中替换 / newText='' 残留空行 / oldText 带尾换行）都忠实反映真实写入。
 */
const DIFF_CONTEXT = 2
/** LCS DP 表规模上限（区域行数乘积），超过则退化为整块 -/+ 输出，防超大文件内存失控。 */
const MAX_LCS_CELLS = 4_000_000

function buildDiff(content: string, result: string, applied: AppliedEdit[], path: string): string {
  const lines = content.split('\n')
  // 尾部换行产生的空元素不是真实行（否则产生幽灵上下文行，git apply / diff 解析器都会拒绝）
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  // 各行起始偏移（新旧内容按编辑字符差映射后，行边界仍是行边界）
  const lineStarts: number[] = [0]
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1)
  }
  // 尾行是否缺换行（决定 \ No newline at end of file 标记）
  const oldNoEol = content.length > 0 && !content.endsWith('\n')
  const newNoEol = result.length > 0 && !result.endsWith('\n')

  // 1. 按编辑位置计算上下文范围，重叠的合并为同一 hunk
  const hunks: { from: number; to: number; edits: AppliedEdit[] }[] = []
  for (const e of applied) {
    const first = e.line - 1
    const last = first + e.oldText.split('\n').length - 1
    const from = Math.max(0, first - DIFF_CONTEXT)
    const to = Math.min(lines.length - 1, last + DIFF_CONTEXT)
    const prev = hunks[hunks.length - 1]
    if (prev && from <= prev.to + 1) {
      prev.to = Math.max(prev.to, to)
      prev.edits.push(e)
    } else {
      hunks.push({ from, to, edits: [e] })
    }
  }

  // 2. 逐 hunk：旧侧取原文行，新侧从 result 对应区域切片，LCS 对比输出 ' '/-/+ 行
  // 绝对路径的开头 '/' 吸收进 a//b 前缀（a/tmp/x），git apply -p1 剥离后即为合法相对路径；
  // 若写成 a//tmp/x，git apply 会因路径以 / 开头拒绝（error: invalid path）
  const header = (prefix: 'a' | 'b'): string =>
    path.startsWith('/') ? `${prefix}${path}` : `${prefix}/${path}`
  const out: string[] = [`--- ${header('a')}`, `+++ ${header('b')}`]
  let charDelta = 0 // 前序编辑累计的字符差（原文偏移 → 新文偏移）
  let lineDelta = 0 // 前序 hunk 累计的行数差（@@ 头 + 侧行号）
  for (const h of hunks) {
    const oldStart = lineStarts[h.from]
    const oldEnd = h.to + 1 < lines.length ? lineStarts[h.to + 1] : content.length
    const d = h.edits.reduce((sum, e) => sum + e.newText.length - e.oldText.length, 0)
    const oldL = lines.slice(h.from, h.to + 1)
    const newL = result.slice(oldStart + charDelta, oldEnd + charDelta + d).split('\n')
    if (newL.length > 1 && newL[newL.length - 1] === '') newL.pop()
    const hunkBody: string[] = []
    if (!emitRegion(hunkBody, oldL, newL, oldNoEol, newNoEol)) continue // 无差异（no-op 编辑），跳过空 hunk
    out.push(`@@ -${h.from + 1},${oldL.length} +${h.from + 1 + lineDelta},${newL.length} @@`)
    out.push(...hunkBody)
    charDelta += d
    lineDelta += newL.length - oldL.length
  }
  return out.join('\n')
}

/** 尾行换行缺失标记（按 unified diff 规范，跟随在相应 ' '/-/+ 行之后，不计入行数）。 */
const NO_EOL = '\\ No newline at end of file'

/**
 * hunk 区域行对比：LCS 公共行作上下文，区域过大时退化为整块 -/+。
 * 「行尾是否带换行」参与相等判定：两侧尾行换行状态不同时视为不同行（输出 -/+ 各一行），
 * 保证无尾换行文件（及仅在 EOF 增删换行的编辑）生成的 patch 能被 git apply 正确应用。
 * 返回是否产生了差异行（纯上下文的空 hunk 由调用方丢弃）。
 */
function emitRegion(out: string[], a: string[], b: string[], aNoEol: boolean, bNoEol: boolean): boolean {
  const eolA = (i: number): boolean => i < a.length - 1 || !aNoEol
  const eolB = (j: number): boolean => j < b.length - 1 || !bNoEol
  const n = a.length
  const m = b.length
  if (a.length * b.length > MAX_LCS_CELLS) {
    for (let i = 0; i < n; i++) {
      out.push(`-${a[i]}`)
      if (!eolA(i)) out.push(NO_EOL)
    }
    for (let j = 0; j < m; j++) {
      out.push(`+${b[j]}`)
      if (!eolB(j)) out.push(NO_EOL)
    }
    return true
  }
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] && eolA(i) === eolB(j)
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  let changed = false
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j] && eolA(i) === eolB(j)) {
      out.push(` ${a[i]}`)
      if (!eolA(i)) out.push(NO_EOL)
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push(`-${a[i]}`)
      if (!eolA(i)) out.push(NO_EOL)
      i++
      changed = true
    } else {
      out.push(`+${b[j]}`)
      if (!eolB(j)) out.push(NO_EOL)
      j++
      changed = true
    }
  }
  while (i < n) {
    out.push(`-${a[i]}`)
    if (!eolA(i)) out.push(NO_EOL)
    i++
    changed = true
  }
  while (j < m) {
    out.push(`+${b[j]}`)
    if (!eolB(j)) out.push(NO_EOL)
    j++
    changed = true
  }
  return changed
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
