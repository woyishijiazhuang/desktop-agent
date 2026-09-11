/**
 * 从消息 content（string 或 block 数组）提取纯文本：拼接全部 text block。
 * 供标题生成 / 压缩摘要 / 会话导出 / 文本补全 / 子代理进度等 main 与 renderer 两侧场景复用，
 * 避免各处重复实现。
 *
 * @param separator 多段 text block 之间的连接符，默认空串。
 */
export function extractMessageText(content: unknown, separator = ''): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(separator)
    .trim()
}
