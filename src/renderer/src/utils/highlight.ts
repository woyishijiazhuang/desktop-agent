/**
 * 语法高亮基建：基于 highlight.js 按需注册常用语言，供 Naive UI 的 NCode 经 :hljs 注入。
 *
 * 用 highlight.js/lib/core 而非全量包，仅注册实际需要的语言，避免打包冗余。
 * 注册一次后导出单例 hljs，工具参数（恒为 JSON）与工具结果（按内容识别）共用。
 */
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'

hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdown)

export default hljs

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
