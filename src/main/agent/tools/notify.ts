import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { notifyAgentFinished } from '../../utils/notifier'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:notify')

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次通知的目的，例如"用户要求下载完成后通知"。请务必填写。'
    })
  ),
  title: Type.Optional(Type.String({ description: '通知标题，默认「Agent 通知」。' })),
  body: Type.String({
    description: '通知正文：简明说明发生了什么，不超过 100 字。'
  }),
  file: Type.Optional(
    Type.String({
      description:
        '点击通知时要打开的文件或目录路径（如刚生成的 PDF/Word/脚本，或下载输出目录）。点击后系统会用默认程序打开该文件/目录。'
    })
  )
})

/**
 * 桌面通知工具：向用户发送一条系统通知。
 * 仅当用户明确要求「完成后通知我 / 提醒我」等场景时使用（如长任务结束时告知结果），
 * 不要随意打扰用户。传了 file 时点击通知用系统默认程序打开该文件/目录，否则聚焦应用窗口。
 */
export const notifyTool: AgentTool<typeof params, { title: string; body: string; file?: string }> =
  {
    name: 'notify',
    label: '桌面通知',
    description:
      '向用户发送一条系统桌面通知（如长任务完成后提醒）。仅在用户明确要求「完成后通知我 / 提醒我」时使用，不要把常规进展都通知给用户。若用户要求打开某个成果文件/目录（刚生成的 PDF、Word、脚本或下载目录），用 file 参数传其路径，用户点击通知即可打开。',
    parameters: params,
    executionMode: 'sequential',
    async execute(_toolCallId, p) {
      const title = p.title?.trim() || 'Agent 通知'
      const body = p.body.trim()
      const file = p.file?.trim() || undefined
      log.info('发送桌面通知', { title, body: body.slice(0, 100), file })
      const result = await notifyAgentFinished({ title, body, openPath: file })
      if (result.success) {
        return {
          content: [
            {
              type: 'text',
              text: file
                ? `已发送桌面通知：${title}（点击通知将打开 ${file}）`
                : `已发送桌面通知：${title}`
            }
          ],
          details: { title, body, file }
        }
      }
      // 通知发送失败：把错误信息反馈给 agent，让它知道并可以告知用户
      return {
        content: [
          {
            type: 'text',
            text: `桌面通知发送失败：${result.error}。用户可能未授予通知权限或应用未签名，已提示用户在应用内查看。`
          }
        ],
        details: { title, body, file, error: result.error }
      }
    }
  }
