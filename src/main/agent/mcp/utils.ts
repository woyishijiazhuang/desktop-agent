import type { TextContent, ImageContent } from '@earendil-works/pi-ai'

/** 带超时的 Promise（超时只判定失败，不取消底层操作）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 工具名前缀：server 名净化后 + 下划线，避免多 server 工具名冲突。 */
export function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 24)
  return cleaned || 'mcp'
}

/** MCP callTool 结果 → pi-ai content blocks。 */
export function mcpResultToContent(content: unknown): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = []
  if (Array.isArray(content)) {
    for (const item of content as Record<string, unknown>[]) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        out.push({ type: 'text', text: item.text })
      } else if (item?.type === 'image' && typeof item.data === 'string') {
        out.push({
          type: 'image',
          data: item.data,
          mimeType: (item.mimeType as string) ?? 'image/png'
        })
      } else if (item?.type === 'resource') {
        out.push({ type: 'text', text: JSON.stringify(item.resource ?? null) })
      }
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '（工具无输出）' })
  return out
}
