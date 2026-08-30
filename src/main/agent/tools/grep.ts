import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { resolveAgentSessionWorkdir } from '../workdir'
import { createGlobMatcher, toPosix, walkFiles } from './fs-walk'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:grep')

/** 单个文件大小上限：超过则跳过（避免读取二进制/数据文件拖垮搜索）。 */
const MAX_FILE_BYTES = 1024 * 1024
/** files_with_matches / count 模式返回的文件数上限。 */
const MAX_FILES = 100
/** content 模式默认返回的匹配行数。 */
const DEFAULT_HEAD_LIMIT = 100
/** content 模式单次调用允许的最大匹配行数。 */
const MAX_HEAD_LIMIT = 500
/** 遍历文件数安全上限。 */
const MAX_SCAN = 20_000
/** 输出总字符上限，超出截断。 */
const MAX_OUTPUT = 50_000
/** content 模式单行展示长度上限。 */
const MAX_LINE_CHARS = 500
/** 二进制检测窗口：开头 8KB 内含 NUL 字节即视为二进制文件，跳过。 */
const BINARY_SNIFF_BYTES = 8192

type OutputMode = 'content' | 'files_with_matches' | 'count'

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"定位函数的所有调用点"）。请务必填写。'
    })
  ),
  pattern: Type.String({
    description:
      '要搜索的正则表达式（JavaScript 语法），如 "function\\s+\\w+"、"TODO|FIXME"、"import .* from"。'
  }),
  path: Type.Optional(Type.String({ description: '要搜索的文件或目录绝对路径，默认为工作目录。' })),
  glob: Type.Optional(
    Type.String({
      description:
        '按文件名过滤，如 "*.ts"、"*.{ts,tsx}"。不含 / 时匹配任意深度的文件名；通配符不匹配以 . 开头的隐藏文件（除非显式写 .）。只搜索特定类型文件时建议提供。'
    })
  ),
  output_mode: Type.Optional(
    Type.Union(
      [Type.Literal('content'), Type.Literal('files_with_matches'), Type.Literal('count')],
      {
        description:
          '输出模式：content 显示匹配行及行号；files_with_matches 只显示含匹配的文件路径（按修改时间排序）；count 显示每文件匹配行数。默认 files_with_matches。'
      }
    )
  ),
  case_insensitive: Type.Optional(Type.Boolean({ description: '是否忽略大小写，默认 false。' })),
  context: Type.Optional(
    Type.Number({
      description: 'content 模式下每个匹配行前后额外显示的上下文行数（类似 grep -C），默认 0。'
    })
  ),
  head_limit: Type.Optional(
    Type.Number({ description: 'content 模式下最多返回的匹配行数，默认 100。' })
  )
})

export interface GrepDetails {
  pattern: string
  path: string
  mode: OutputMode
  count: number
}

/** 单文件搜索结果：全部行内容与命中行索引（0-based）。 */
interface FileHit {
  lines: string[]
  matchedIndices: number[]
}

/**
 * 正则内容搜索工具：在文件/目录中按正则匹配行，代替 bash 中调用 grep。
 * 自动跳过 node_modules、.git 等目录、二进制与超大文件。只读操作，无需权限确认。
 * 与 bash/read_file 同理按 Agent 会话绑定工作目录（默认搜索根），故用工厂而非单例。
 */
export function createGrepTool(sessionId: string): AgentTool<typeof params, GrepDetails> {
  return {
    name: 'grep',
    label: '搜索内容',
    description:
      '按正则表达式搜索文件内容，返回匹配的文件/行。用于定位代码、查找符号引用、搜索配置项等，代替 bash 中调用 grep。支持输出模式（匹配行 / 文件列表 / 计数）、文件名过滤（glob）、忽略大小写与上下文行。',
    parameters: params,
    executionMode: 'parallel',
    async execute(_toolCallId, p) {
      const start = Date.now()
      const root = p.path ?? resolveAgentSessionWorkdir(sessionId)
      const mode: OutputMode = p.output_mode ?? 'files_with_matches'

      let regex: RegExp
      try {
        regex = new RegExp(p.pattern, p.case_insensitive ? 'i' : '')
      } catch (err) {
        throw new Error(
          `正则表达式无效：${(err as Error).message}。请检查转义（如匹配字面量 . 需写 \\.）。`
        )
      }

      const rootStat = await stat(root).catch(() => undefined)
      if (!rootStat) {
        throw new Error(`路径不存在：${root}`)
      }

      // 待搜索文件集合：path 为文件时只搜该文件；为目录时递归遍历（可按 glob 过滤）
      let files: string[]
      let scanTruncated = false
      const globMatcher = p.glob ? createGlobMatcher(p.glob) : undefined
      if (rootStat.isFile()) {
        files = [root]
      } else {
        const walked = await walkFiles(root, MAX_SCAN)
        scanTruncated = walked.truncated
        files = walked.files.filter((f) => {
          if (!globMatcher) return true
          return globMatcher(toPosix(relative(root, f)))
        })
      }

      const outLines: string[] = []
      const matchedFiles: { file: string; count: number }[] = []
      let matchedLines = 0
      const headLimit = Math.min(Math.max(1, p.head_limit ?? DEFAULT_HEAD_LIMIT), MAX_HEAD_LIMIT)
      const context = Math.max(0, Math.min(p.context ?? 0, 10))
      let truncated = false

      for (const file of files) {
        if (mode === 'content' && matchedLines >= headLimit) {
          truncated = true
          break
        }
        if (mode !== 'content' && matchedFiles.length >= MAX_FILES) {
          truncated = true
          break
        }
        const hit = await searchFile(file, regex)
        if (!hit) continue
        if (mode === 'content') {
          matchedLines += hit.matchedIndices.length
          emitContent(outLines, file, hit, context)
        } else {
          matchedFiles.push({ file, count: hit.matchedIndices.length })
        }
      }

      // files_with_matches / count 模式按修改时间排序（新→旧），优先展示最近改动的文件
      if (mode !== 'content' && matchedFiles.length > 0) {
        const withMtime = await Promise.all(
          matchedFiles.map(async (m) => ({
            ...m,
            t: (await stat(m.file).catch(() => undefined))?.mtimeMs ?? 0
          }))
        )
        withMtime.sort((a, b) => b.t - a.t)
        for (const m of withMtime) {
          outLines.push(mode === 'count' ? `${m.file}:${m.count}` : m.file)
        }
      }

      let text = outLines.join('\n')
      if (text.length > MAX_OUTPUT) {
        text = text.slice(0, MAX_OUTPUT)
        truncated = true
      }
      if (outLines.length === 0) text = '(无匹配结果)'
      const notes: string[] = []
      if (truncated) {
        notes.push(
          mode === 'content'
            ? `[结果较多，仅显示前 ${Math.min(matchedLines, headLimit)} 个匹配行]`
            : `[匹配文件超过 ${MAX_FILES} 个，仅显示前 ${MAX_FILES} 个]`
        )
      }
      if (scanTruncated) notes.push(`[目录过大，仅扫描了前 ${MAX_SCAN} 个文件]`)
      if (notes.length > 0) text += `\n\n${notes.join('\n')}`

      const count = mode === 'content' ? Math.min(matchedLines, headLimit) : matchedFiles.length
      log.debug('搜索内容', {
        pattern: p.pattern,
        root,
        mode,
        count,
        durationMs: Date.now() - start
      })
      return {
        content: [{ type: 'text', text }],
        details: { pattern: p.pattern, path: root, mode, count }
      }
    }
  }
}

/** 搜索单个文件：返回行内容与命中行索引。跳过（二进制/过大/读取失败）返回 null。 */
async function searchFile(file: string, regex: RegExp): Promise<FileHit | null> {
  const st = await stat(file).catch(() => undefined)
  if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) return null
  let buf: Buffer
  try {
    buf = await readFile(file)
  } catch {
    return null
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
  const lines = buf.toString('utf-8').split('\n')
  const matchedIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) matchedIndices.push(i)
  }
  if (matchedIndices.length === 0) return null
  return { lines, matchedIndices }
}

/**
 * content 模式输出：匹配行 `path:行号: 内容`，上下文行 `path-行号- 内容`。
 * 相邻/重叠的上下文区间合并为一组，组间以 `--` 分隔（对齐 grep -C 输出习惯）。
 */
function emitContent(out: string[], file: string, hit: FileHit, context: number): void {
  const ranges: [number, number][] = []
  for (const idx of hit.matchedIndices) {
    const from = Math.max(0, idx - context)
    const to = idx + context
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }
  const matchedSet = new Set(hit.matchedIndices)
  for (const [r, range] of ranges.entries()) {
    if (r > 0) out.push('--')
    for (let i = range[0]; i <= Math.min(range[1], hit.lines.length - 1); i++) {
      const line =
        hit.lines[i].length > MAX_LINE_CHARS
          ? hit.lines[i].slice(0, MAX_LINE_CHARS) + '…'
          : hit.lines[i]
      out.push(matchedSet.has(i) ? `${file}:${i + 1}: ${line}` : `${file}-${i + 1}- ${line}`)
    }
  }
}
