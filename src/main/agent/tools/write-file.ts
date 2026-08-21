import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:write_file')

/** 单次写入内容大小上限（字节），超限拒绝（避免误把大段文本/二进制当文件内容写入）。 */
const MAX_WRITE_BYTES = 1024 * 1024

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"修复拼写错误"）。请务必填写。'
    })
  ),
  path: Type.String({ description: '要写入的文件的绝对路径' }),
  content: Type.String({ description: '文件内容（UTF-8 文本）' })
})

/**
 * 写文件工具：覆盖已存在文件，不存在则创建（含父目录）。
 * 危险操作（DANGEROUS_TOOLS），执行前需用户确认（聊天流工具卡片「等待确认」）。
 * 保护：目标已存在时必须先 read_file（防盲写覆盖，对齐 Claude Code Write 语义）；
 * 内容超过 1MB 上限直接拒绝。
 */
export const writeFileTool: AgentTool<typeof params, { path: string; bytes: number }> = {
  name: 'write_file',
  label: '写入文件',
  description:
    '将内容写入指定路径的文件。若文件已存在则覆盖，不存在则创建（含父目录）。注意：覆盖已存在文件前必须先 read_file 查看内容。适合创建新文件/整文件重写；小改动请优先用 edit_file。',
  parameters: params,
  executionMode: 'sequential',
  async execute(_toolCallId, p) {
    const bytes = Buffer.byteLength(p.content, 'utf-8')
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error(
        `写入内容过大（${bytes} 字节，上限 ${MAX_WRITE_BYTES} 字节 ≈ 1MB）。请用 edit_file 分段编辑或拆分文件。`
      )
    }
    const exists = await stat(p.path).then(
      () => true,
      () => false
    )
    if (exists) {
      throw new Error(
        `文件已存在：${p.path}。为防止盲写覆盖，请先调用 read_file 查看当前内容并确认，再重试写入；小改动也可直接用 edit_file。`
      )
    }
    await mkdir(dirname(p.path), { recursive: true })
    await writeFile(p.path, p.content, 'utf-8')
    log.info('写入文件', { path: p.path, chars: p.content.length, bytes })
    return {
      content: [{ type: 'text', text: `已写入 ${p.path}（${p.content.length} 字符）` }],
      details: { path: p.path, bytes }
    }
  }
}
