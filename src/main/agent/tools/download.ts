import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveAgentWorkdir } from '../workdir'
import { bashSessionManager, formatBytes } from './bash-session'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:download')

/** 前台阻塞模式整体超时上限，默认 10 分钟（超大文件可用 timeout_ms 调大；慢速网络建议 background=true）。 */
const DEFAULT_TIMEOUT_MS = 600_000

const downloadParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"下载 Node.js 安装包"）。请务必填写。'
    })
  ),
  url: Type.String({ description: '要下载的文件 http/https URL（自动跟随重定向）。' }),
  path: Type.Optional(
    Type.String({
      description:
        '保存路径（绝对路径，含文件名）；省略则保存到工作目录，文件名取 URL 末段。文件已存在会被覆盖。'
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: '前台阻塞模式整体超时毫秒数，默认 600000（10 分钟）。大文件或慢速网络建议改用 background=true 后台下载。'
    })
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'true=后台下载并立即返回 download_id（适合大文件/慢速网络，避免占用 agent 回合）：用 bash_output 读进度（建议传 wait_ms 等待）、kill_shell 终止；false=阻塞等待下载完成（默认）'
    })
  )
})

export interface DownloadDetails {
  url: string
  /** 最终保存路径（绝对路径）；仅进度快照时缺省。 */
  path?: string
  bytes: number
  durationMs: number
  /** 下载进度快照（流式推送用）：已下载 / 总字节（Content-Length 未知时 total=0）。 */
  progress?: { downloaded: number; total: number }
  /** agent 中止（用户停止 / 会话切换）：文件不完整。 */
  aborted?: boolean
  /** 后台模式：true 时返回的是 download_id 而非文件终态。 */
  background?: boolean
  /** 后台模式返回的任务 id（bash_output / kill_shell 用）。 */
  sessionId?: string
}

/**
 * 文件下载工具：从 URL 流式下载到本地磁盘。
 * - 流式写盘 + 真实字节进度（前台模式经 onUpdate 按 200ms 节流推送，renderer 渲染确定时长进度条；
 *   Content-Length 缺失时退化为「已下载大小」文字 + 不确定光带）；
 * - 前台模式一次调用拿终态（文件路径 + 大小）；background=true 时转后台任务（与 bash 后台会话同注册表），
 *   立即返回 download_id，agent 可继续其它工作，用 bash_output 读进度 / kill_shell 终止；
 * - 网络读 + 磁盘写，非破坏性操作，无需权限确认。
 */
export const downloadTool: AgentTool<typeof downloadParams, DownloadDetails> = {
  name: 'download',
  label: '下载文件',
  description:
    '从 URL 下载文件到本地磁盘（流式写入，带真实下载进度与速度提示）。用于下载安装包、数据集、模型文件、素材等二进制文件；大文件或网络慢时用 background=true 后台下载（立即返回 download_id，agent 可继续其它工作，用 bash_output 查进度、kill_shell 终止）；阅读网页/文档内容请用 web_fetch。',
  parameters: downloadParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p, signal, onUpdate) {
    const start = Date.now()
    let url: URL
    try {
      url = new URL(p.url)
    } catch {
      throw new Error(`URL 无效：${p.url}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 协议，收到：${url.protocol}`)
    }

    // 目标路径：显式 path > 工作目录 + URL 文件名（仅取 basename，防路径穿越）
    const fallbackName = basename(url.pathname) || 'download.bin'
    const dest = p.path ?? join(resolveAgentWorkdir(), fallbackName)
    await mkdir(dirname(dest), { recursive: true })

    // 后台模式：注册后台下载任务，立即返回 download_id，agent 可继续其它工作
    if (p.background) {
      const task = bashSessionManager.startDownload(p.url, dest)
      log.info('后台下载已启动', {
        dlId: task.sessionId,
        url: p.url.slice(0, 200),
        dest
      })
      return {
        content: [
          {
            type: 'text',
            text: `已启动后台下载。download_id: ${task.sessionId}\n可用 bash_output 读取进度（建议传 wait_ms 等待，避免轮询）；kill_shell 可终止。`
          }
        ],
        details: {
          url: p.url,
          path: dest,
          bytes: 0,
          durationMs: 0,
          background: true,
          sessionId: task.sessionId
        }
      }
    }

    // 前台模式：任务同样注册到后台面板（可随时在面板查看/终止），阻塞等待终态
    const task = bashSessionManager.startDownload(p.url, dest, {
      onProgress: ({ text, bytes, total, durationMs }) => {
        onUpdate?.({
          content: [{ type: 'text', text }],
          details: {
            url: p.url,
            bytes,
            durationMs,
            progress: { downloaded: bytes, total: total ?? 0 }
          }
        })
      }
    })
    const timeoutMs = p.timeout_ms && p.timeout_ms > 0 ? p.timeout_ms : DEFAULT_TIMEOUT_MS
    const finished = await task.waitExit(timeoutMs, signal)
    if (!finished && !signal?.aborted) {
      // 超时：终止任务并报错（文件不完整）
      task.kill()
      throw new Error(
        `下载超时（超过 ${Math.round(timeoutMs / 1000)}s）：已下载 ${formatBytes(task.downloadedBytes)} 至 ${dest}，文件不完整，可删除后重试或改用 background=true 后台下载`
      )
    }
    if (signal?.aborted) {
      task.kill()
      log.info('下载已中止', {
        url: p.url,
        path: dest,
        bytes: task.downloadedBytes,
        durationMs: Date.now() - start,
        aborted: true
      })
      return {
        content: [
          { type: 'text', text: `[已中止] 已下载 ${formatBytes(task.downloadedBytes)} 至 ${dest}（文件不完整）` }
        ],
        details: {
          url: p.url,
          path: dest,
          bytes: task.downloadedBytes,
          durationMs: Date.now() - start,
          aborted: true
        }
      }
    }
    if (task.errorMessage) {
      throw new Error(
        `下载中断：${task.errorMessage}（已下载 ${formatBytes(task.downloadedBytes)} 至 ${dest}，文件不完整，可删除后重试）`
      )
    }
    log.info('下载完成', {
      url: p.url,
      path: dest,
      bytes: task.downloadedBytes,
      durationMs: Date.now() - task.startedAt
    })
    const pct = task.totalBytes
      ? `，${Math.round((task.downloadedBytes / task.totalBytes) * 100)}%`
      : ''
    return {
      content: [{ type: 'text', text: `下载完成：${dest}（${formatBytes(task.downloadedBytes)}${pct}）` }],
      details: {
        url: p.url,
        path: dest,
        bytes: task.downloadedBytes,
        durationMs: Date.now() - task.startedAt
      }
    }
  }
}
