// ==================== FTS5 索引 / 查询转换（2-gram） ====================
// 消息全文搜索与记忆搜索共用同一套分词/查询转换，保证索引侧与查询侧一致。

/**
 * 将可搜索文本拆分为 FTS5 索引 token：
 * - 连续 CJK 段 → 2-gram（长度 1 时保留单字），使中文子串可检索（如「人工智能」→「人工 工智 智能」）
 * - 非 CJK 段 → 按非单词字符切词（英文/数字原样保留，unicode61 会统一小写）
 * 中英混排各自独立切分，互不干扰。
 */
export function bigramTokens(text: string): string[] {
  const tokens: string[] = []
  for (const seg of text.split(/([\u4e00-\u9fff]+)/)) {
    if (!seg) continue
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      if (seg.length === 1) {
        tokens.push(seg)
      } else {
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
      }
    } else {
      for (const w of seg.split(/\W+/)) {
        if (w) tokens.push(w)
      }
    }
  }
  return tokens
}

/**
 * 从消息 content（block 数组或字符串）提取可搜索纯文本：
 * text 正文 / thinking 思考过程 / toolCall 的工具名与参数。递归处理嵌套 content。
 */
export function extractSearchableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (!block || typeof block !== 'object') return ''
        const {
          type,
          text,
          thinking,
          name,
          args,
          content: inner
        } = block as Record<string, unknown>
        if (type === 'toolCall') {
          const parts: string[] = []
          if (typeof name === 'string') parts.push(name)
          if (args !== undefined) parts.push(JSON.stringify(args))
          return parts.join(' ')
        }
        const parts: string[] = []
        if (typeof text === 'string') parts.push(text)
        if (typeof thinking === 'string') parts.push(thinking)
        if (inner !== undefined) {
          const nested = extractSearchableText(inner)
          if (nested) parts.push(nested)
        }
        return parts.join(' ')
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') return JSON.stringify(content)
  return ''
}

/** 文本落库时的索引文本：2-gram 化后以空格拼接（FTS5 token 分隔）。 */
export function toFtsIndexText(text: string): string {
  return bigramTokens(text).join(' ')
}

/**
 * 用户查询 → FTS5 MATCH 表达式：与索引侧一致的 2-gram token，
 * 每个 token 加引号作短语精确匹配，token 间空格 = AND（须同时出现）。
 * 无有效 token（纯标点/空白）返回空串，调用方直接视为无命中。
 */
export function toFtsMatchQuery(query: string): string {
  const tokens = bigramTokens(query.toLowerCase())
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"`).join(' ')
}

/**
 * 宽松查询：任一 2-gram 命中即可（OR）。
 * 用于 AND 预筛无命中时的降级检索——长查询切出的 bigram 越多，越容易因单个
 * bigram（如「会话压缩设计」的「缩设」）在文档中不存在而整体失配。
 */
export function toFtsOrQuery(query: string): string {
  const tokens = bigramTokens(query.toLowerCase())
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

/** 截取匹配位置附近的文本片段（前后各约 40 字符），超界用省略号，压缩空白为单空格。 */
export function makeSnippet(text: string, matchIndex: number, matchLength: number): string {
  const RADIUS = 40
  const start = Math.max(0, matchIndex - RADIUS)
  const end = Math.min(text.length, matchIndex + matchLength + RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix
}
