import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { extractMessageText } from './messageText'

/**
 * 工具结果摘要（ToolCallCard / 孤儿结果卡共用）。
 * 卡片收起时在头部展示一行「结果摘要」，让用户无需展开即可了解工具干了什么。
 */

export interface ToolResultSummary {
  /** 摘要文本（一行） */
  text: string
  /** 语气：成功 / 失败（决定着色） */
  tone: 'success' | 'error'
}

const KB = 1024

function fmtBytes(n: number): string {
  if (n >= KB * KB) return `${(n / (KB * KB)).toFixed(1)} MB`
  if (n >= KB) return `${Math.round(n / KB)} KB`
  return `${n} B`
}

function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ''
  )
}

function countLines(s: string): number {
  return s ? s.split('\n').length : 0
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/**
 * 生成工具结果的一行摘要。
 * 优先用各内置工具 details 的结构化信息（退出码 / 字节 / 条数），
 * 失败时展示错误信息首行；未知工具兜底为「体积 · 行数」。
 */
export function summarizeToolResult(
  result: Pick<ToolResultMessage, 'toolName' | 'isError' | 'details' | 'content'>
): ToolResultSummary {
  const text = extractMessageText(result.content)
  if (result.isError) {
    const first = firstLine(text) || '工具执行失败'
    return { text: `失败：${truncate(first, 80)}`, tone: 'error' }
  }
  const details = (result.details ?? {}) as Record<string, unknown>
  let s: string | null = null
  switch (result.toolName) {
    case 'bash': {
      const code = details.exitCode as number | undefined
      const dur = details.durationMs as number | undefined
      const parts: string[] = []
      if (typeof code === 'number') parts.push(`退出码 ${code}`)
      if (typeof dur === 'number') parts.push(fmtDuration(dur))
      if (details.truncated) parts.push('输出已截断')
      s = parts.length > 0 ? parts.join(' · ') : null
      break
    }
    case 'read_file': {
      const path = details.path as string | undefined
      const bytes = details.bytes as number | undefined
      s = path
        ? `已读取 ${basename(path)}${typeof bytes === 'number' ? `（${fmtBytes(bytes)}）` : ''}`
        : null
      break
    }
    case 'write_file': {
      const path = details.path as string | undefined
      const bytes = details.bytes as number | undefined
      s = path
        ? `已写入 ${basename(path)}${typeof bytes === 'number' ? `（${fmtBytes(bytes)}）` : ''}`
        : null
      break
    }
    case 'list_files': {
      const count = details.count as number | undefined
      s = typeof count === 'number' ? `列出 ${count} 项` : null
      break
    }
    case 'web_search': {
      const count = details.count as number | undefined
      const query = details.query as string | undefined
      s = typeof count === 'number' ? `找到 ${count} 条结果${query ? `（"${query}"）` : ''}` : null
      break
    }
  }
  if (s) return { text: s, tone: 'success' }
  // 兜底：体积 + 行数
  if (text) return { text: `${fmtBytes(text.length)} · ${countLines(text)} 行`, tone: 'success' }
  return { text: '已完成（无输出）', tone: 'success' }
}

/**
 * 从 toolCall 参数推导一行「意图」摘要（AI 未填 reason 参数时的兜底），
 * 用于卡片收起时的浏览：读取 x.ts / 执行 npm test / 搜索 "..."。
 */
export function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  const arg = (k: string): string => {
    const v = args?.[k]
    return typeof v === 'string' && v.trim() ? v.trim() : ''
  }
  switch (name) {
    case 'bash': {
      const cmd = arg('command')
      return cmd ? `执行 ${truncate(cmd.replace(/\s+/g, ' '), 40)}` : ''
    }
    case 'read_file':
      return arg('path') ? `读取 ${basename(arg('path'))}` : ''
    case 'write_file':
      return arg('path') ? `写入 ${basename(arg('path'))}` : ''
    case 'list_files':
      return arg('dir') ? `列出 ${arg('dir')} 目录` : ''
    case 'web_search':
      return arg('query') ? `搜索 "${truncate(arg('query'), 30)}"` : ''
    default:
      return ''
  }
}
