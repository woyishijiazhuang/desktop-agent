import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveAgentWorkdir } from '../workdir'
import { db } from '../../database'
import { getShellEnv } from '../../utils/shell-env'
import { SETTING_AGENT_ENV } from '../types'
import { bashSessionManager, DEFAULT_TIMEOUT, formatBytes, resolveShell } from '../bash-session'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:bash')

/**
 * 不预检交互式/读 stdin 的命令：静态分析无法准确分辨（node -v 非交互、bash -c
 * 非交互、node 裸调用进 REPL……白名单永远追不上真实命令形态），误报比漏放更伤害体验。
 * 兜底链路已完备：裸 REPL/挂起命令最坏情况是吞掉哨兵直至超时（默认 30s），超时
 * 整组 SIGTERM → SIGKILL 终止会话（下次调用自动重建），错误信息引导换非交互写法
 * 或 background=true；长驻命令本就该用 background（stdin ignore，异步读取）。
 */

/** bash_output 的 wait_ms 上限（防单次调用阻塞过久）。 */
const MAX_WAIT_MS = 120_000

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
        'true=后台启动并立即返回 session_id（适合长驻命令、交互式命令：配合 bash_output 读输出、bash_input 写入交互应答、kill_shell 终止）；false=阻塞等待命令完成（默认）'
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
  session_id: Type.String({
    description:
      'bash 以 background=true 启动返回的会话 id；后台下载（download background=true）返回的 download_id 同样用它读进度/终止'
  }),
  tail: Type.Optional(
    Type.Boolean({
      description:
        'true=仅返回上次读取之后的新增输出（推荐，省 token）；false=从头返回全部输出。默认 true'
    })
  ),
  wait_ms: Type.Optional(
    Type.Number({
      description:
        '等待时长（毫秒）：若进程仍在运行，最多等待这么久，进程退出或到时立即返回（避免反复轮询）。默认 0 不等待。建议对预期很快结束的命令用 5000~30000。'
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
  session_id: Type.String({
    description:
      'bash 以 background=true 启动返回的会话 id，或 download background=true 返回的 download_id'
  })
})

const bashInputParams = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次调用的目的，会直接展示给用户浏览（例如"确认安装提示"）。请务必填写。'
    })
  ),
  session_id: Type.String({ description: 'bash 以 background=true 启动时返回的会话 id' }),
  input: Type.String({
    description: '要写入进程 stdin 的内容（如交互提示的回答、REPL 的一行代码）'
  }),
  newline: Type.Optional(
    Type.Boolean({
      description: 'true=内容后追加换行（回车提交，默认）；false=原样写入不回车'
    })
  ),
  end: Type.Optional(
    Type.Boolean({
      description:
        'true=写入后关闭 stdin（发送 EOF）：适合"读输入到结尾"的命令（如裸 cat、sort、wc）；仅关闭不写内容时可传空 input'
    })
  )
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

export interface BashInputDetails {
  sessionId: string
  /** 实际写入的字符数（含追加换行）。 */
  chars: number
  /** 是否已关闭 stdin（EOF）。 */
  ended: boolean
}

/**
 * 按 Agent 会话构建 bash 家族工具：
 * - `bash`：在持久化 shell 会话中执行命令（cd/export 保留）；background=true 时后台启动
 * - `bash_output`：读取后台会话输出（全量 / 增量 tail）
 * - `kill_shell`：终止后台会话
 * - `bash_input`：向后台会话进程 stdin 写入内容（交互式命令应答）/ 发送 EOF
 * 与 read_file 同理需要绑定会话，故用工厂而非单例。
 */
export function createBashTools(sessionId: string): AgentTool[] {
  // 描述按实际 shell 生成（Windows 依 PATH 有无 bash 选择），agent 语法与真实 shell 匹配
  const shellKind = resolveShell().kind
  const shellNote =
    shellKind === 'bash'
      ? '当前 shell 为 bash'
      : '当前 shell 为 PowerShell（Windows 未检测到 bash）：不要用 && 链、ls -la 等 bash 专有语法，用 ; 分隔命令、Get-ChildItem 等价替代'
  const bashTool: AgentTool<typeof bashParams, BashDetails> = {
    name: 'bash',
    label: '执行命令',
    description: `在持久化 shell 会话中执行命令并返回 stdout+stderr（${shellNote}）。cd 与环境变量设置在会话内保留。默认 30 秒超时（可用 timeout_ms 参数按命令调整）；长驻命令（npm run dev 等）用 background=true 后台启动，再用 bash_output 读取、kill_shell 终止；交互式命令（提示确认/密码、REPL）也用 background=true 启动，用 bash_input 写入应答、bash_output 读结果。危险操作需用户确认。`,
    parameters: bashParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p, signal, onUpdate) {
      // 不预检交互式命令（无法准确分辨，误报比漏放更烦人）：裸 REPL/读 stdin 的命令
      // 最坏情况是吞掉哨兵直至超时（默认 30s），超时兜底会整组终止会话并在下次调用自动
      // 重建，错误信息引导换非交互写法或 background=true。
      // 子进程环境 = 应用自身 process.env + 用户 shell 环境（.zshrc/.bashrc，自动抓取一次）
      // + 设置页手动配置的额外变量（优先级最高）。解决打包应用从 Dock 启动丢环境变量的问题。
      const shellEnv = await getShellEnv()
      const manualEnv = db.getSetting<Record<string, string>>(SETTING_AGENT_ENV) ?? {}
      const env = { ...process.env, ...shellEnv, ...manualEnv }
      const cwd = p.cwd ?? resolveAgentWorkdir()

      if (p.background) {
        const shell = bashSessionManager.startBackground(p.command, { cwd, env })
        const text = `已启动后台命令。session_id: ${shell.sessionId}\n可用 bash_output 读取输出（建议传 wait_ms 等待，避免轮询）；交互式提示用 bash_input 写入应答；读输入到结尾的命令用 bash_input end=true 发送 EOF；kill_shell 可终止。`
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
      '读取后台任务（bash 以 background=true 启动，或 download 以 background=true 后台下载）的输出/进度。tail=true 只返回新增输出，tail=false 返回全部。wait_ms 可指定等待时长：任务结束或到时立即返回（避免反复轮询）。shell 会话带 [进程运行中/已退出] 标记，下载任务带 [下载中/完成/失败] 标记。',
    parameters: bashOutputParams,
    executionMode: 'parallel',
    async execute(_toolCallId, p, signal, onUpdate) {
      const task = bashSessionManager.getBackground(p.session_id)
      if (!task) {
        throw new Error(`后台任务不存在（可能已退出清理）：${p.session_id}`)
      }
      const kind = task.kind
      // wait_ms：阻塞等待任务结束（或到时 / abort 先到先返回），一次调用拿终态，避免轮询
      const waitMs = p.wait_ms ? Math.min(Math.max(0, Math.floor(p.wait_ms)), MAX_WAIT_MS) : 0
      if (waitMs > 0 && !task.exited) {
        // 等待期间每秒推送倒计时快照（剩余秒数 + 已捕获输出量），前端经流式通道实时展示
        if (onUpdate) {
          const start = Date.now()
          const totalSec = Math.round(waitMs / 1000)
          const waitLabel = kind === 'download' ? '等待下载完成' : '等待后台命令完成'
          const emitProgress = (): void => {
            const elapsedMs = Date.now() - start
            const elapsedSec = Math.round(elapsedMs / 1000)
            const captured = task.read(false).text.length
            onUpdate({
              content: [
                {
                  type: 'text',
                  text: `${waitLabel}… ${elapsedSec}s / ${totalSec}s（已捕获 ${formatBytes(captured)} 输出，任务结束或到时即返回）`
                }
              ],
              details: {
                sessionId: p.session_id,
                tail: p.tail !== false,
                exited: false,
                exitCode: null
              }
            })
          }
          emitProgress()
          const timer = setInterval(emitProgress, 1_000)
          try {
            await task.waitExit(waitMs, signal)
          } finally {
            clearInterval(timer)
          }
        } else {
          await task.waitExit(waitMs, signal)
        }
      }
      const { text: output, exited, exitCode, errorMessage } = task.read(p.tail ?? true)
      let head: string
      if (kind === 'download') {
        if (errorMessage) head = `[下载失败] ${errorMessage}\n`
        else if (exited) head = exitCode === 0 ? '[下载完成]\n' : '[下载失败]\n'
        else head = '[下载中]\n'
      } else {
        if (errorMessage) head = `[启动失败] ${errorMessage}\n`
        else if (exited) head = `[进程已退出，exitCode=${exitCode}]\n`
        else head = '[进程运行中]\n'
      }
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
    label: '终止后台任务',
    description:
      '终止一个后台任务：bash 后台会话（background=true 启动）进程组整体终止（SIGTERM → SIGKILL），含其派生的全部子进程；后台下载（download background=true）则中止下载（文件不完整）。',
    parameters: killShellParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p) {
      const task = bashSessionManager.getBackground(p.session_id)
      if (!task) {
        throw new Error(`后台任务不存在（可能已退出清理）：${p.session_id}`)
      }
      task.kill()
      log.info('已终止后台任务', { sessionId, bgId: p.session_id })
      return {
        content: [{ type: 'text', text: `已终止后台任务 ${p.session_id}` }],
        details: { sessionId: p.session_id }
      }
    }
  }

  const bashInputTool: AgentTool<typeof bashInputParams, BashInputDetails> = {
    name: 'bash_input',
    label: '向后台命令写入输入',
    description:
      '向 bash 后台命令（background=true）的进程 stdin 写入内容：应答交互式提示（如确认 y/n、输入密码、REPL 逐行执行）。写入后用 bash_output 读取新输出。end=true 可在写入后关闭 stdin（发送 EOF，用于「读输入到结尾」的命令如裸 cat/sort/wc）。',
    parameters: bashInputParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p) {
      const shell = bashSessionManager.getBackgroundShell(p.session_id)
      if (!shell) {
        throw new Error(`后台会话不存在或不是 shell 命令（后台下载不支持写入输入）：${p.session_id}`)
      }
      // 空内容 + 仅关闭：直接发 EOF
      const data = p.input + (p.newline === false ? '' : '\n')
      let text: string
      let chars = 0
      if (p.input.length > 0) {
        const r = shell.write(data)
        if (!r.ok) throw new Error(r.error)
        chars = data.length
        text = `已写入 ${chars} 字符。请用 bash_output 读取新输出。`
      } else {
        text = '未写入内容。'
      }
      let ended = false
      if (p.end) {
        const r = shell.endStdin()
        if (!r.ok) throw new Error(r.error)
        ended = true
        text += ' stdin 已关闭（EOF）。'
      }
      if (chars === 0 && !ended) {
        throw new Error('input 为空且未指定 end=true，没有任何操作')
      }
      log.info('写入后台命令输入', {
        sessionId,
        bgId: p.session_id,
        chars,
        ended
      })
      return {
        content: [{ type: 'text', text }],
        details: { sessionId: p.session_id, chars, ended }
      }
    }
  }

  return [bashTool, bashOutputTool, killShellTool, bashInputTool]
}
