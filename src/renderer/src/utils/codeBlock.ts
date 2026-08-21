/**
 * 代码展示工具：把工具结果/参数文本包装成 markdown 围栏字符串，
 * 交给 markstream-vue（MarkdownRender）统一渲染，替代 naive-ui NCode + highlight.js。
 */

/**
 * 尝试把文本解析为 JSON；成功则返回 pretty-print 后的字符串（缩进 2）。
 * 工具结果常为 JSON（结构化数据 / 错误体），格式化后可读性大幅提升。
 * 解析失败（普通文本 / 命令输出）返回 null，由调用方按纯文本处理。
 */
export function tryPrettyJSON(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // 仅当首尾像 JSON 才尝试，避免对普通文本白做一次 parse
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const looksLikeJson = (first === '{' && last === '}') || (first === '[' && last === ']')
  if (!looksLikeJson) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

/**
 * 把代码内容包成 markdown 围栏（fence），交给 MarkdownRender 渲染为代码块。
 * fence 长度自适应：内容里含 ``` 时升级为更长的反引号串，避免围栏提前闭合。
 * 语言为 null（纯文本）时围栏不带语言标注，配合 code-renderer="pre" 轻量渲染。
 */
export function toCodeFence(text: string, language: string | null = null): string {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  // 去掉内容尾部换行，避免与收尾围栏之间产生多余空行
  const body = text.replace(/\n+$/, '')
  return `${fence}${language ?? ''}\n${body}\n${fence}`
}
