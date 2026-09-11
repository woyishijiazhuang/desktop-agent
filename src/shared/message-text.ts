/**
 * 从消息 content（string 或 block 数组）提取纯文本：拼接全部 text block。
 * 供标题生成 / 压缩摘要 / 会话导出 / 文本补全等场景复用，避免各处重复实现。
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
}
