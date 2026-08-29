/**
 * 无 tokenizer 的粗估 token 数（CJK 1 字 ≈ 1 token，其余约 3.5 字符/token）。
 * 仅用于自动压缩阈值判断：宁高勿低，提前压缩比溢出窗口安全。
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export function tokenWeight(ch: string): number {
  return CJK_RE.test(ch) ? 1 : 1 / 3.5
}

export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) tokens += tokenWeight(ch)
  return Math.ceil(tokens)
}

/**
 * 按 token 预算把长文本截断为「头部 + 尾部」：保留开头与结尾，省略中间，
 * 避免单条超大消息 / 超大摘要直接把压缩调用或模型上下文撑爆。
 */
export function truncateMiddle(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const headTokens = Math.max(1, Math.floor(maxTokens * 0.45))
  const tailTokens = Math.max(1, maxTokens - headTokens)
  let head = ''
  let t = 0
  for (const ch of text) {
    if (t >= headTokens) break
    head += ch
    t += tokenWeight(ch)
  }
  let tail = ''
  t = 0
  for (let i = text.length - 1; i >= 0; i--) {
    if (t >= tailTokens) break
    tail = text[i] + tail
    t += tokenWeight(text[i])
  }
  return `${head}\n…[中间内容过长已省略]…\n${tail}`
}
