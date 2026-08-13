import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { spawn } from 'node:child_process'
import { resolveAgentWorkdir } from '../workdir'
import { db } from '../../database'
import { getShellEnv } from '../../utils/shell-env'
import { SETTING_AGENT_ENV } from '../types'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:bash')

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"运行构建验证代码可编译"）。请务必填写。'
    })
  ),
  command: Type.String({ description: '要执行的 shell 命令' }),
  cwd: Type.Optional(Type.String({ description: '工作目录绝对路径，默认当前目录' })),
  timeout_ms: Type.Optional(Type.Number({ description: '超时毫秒数，默认 30000' }))
})

const DEFAULT_TIMEOUT = 30_000
/** 单流（stdout/stderr）最大输出字符数，超出截断。 */
const MAX_OUTPUT = 50_000
/** SIGTERM 后等待子进程退出的宽限期，超时升级 SIGKILL（防子进程忽略 SIGTERM 导致 Promise 挂死）。 */
const KILL_GRACE_MS = 3_000

export interface BashDetails {
  command: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
}

/**
 * Shell 执行工具：在 shell 中执行命令，返回合并的 stdout+stderr。
 * 危险操作（DANGEROUS_TOOLS），执行前需用户确认（聊天流工具卡片「等待确认」）。
 * 支持 abort（agent.abort 时 kill 子进程）和超时。
 */
export const bashTool: AgentTool<typeof params, BashDetails> = {
  name: 'bash',
  label: '执行命令',
  description:
    '在 shell 中执行命令并返回 stdout 和 stderr。默认 30 秒超时。用于运行构建、测试、git 等命令。',
  parameters: params,
  executionMode: 'sequential',
  async execute(_toolCallId, p, signal) {
    const timeout = p.timeout_ms ?? DEFAULT_TIMEOUT
    log.info('执行命令', { command: p.command.slice(0, 200), cwd: p.cwd, timeout })
    // 子进程环境 = 应用自身 process.env + 用户 shell 环境（.zshrc/.bashrc，自动抓取一次）
    // + 设置页手动配置的额外变量（优先级最高）。解决打包应用从 Dock 启动丢环境变量的问题。
    const shellEnv = await getShellEnv()
    const manualEnv = db.getSetting<Record<string, string>>(SETTING_AGENT_ENV) ?? {}
    const env = { ...process.env, ...shellEnv, ...manualEnv }
    return new Promise((resolve) => {
      const start = Date.now()
      let truncated = false

      const child = spawn(p.command, {
        shell: true,
        // 默认工作目录：Agent 工作目录设置（settings > 开发项目根 / 生产用户主目录），
        // 与系统提示「工作目录」行同一来源；每次执行实时读取，改设置后立即生效。
        cwd: p.cwd ?? resolveAgentWorkdir(),
        env,
        // 独立进程组：中止/超时时可整体 kill 命令及其全部子进程（shell:true 下
        // 只杀 shell 会残留其派生的后台进程，如 npm run 里的 node）
        detached: true
      })

      /** 终止整个进程组（SIGTERM → 宽限期后升级 SIGKILL），spawn 失败时 pid 为 undefined，回退为只杀 child。 */
      const sendSignal = (sig: 'SIGTERM' | 'SIGKILL'): void => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, sig)
            return
          } catch {
            // 进程组已不存在，忽略
          }
        }
        child.kill(sig)
      }
      let killTimer: NodeJS.Timeout | null = null
      const terminate = (): void => {
        sendSignal('SIGTERM')
        // 子进程忽略/捕获 SIGTERM 时 'close' 永不触发，finalize 永不执行 → Promise 挂死，
        // Agent 随之挂死；宽限期后升级 SIGKILL 兜底。
        killTimer = setTimeout(() => {
          log.warn('命令未响应 SIGTERM，升级 SIGKILL', { command: p.command.slice(0, 200) })
          sendSignal('SIGKILL')
        }, KILL_GRACE_MS)
      }

      let stdout = ''
      let stderr = ''

      const append = (stream: 'stdout' | 'stderr', data: Buffer): void => {
        const chunk = data.toString('utf-8')
        const target = stream === 'stdout' ? stdout : stderr
        const updated = target + chunk
        if (updated.length > MAX_OUTPUT) {
          truncated = true
          if (stream === 'stdout') stdout = updated.slice(0, MAX_OUTPUT) + '\n...(输出已截断)'
          else stderr = updated.slice(0, MAX_OUTPUT) + '\n...(输出已截断)'
        } else {
          if (stream === 'stdout') stdout = updated
          else stderr = updated
        }
      }

      child.stdout.on('data', (d: Buffer) => append('stdout', d))
      child.stderr.on('data', (d: Buffer) => append('stderr', d))

      const timer = setTimeout(() => {
        log.warn('命令执行超时，已终止', { command: p.command.slice(0, 200), timeout })
        terminate()
      }, timeout)

      const finalize = (exitCode: number | null): void => {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        const durationMs = Date.now() - start
        const parts: string[] = []
        if (stdout) parts.push(stdout)
        if (stderr) parts.push(`[stderr]\n${stderr}`)
        const text = parts.join('\n') || '(无输出)'
        log.info('命令执行完成', {
          command: p.command.slice(0, 200),
          exitCode,
          durationMs,
          outputLength: text.length,
          truncated
        })
        resolve({
          content: [{ type: 'text', text }],
          details: { command: p.command, exitCode, durationMs, truncated }
        })
      }

      child.on('error', (err) => {
        clearTimeout(timer)
        log.error('命令执行失败（无法启动）', {
          command: p.command.slice(0, 200),
          error: err.message
        })
        resolve({
          content: [{ type: 'text', text: `执行失败: ${err.message}` }],
          details: { command: p.command, exitCode: null, durationMs: Date.now() - start, truncated }
        })
      })

      child.on('close', (code) => finalize(code))

      // abort 支持：agent.abort 时终止整个进程组
      if (signal) {
        if (signal.aborted) {
          terminate()
        } else {
          signal.addEventListener(
            'abort',
            () => {
              terminate()
            },
            { once: true }
          )
        }
      }
    })
  }
}
