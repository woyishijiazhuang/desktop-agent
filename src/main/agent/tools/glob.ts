import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { resolveAgentWorkdir } from '../workdir'
import { createGlobMatcher, toPosix, walkFiles } from './fs-walk'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:glob')

/** 单次返回的匹配文件数上限，超出截断并提示（防大目录输出爆炸）。 */
const MAX_RESULTS = 500
/** 遍历文件数安全上限：防止在用户主目录等超大范围下遍历失控。 */
const MAX_SCAN = 100_000

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"查找全部测试文件"）。请务必填写。'
    })
  ),
  pattern: Type.String({
    description:
      'glob 模式，如 "**/*.tsx"、"src/**/*.test.ts"、"*.{ts,js}"。不含 / 的模式（如 "*.ts"）按任意深度的文件名匹配；通配符不匹配以 . 开头的隐藏文件（除非显式写 .）。'
  }),
  path: Type.Optional(Type.String({ description: '搜索的起始目录绝对路径，默认为工作目录' }))
})

export const globTool: AgentTool<typeof params, { pattern: string; path: string; count: number }> =
  {
    name: 'glob',
    label: '匹配文件',
    description:
      '按 glob 模式查找文件，返回匹配的文件路径（按修改时间从新到旧排序）。用于按名称/扩展名定位文件（如"所有 .tsx 组件""所有测试文件"），代替 bash 中的 find/ls。自动跳过 node_modules、.git、dist 等目录。',
    parameters: params,
    executionMode: 'parallel',
    async execute(_toolCallId, p) {
      const start = Date.now()
      const root = p.path ?? resolveAgentWorkdir()
      const { files, truncated: scanTruncated } = await walkFiles(root, MAX_SCAN)
      const matcher = createGlobMatcher(p.pattern)

      const matches: string[] = []
      let scanHitCap = false
      for (const file of files) {
        if (matches.length >= MAX_RESULTS) {
          scanHitCap = true
          break
        }
        if (matcher(toPosix(relative(root, file)))) matches.push(file)
      }

      // 按修改时间排序（新→旧），便于优先关注最近改动的文件
      const withMtime = await Promise.all(
        matches.map(async (f) => ({ f, m: (await stat(f).catch(() => undefined))?.mtimeMs ?? 0 }))
      )
      withMtime.sort((a, b) => b.m - a.m)
      const sorted = withMtime.map((x) => x.f)

      let text = sorted.join('\n')
      if (sorted.length === 0) text = '(无匹配文件)'
      const notes: string[] = []
      if (scanHitCap)
        notes.push(`[匹配数超过 ${MAX_RESULTS}，仅显示前 ${MAX_RESULTS} 个，建议缩小模式范围]`)
      if (scanTruncated) notes.push(`[目录过大，仅扫描了前 ${MAX_SCAN} 个文件]`)
      if (notes.length > 0) text += `\n\n${notes.join('\n')}`

      log.debug('匹配文件', {
        pattern: p.pattern,
        root,
        count: sorted.length,
        truncated: scanHitCap || scanTruncated,
        durationMs: Date.now() - start
      })
      return {
        content: [{ type: 'text', text }],
        details: { pattern: p.pattern, path: root, count: sorted.length }
      }
    }
  }
