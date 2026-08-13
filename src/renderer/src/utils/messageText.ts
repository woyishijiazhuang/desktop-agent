/**
 * 文件内容块：携带来源文件名的文本块（文件内容独立成块，模型侧仍按 text 消费，
 * UI 据此渲染为「文件卡片」而非混入用户正文）。
 */
export interface FileTextBlock {
  type: 'text'
  text: string
  file_name: string
}

/** 判断某 block 是否为文件内容块（text + file_name）。 */
export function isFileBlock(b: unknown): b is FileTextBlock {
  return (
    !!b &&
    typeof b === 'object' &&
    (b as { type?: string }).type === 'text' &&
    typeof (b as { file_name?: unknown }).file_name === 'string'
  )
}

/**
 * 技能内容块：携带技能 id 的文本块（技能 SKILL.md 全文注入模型，UI 据此渲染为「技能卡片」）。
 * text 在 main 侧落库时填充全文；renderer 乐观显示时为空，渲染只取 skill_name。
 */
export interface SkillTextBlock {
  type: 'text'
  text: string
  skill_name: string
}

/** 判断某 block 是否为技能内容块（text + skill_name）。 */
export function isSkillBlock(b: unknown): b is SkillTextBlock {
  return (
    !!b &&
    typeof b === 'object' &&
    (b as { type?: string }).type === 'text' &&
    typeof (b as { skill_name?: unknown }).skill_name === 'string'
  )
}

/**
 * 从消息 content 提取用户自己输入的文本：排除文件内容块（file_name）与技能内容块（skill_name）。
 * 用于用户气泡展示 / 失败消息回收回填等场景——文件内容与技能全文不应回到正文。
 */
export function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === 'text' && !isFileBlock(b) && !isSkillBlock(b))
    .map((b) => b.text ?? '')
    .join('')
    .trim()
}

/**
 * 从消息 content（string 或 block 数组）提取纯文本：拼接全部 text block。
 * 供消息气泡展示 / 复制 / 工具结果摘要 / 失败消息回填等场景复用，避免各处重复实现。
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
