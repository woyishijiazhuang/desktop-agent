import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveAgentWorkdir } from '../workdir'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:download')

/** 连接建立后长时间无新数据（读不到字节）视为挂死，强制中止（防死链无限拖）。 */
const STALL_TIMEOUT_MS = 30_000
/** 整体超时上限，默认 10 分钟（超大文件可用 timeout_ms 调大）。 */
const DEFAULT_TIMEOUT_MS = 600_000
/** 进度推送节流间隔：按时间节流（200ms 一推，比 bash_output 的 1s 定时更密，进度条更顺滑）。 */
const PROGRESS_INTERVAL_MS = 200

/** 字节数 → 人类可读（进度与结果提示用）。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

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
      description: '整体超时毫秒数，默认 600000（10 分钟）。下载大文件可调大。'
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
}

/**
 * 文件下载工具：从 URL 流式下载到本地磁盘。
 * - 流式写盘 + 真实字节进度（经 onUpdate 按 200ms 节流推送，renderer 渲染确定时长进度条；
 *   Content-Length 缺失时退化为「已下载大小」文字 + 不确定光带）；
 * - 一次调用拿终态（文件路径 + 大小），agent 无需轮询 bash + 文件大小；
 * - 网络读 + 磁盘写，非破坏性操作，无需权限确认。
 */
export const downloadTool: AgentTool<typeof downloadParams, DownloadDetails> = {
  name: 'download',
  label: '下载文件',
  description:
    '从 URL 下载文件到本地磁盘（流式写入，带真实下载进度与速度提示）。用于下载安装包、数据集、模型文件、素材等二进制文件；阅读网页/文档内容请用 web_fetch。',
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

    // 信号组合：agent 中止 + 整体超时 + 挂死检测，统一走 controller 中止 fetch 流
    const controller = new AbortController()
    const onAgentAbort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', onAgentAbort, { once: true })
    const timeoutMs = p.timeout_ms && p.timeout_ms > 0 ? p.timeout_ms : DEFAULT_TIMEOUT_MS
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) desktop-agent' },
        redirect: 'follow',
        signal: controller.signal
      })
    } catch (err) {
      throw new Error(`请求失败：${(err as Error).message}`)
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}：${p.url}`)
    }
    if (!res.body) {
      throw new Error('响应无数据流（服务器未返回可下载内容）')
    }

    const declared = Number(res.headers.get('content-length') ?? NaN)
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null

    // 流式写盘 + 进度推送（EWMA 速度平滑，200ms 节流）
    const fileStream = createWriteStream(dest)
    let streamErr: Error | null = null
    fileStream.on('error', (e: Error) => {
      streamErr = e
    })
    const reader = res.body.getReader()
    let downloaded = 0
    let lastEmit = 0
    let lastChunkAt = Date.now()
    let speed = 0 // bytes/sec（指数移动平均）
    const emit = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = now
      const pct =
        totalBytes && downloaded > 0 ? `，${Math.round((downloaded / totalBytes) * 100)}%` : ''
      onUpdate?.({
        content: [
          {
            type: 'text',
            text: `下载中… ${formatBytes(downloaded)} / ${
              totalBytes ? formatBytes(totalBytes) : '未知'
            }（${formatSpeed(speed)}${pct}）`
          }
        ],
        details: {
          url: p.url,
          bytes: downloaded,
          durationMs: Date.now() - start,
          progress: { downloaded, total: totalBytes ?? 0 }
        }
      })
    }
    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > STALL_TIMEOUT_MS) controller.abort()
    }, 5_000)

    let aborted = false
    let failError: Error | null = null
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (streamErr) throw streamErr
        if (!value || value.byteLength === 0) continue
        fileStream.write(value)
        const now = Date.now()
        const inst = (value.byteLength / Math.max(1, now - lastChunkAt)) * 1000
        speed = speed === 0 ? inst : speed * 0.6 + inst * 0.4
        lastChunkAt = now
        downloaded += value.byteLength
        emit()
      }
    } catch (err) {
      if (signal?.aborted) {
        aborted = true
      } else {
        failError =
          err instanceof Error
            ? err
            : new Error(controller.signal.aborted ? '下载超时' : '未知错误')
      }
    } finally {
      clearInterval(stallTimer)
      clearTimeout(timeoutTimer)
      signal?.removeEventListener('abort', onAgentAbort)
    }

    // 收尾文件流（等 flush），出错时同样抛出
    await new Promise<void>((resolve, reject) => {
      fileStream.end((err) => (err ? reject(err) : resolve()))
    })
    if (failError) {
      throw new Error(
        `下载中断：${failError.message}（已下载 ${formatBytes(downloaded)} 至 ${dest}，文件不完整，可删除后重试）`
      )
    }

    log.info('下载完成', {
      url: p.url,
      path: dest,
      bytes: downloaded,
      durationMs: Date.now() - start,
      aborted
    })
    const text = aborted
      ? `[已中止] 已下载 ${formatBytes(downloaded)} 至 ${dest}（文件不完整）`
      : `下载完成：${dest}（${formatBytes(downloaded)}${
          totalBytes ? `，${Math.round((downloaded / totalBytes) * 100)}%` : ''
        }）`
    return {
      content: [{ type: 'text', text }],
      details: {
        url: p.url,
        path: dest,
        bytes: downloaded,
        durationMs: Date.now() - start,
        aborted
      }
    }
  }
}
