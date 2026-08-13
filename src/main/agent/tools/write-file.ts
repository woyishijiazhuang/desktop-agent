import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:write_file')

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
 */
export const writeFileTool: AgentTool<typeof params, { path: string; bytes: number }> = {
  name: 'write_file',
  label: '写入文件',
  description: '将内容写入指定路径的文件。若文件已存在则覆盖，不存在则创建（含父目录）。',
  parameters: params,
  executionMode: 'sequential',
  async execute(_toolCallId, p) {
    await mkdir(dirname(p.path), { recursive: true })
    await writeFile(p.path, p.content, 'utf-8')
    const bytes = Buffer.byteLength(p.content, 'utf-8')
    log.info('写入文件', { path: p.path, chars: p.content.length, bytes })
    return {
      content: [{ type: 'text', text: `已写入 ${p.path}（${p.content.length} 字符）` }],
      details: { path: p.path, bytes }
    }
  }
}
