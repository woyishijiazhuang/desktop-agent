import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../database'
import { SETTING_AGENT_MD_INJECTION_CHARS } from './types'

/** agent.md 注入系统提示词的上限默认值（字符）：常驻上下文摘要，超限截断提示按需 read_file。 */
export const DEFAULT_AGENT_MD_MAX_CHARS = 8192

/** 截断时追加的引导（告知 Agent 完整内容按需读取，避免信息缺失）。 */
const TRUNCATED_NOTICE = '\n\n[agent.md 内容已超出注入上限，如需完整内容请用 read_file 读取该文件]'

/**
 * 读取 {workdir}/agent.md 并按注入上限截断（供系统提示词注入）。
 * 注入上限 ≠ 文件大小上限：agent.md 本身可以很大，注入的只是常驻摘要；
 * 完整内容由 Agent 按需 read_file（上限可通过设置 agent.agentMdInjectionChars 调整）。
 * 文件不存在 / 为空返回 null。
 */
export function readAgentMdForInjection(workdir: string): string | null {
  const text = readAgentMdRaw(workdir)
  if (!text) return null
  const max =
    (db.getSetting<number>(SETTING_AGENT_MD_INJECTION_CHARS) as number | undefined) ??
    DEFAULT_AGENT_MD_MAX_CHARS
  if (text.length <= max) return text
  return text.slice(0, max) + TRUNCATED_NOTICE
}

/** 读取 {workdir}/agent.md 完整内容（工作区管理编辑器用，不截断）；不存在返回 null。 */
export function readAgentMdRaw(workdir: string): string | null {
  try {
    const text = readFileSync(join(workdir, 'agent.md'), 'utf-8').trim()
    return text || null
  } catch {
    return null
  }
}

/** 写入 {workdir}/agent.md（工作区管理编辑器保存；目录不存在时自动创建）。 */
export function writeAgentMd(workdir: string, content: string): void {
  mkdirSync(workdir, { recursive: true })
  writeFileSync(join(workdir, 'agent.md'), content, 'utf-8')
}
