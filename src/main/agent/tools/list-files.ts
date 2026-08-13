import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:list_files')

/** 递归列出的最大深度（仅 recursive 时生效）：0=仅当前目录，1=含一层子目录，依此类推。 */
const DEFAULT_MAX_DEPTH = 3
/** 单次调用返回条目数上限，超出截断并提示，防止大目录（如 node_modules）输出爆炸。 */
const MAX_ENTRIES = 5000

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"查看 src 目录结构"）。请务必填写。'
    })
  ),
  dir: Type.String({ description: '要列出的目录绝对路径' }),
  recursive: Type.Optional(Type.Boolean({ description: '是否递归列出子目录，默认 false' })),
  max_depth: Type.Optional(
    Type.Number({
      description:
        '递归最大深度：0=仅当前目录，1=含一层子目录，依此类推。仅 recursive=true 时生效，默认 3。'
    })
  )
})

export const listFilesTool: AgentTool<typeof params, { dir: string; count: number }> = {
  name: 'list_files',
  label: '列出文件',
  description: '列出指定目录下的文件和子目录，支持递归（默认最多 3 层，超出条数自动截断）。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const start = Date.now()
    const recursive = p.recursive ?? false
    const maxDepth = p.max_depth ?? DEFAULT_MAX_DEPTH
    const { lines, truncated } = await listDir(p.dir, recursive, maxDepth, 0)
    let text = lines.join('\n')
    if (lines.length === 0) text = '(空目录)'
    if (truncated) {
      text += `\n\n[条目过多，仅显示前 ${MAX_ENTRIES} 条。建议缩小目录范围，或对深层子目录单独列出]`
    }
    log.debug('列出目录', {
      dir: p.dir,
      recursive,
      maxDepth,
      count: lines.length,
      truncated,
      durationMs: Date.now() - start
    })
    return {
      content: [{ type: 'text', text }],
      details: { dir: p.dir, count: lines.length }
    }
  }
}

/**
 * 递归列出目录下全部条目（含深度限制与条目上限）。
 * depth 超限的目录不再进入，从根上防止大目录递归爆炸。
 */
async function listDir(
  dir: string,
  recursive: boolean,
  maxDepth: number,
  depth: number
): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (lines.length >= MAX_ENTRIES) return { lines, truncated: true }
    const full = join(dir, e.name)
    lines.push(full)
    if (recursive && e.isDirectory() && depth < maxDepth) {
      const sub = await listDir(full, true, maxDepth, depth + 1)
      lines.push(...sub.lines)
      if (sub.truncated) return { lines, truncated: true }
    }
  }
  return { lines, truncated: false }
}
