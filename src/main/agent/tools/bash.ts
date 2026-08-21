import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveAgentWorkdir } from '../workdir'
import { db } from '../../database'
import { getShellEnv } from '../../utils/shell-env'
import { SETTING_AGENT_ENV } from '../types'
import { bashSessionManager, DEFAULT_TIMEOUT } from './bash-session'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:bash')

/**
 * 明确交互式/持续占用终端的程序：裸调用即挂起或进入编辑器。
 * 持久化 shell 会话无法执行这类命令（无 TTY），直接拒绝。
 */
const INTERACTIVE_PROGRAMS = new Set([
  'vim',
  'nvim',
  'vi',
  'nano',
  'less',
  'more',
  'top',
  'htop',
  'ssh',
  'telnet',
  'sftp',
  'ftp',
  'irb',
  'psql',
  'mysql',
  'sqlite3',
  'ed',
  'ex'
])

/** 无参数（裸调用）时会读取 stdin 的程序：会吞掉持久 shell 的后续命令，须有输入源才放行。 */
const STDIN_READING_PROGRAMS = new Set([
  'cat',
  'read',
  'bash',
  'sh',
  'zsh',
  'fish',
  'python',
  'python2',
  'python3',
  'node',
  'pip',
  'pip3'
])

/** git commit 提供提交信息/免编辑器的标志（命中则视为非交互）。 */
const GIT_COMMIT_MSG_RE =
  /-m\b|-am\b|-pm\b|--message\b|--amend\b|--no-edit\b|--fixup\b|--squash\b|--file\b|-F\b/

/**
 * 检测命令是否交互式/读 stdin（持久化会话中会挂起或吞掉后续命令）。
 * 命中返回交互描述，否则返回 null。误伤宁可拒绝（错误信息会引导改用非交互写法）。
 */
function detectInteractiveCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (/\bgit\s+rebase\b[^]*\s-i\b/.test(trimmed)) return 'git rebase -i（交互式变基编辑器）'
  if (/\bgit\s+add\s+-p\b/.test(trimmed)) return 'git add -p（交互式暂存）'
  if (/^\s*git\s+commit\b/.test(trimmed) && !GIT_COMMIT_MSG_RE.test(trimmed)) {
    return 'git commit（未提供 -m/--amend 等标志，会打开编辑器）'
  }
  if (/\bcrontab\b($|\s+-e\b)/.test(trimmed)) return 'crontab（编辑模式）'
  if (/^\s*sudo\b/.test(trimmed) && !/\bsudo\s+-n\b/.test(trimmed)) {
    return 'sudo（无 -n，可能交互式提示密码）'
  }
  const first = trimmed.split(/\s+/)[0]
  if (INTERACTIVE_PROGRAMS.has(first)) return first
  if (STDIN_READING_PROGRAMS.has(first)) {
    const rest = trimmed.slice(first.length).trim()
    // 有非选项参数（cat file / python script.py）或有管道/重定向输入 = 有输入源，非交互
    const hasInputArg = rest.length > 0 && !rest.startsWith('-')
    const hasInputRedirect = /[<|]/.test(trimmed)
    if (!hasInputArg && !hasInputRedirect) return `${first}（裸调用会读取 stdin）`
  }
  return null
}

const bashParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"运行构建验证代码可编译"）。请务必填写。'
    })
  ),
  command: Type.String({ description: '要执行的 shell 命令' }),
  cwd: Type.Optional(
    Type.String({
      description:
        '工作目录绝对路径，默认 Agent 工作目录。注意：命令在持久化 shell 会话中执行，每次都会先 cd 到该目录，且 cd 结果会保留'
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: '阻塞模式超时毫秒数，默认 30000。npm run dev 等长驻命令请改用 background=true'
    })
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'true=后台启动并立即返回 session_id（适合 npm run dev / 长测试等长驻命令，配合 bash_output 读输出、kill_shell 终止）；false=阻塞等待命令完成（默认）'
    })
  )
})

const bashOutputParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"查看构建日志"）。请务必填写。'
    })
  ),
  session_id: Type.String({ description: 'bash 以 background=true 启动时返回的会话 id' }),
  tail: Type.Optional(
    Type.Boolean({
      description:
        'true=仅返回上次读取之后的新增输出（推荐，省 token）；false=从头返回全部输出。默认 true'
    })
  )
})

const killShellParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"关闭开发服务器"）。请务必填写。'
    })
  ),
  session_id: Type.String({ description: 'bash 以 background=true 启动时返回的会话 id' })
})

export interface BashDetails {
  command: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
  /** 后台模式：true 时返回的是 session_id 而非命令输出。 */
  background?: boolean
  /** 后台模式返回的会话 id（bash_output / kill_shell 用）。 */
  sessionId?: string
}

export interface BashOutputDetails {
  sessionId: string
  tail: boolean
  exited: boolean
  exitCode: number | null
}

export interface KillShellDetails {
  sessionId: string
}

/**
 * 按 Agent 会话构建 bash 家族工具：
 * - `bash`：在持久化 shell 会话中执行命令（cd/export 保留）；background=true 时后台启动
 * - `bash_output`：读取后台会话输出（全量 / 增量 tail）
 * - `kill_shell`：终止后台会话
 * 与 read_file 同理需要绑定会话，故用工厂而非单例。
 */
export function createBashTools(sessionId: string): AgentTool[] {
  const bashTool: AgentTool<typeof bashParams, BashDetails> = {
    name: 'bash',
    label: '执行命令',
    description:
      '在持久化 shell 会话中执行命令并返回 stdout+stderr。cd 与 export 在会话内保留。默认 30 秒超时；长驻命令（npm run dev 等）用 background=true 后台启动，再用 bash_output 读取、kill_shell 终止。危险操作需用户确认。',
    parameters: bashParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p, signal, onUpdate) {
      // 交互式/读 stdin 命令在持久化会话中会挂起或吞掉后续命令，直接拒绝并引导非交互写法
      const interactive = detectInteractiveCommand(p.command)
      if (interactive) {
        throw new Error(
          `检测到交互式命令：${interactive}。持久化 shell 会话无法执行交互式/读 stdin 的命令（会挂起或吞掉后续命令）。请改用非交互写法，如 git commit -m "..."、cat file、python script.py、sudo -n 命令。`
        )
      }
      // 子进程环境 = 应用自身 process.env + 用户 shell 环境（.zshrc/.bashrc，自动抓取一次）
      // + 设置页手动配置的额外变量（优先级最高）。解决打包应用从 Dock 启动丢环境变量的问题。
      const shellEnv = await getShellEnv()
      const manualEnv = db.getSetting<Record<string, string>>(SETTING_AGENT_ENV) ?? {}
      const env = { ...process.env, ...shellEnv, ...manualEnv }
      const cwd = p.cwd ?? resolveAgentWorkdir()

      if (p.background) {
        const shell = bashSessionManager.startBackground(p.command, { cwd, env })
        const text = `已启动后台命令。session_id: ${shell.sessionId}\n可用 bash_output 读取输出、kill_shell 终止。`
        log.info('后台命令已启动', {
          sessionId,
          bgId: shell.sessionId,
          command: p.command.slice(0, 200)
        })
        return {
          content: [{ type: 'text', text }],
          details: {
            command: p.command,
            exitCode: null,
            durationMs: 0,
            truncated: false,
            background: true,
            sessionId: shell.sessionId
          }
        }
      }

      const shell = bashSessionManager.getOrCreateDefault(sessionId)
      const timeout = p.timeout_ms ?? DEFAULT_TIMEOUT
      log.info('执行命令', { sessionId, command: p.command.slice(0, 200), cwd, timeout })
      const result = await shell.run(p.command, {
        timeoutMs: timeout,
        signal,
        cwd,
        env,
        onUpdate: (text) =>
          onUpdate?.({
            content: [{ type: 'text', text }],
            details: { command: p.command, exitCode: null, durationMs: 0, truncated: false }
          })
      })
      log.info('命令执行完成', {
        sessionId,
        command: p.command.slice(0, 200),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputLength: result.text.length,
        timedOut: result.timedOut
      })
      return {
        content: [{ type: 'text', text: result.text }],
        details: {
          command: p.command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated
        }
      }
    }
  }

  const bashOutputTool: AgentTool<typeof bashOutputParams, BashOutputDetails> = {
    name: 'bash_output',
    label: '读取后台输出',
    description:
      '读取 bash 后台命令（background=true）的输出。tail=true 只返回新增输出，tail=false 返回全部。进程仍在运行时结果带 [进程运行中] 标记，退出后带退出码。',
    parameters: bashOutputParams,
    executionMode: 'parallel',
    async execute(_toolCallId, p) {
      const shell = bashSessionManager.getBackground(p.session_id)
      if (!shell) {
        throw new Error(`后台会话不存在（可能已退出清理）：${p.session_id}`)
      }
      const { text: output, exited, exitCode, errorMessage } = shell.read(p.tail ?? true)
      let head: string
      if (errorMessage) head = `[启动失败] ${errorMessage}\n`
      else if (exited) head = `[进程已退出，exitCode=${exitCode}]\n`
      else head = '[进程运行中]\n'
      const body = output || (p.tail === false ? '(暂无输出)' : '(无新增输出)')
      log.debug('读取后台输出', {
        sessionId,
        bgId: p.session_id,
        tail: p.tail !== false,
        exited,
        outputLength: output.length
      })
      return {
        content: [{ type: 'text', text: head + body }],
        details: { sessionId: p.session_id, tail: p.tail !== false, exited, exitCode }
      }
    }
  }

  const killShellTool: AgentTool<typeof killShellParams, KillShellDetails> = {
    name: 'kill_shell',
    label: '终止后台命令',
    description:
      '终止一个 bash 后台会话（background=true 启动）。进程组整体终止（SIGTERM → SIGKILL），含其派生的全部子进程。',
    parameters: killShellParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p) {
      const shell = bashSessionManager.getBackground(p.session_id)
      if (!shell) {
        throw new Error(`后台会话不存在（可能已退出清理）：${p.session_id}`)
      }
      shell.kill()
      log.info('已终止后台命令', { sessionId, bgId: p.session_id })
      return {
        content: [{ type: 'text', text: `已终止后台命令 ${p.session_id}` }],
        details: { sessionId: p.session_id }
      }
    }
  }

  return [bashTool, bashOutputTool, killShellTool]
}
