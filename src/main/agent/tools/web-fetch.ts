import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { extractDocumentText } from '../../utils/doc-parser'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:web_fetch')

/** 请求超时（含下载阶段，AbortSignal.timeout 覆盖整个 fetch）。 */
const TIMEOUT_MS = 15_000
/** 响应体大小上限：超过则拒绝（Content-Length 预检 + 实际字节数双保险）。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024
/** 注入上下文的正文最大字符数，超出截断。 */
const MAX_OUTPUT_CHARS = 50_000

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"查阅官方安装文档"）。请务必填写。'
    })
  ),
  url: Type.String({ description: '要抓取的 http/https URL（自动跟随重定向）。' })
})

export interface WebFetchDetails {
  url: string
  status: number
  contentType: string
  bytes: number
}

/**
 * URL 抓取工具：获取网页/接口内容并转为可读文本。
 * - HTML 自动剥离标签转为近似 Markdown 的文本（保留标题/列表/链接结构）；
 * - JSON / XML / 纯文本原样返回；PDF 复用 mdize 解析为 Markdown；
 * - 其余二进制类型（图片/压缩包等）返回类型与大小提示。
 * 只读 GET 请求，可并行执行。
 */
export const webFetchTool: AgentTool<typeof params, WebFetchDetails> = {
  name: 'web_fetch',
  label: '抓取网页',
  description:
    '抓取指定 URL 的内容并转为文本：HTML 网页自动转为可读文本（保留标题/列表/链接），JSON/XML/纯文本原样返回，PDF 解析为 Markdown。用于阅读 web_search 搜到的网页、官方文档、API 文档等。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const start = Date.now()
    let url: URL
    try {
      url = new URL(p.url)
    } catch {
      throw new Error(`URL 无效：${p.url}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 协议，收到：${url.protocol}`)
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) desktop-agent' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }).catch((err: Error) => {
      if (err.name === 'TimeoutError')
        throw new Error(`请求超时（${TIMEOUT_MS / 1000}s）：${p.url}`)
      throw new Error(`请求失败：${err.message}`)
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}：${p.url}`)
    }

    // Content-Length 预检（chunked 响应无此头，靠下载后字节数兜底）
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY_BYTES) {
      throw new Error(`响应体过大（${Math.round(declared / 1024 / 1024)}MB，上限 10MB）：${p.url}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new Error(
        `响应体过大（${Math.round(buf.byteLength / 1024 / 1024)}MB，上限 10MB）：${p.url}`
      )
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8'
    const decoded = (): string => {
      try {
        return new TextDecoder(charset).decode(buf)
      } catch {
        return buf.toString('utf-8')
      }
    }

    let text: string
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      text = htmlToText(decoded())
    } else if (contentType === 'application/pdf') {
      text = await extractDocumentText(buf, 'page.pdf')
    } else if (
      contentType.startsWith('text/') ||
      contentType === 'application/json' ||
      contentType === 'application/xml' ||
      contentType === ''
    ) {
      text = decoded()
    } else {
      // 二进制类型：无法注入上下文，返回类型与大小提示
      text = `(不支持的内容类型 ${contentType || '未知'}，响应 ${Math.round(buf.byteLength / 1024)}KB。仅支持 HTML / 纯文本 / JSON / XML / PDF)`
    }

    const truncated = text.length > MAX_OUTPUT_CHARS
    if (truncated)
      text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[内容过长，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`

    log.info('抓取网页', {
      url: p.url,
      status: res.status,
      contentType,
      bytes: buf.byteLength,
      outputChars: text.length,
      truncated,
      durationMs: Date.now() - start
    })
    return {
      content: [{ type: 'text', text }],
      details: { url: p.url, status: res.status, contentType, bytes: buf.byteLength }
    }
  }
}

/** 常用 HTML 命名实体（数字实体在 decodeEntities 单独处理）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷'
}

/**
 * HTML 转可读文本（近似 Markdown）：
 * 去除脚本/样式/注释等噪声，保留标题层级、列表、链接与代码块结构。
 * 纯正则实现足够覆盖文档页/文章页的正文提取，不追求渲染级还原。
 */
function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
  let s = html
  // 噪声块整体移除（script/style/noscript/svg/iframe/head）
  s = s.replace(/<(script|style|noscript|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // 标题 → Markdown 标题
  for (let i = 1; i <= 6; i++) {
    s = s.replace(new RegExp(`<h${i}[^>]*>`, 'gi'), `\n\n${'#'.repeat(i)} `)
  }
  // 列表 / 换行类标签
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(
    /<\/(p|div|section|article|li|tr|table|blockquote|pre|h[1-6]|ul|ol|dl|dt|dd)>/gi,
    '\n\n'
  )
  // 链接保留文字与目标： <a href="x">text</a> → [text](x)
  s = s.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim()
      return label && href && !href.startsWith('javascript:') ? `[${label}](${href})` : label
    }
  )
  // 图片直接丢弃（对文本上下文无意义）；其余标签全部剥离
  s = s.replace(/<img\b[^>]*>/gi, '')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  // 归一化空白：行内多空格合一，3+ 连续空行压成 2
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return title ? `# ${decodeEntities(title)}\n\n${s}` : s
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16))
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(parseInt(body.slice(1), 10))
    }
    return NAMED_ENTITIES[body] ?? m
  })
}
