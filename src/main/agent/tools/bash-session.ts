import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:bash')

/** 阻塞命令默认超时（工具层未显式指定时使用）。 */
export const DEFAULT_TIMEOUT = 30_000
/** 单命令输出合并上限（字符）：超出保留头部并追加截断标记。 */
const MAX_OUTPUT = 50_000
/** 流式输出推送节流间隔（ms）：高频输出合并为每间隔至多一次快照。 */
const STREAM_INTERVAL_MS = 50
/** 单后台会话输出缓冲上限（字符）：超出从头截断。 */
const MAX_SESSION_OUTPUT = 100_000
/** 后台会话数量上限（超出优先淘汰已退出的最久未读会话）。 */
const MAX_BACKGROUND_SESSIONS = 8
/** SIGTERM/SIGINT 后升级 SIGKILL 的宽限期（ms）。 */
const KILL_GRACE_MS = 3_000
/** 后台下载进度推送节流间隔（ms）。 */
const PROGRESS_INTERVAL_MS = 200
/** 后台下载连接建立后长时间无新数据（读不到字节）视为挂死，强制中止（防死链无限拖）。 */
const STALL_TIMEOUT_MS = 30_000

/** 字节数 → 人类可读（后台任务进度/结果提示用）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** 可用的持久化 shell 形态（跨平台）：macOS/Linux 用 bash；Windows 优先 bash（Git Bash
 * 在 PATH 时），否则回落 PowerShell（Win10+ 系统自带）。 */
export interface ShellSpec {
  command: string
  args: string[]
  kind: 'bash' | 'powershell'
}

/** 模块级缓存：首次使用时探测一次（spawnSync 探测 bash 是否存在，约几十 ms）。 */
let resolvedShell: ShellSpec | null = null
export function resolveShell(): ShellSpec {
  if (resolvedShell) return resolvedShell
  if (process.platform !== 'win32') {
    resolvedShell = { command: 'bash', args: ['--noprofile', '--norc', '-s'], kind: 'bash' }
    return resolvedShell
  }
  // Windows：PATH 里探测 bash（Git Bash 等）；探测不到用 PowerShell
  const probe = spawnSync('bash', ['-c', 'exit 0'], { timeout: 5_000 })
  if (!probe.error) {
    resolvedShell = { command: 'bash', args: ['--noprofile', '--norc', '-s'], kind: 'bash' }
  } else {
    // -Command -：从 stdin 逐行读取并执行脚本语句；-NonInteractive 防提示卡死
    resolvedShell = {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'],
      kind: 'powershell'
    }
  }
  log.info('已选择持久 shell', { platform: process.platform, kind: resolvedShell.kind })
  return resolvedShell
}

/**
 * 命令完成哨兵（固定格式便于正则匹配）：bash 用 printf；PowerShell 用 Write-Output
 * + $LASTEXITCODE（无原生命令时 $LASTEXITCODE 可能为 $null，取 0 兜底）。
 * 两种 shell 的输出行均以 \n 结束（正则兼容 \r）。
 */
const SENTINEL_RE = /^__PI_BASH_DONE_([0-9a-f-]{36})__:(-?\d+)\r?$/
function sentinelCmd(id: string, kind: 'bash' | 'powershell'): string {
  return kind === 'bash'
    ? `printf '__PI_BASH_DONE_${id}__:%d\\n' "$?"`
    : `Write-Output "__PI_BASH_DONE_${id}__:$(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 })"`
}

/** shell 单引号转义（cwd 参数 cd 用）：bash 用 '\''，PowerShell 用 ''。 */
function shellQuote(s: string, kind: 'bash' | 'powershell'): string {
  return kind === 'bash' ? `'${s.replace(/'/g, `'\\''`)}'` : `'${s.replace(/'/g, "''")}'`
}

/** 「cd 到 cwd，失败即退出码 1」的 shell 语法。 */
function cdCmd(cwd: string, kind: 'bash' | 'powershell'): string {
  return kind === 'bash'
    ? `cd ${shellQuote(cwd, kind)} || exit 1`
    : `Set-Location -LiteralPath ${shellQuote(cwd, kind)}; if (-not $?) { exit 1 }`
}

/** 合并 stdout/stderr 为工具可见文本（超限时保留尾部 + 截断标记，错误信息通常在末尾）。 */
function mergeOutput(out: string, err: string): { text: string; truncated: boolean } {
  const parts: string[] = []
  if (out) parts.push(out)
  if (err) parts.push(`[stderr]\n${err}`)
  let text = parts.join('\n') || '(无输出)'
  if (text.length > MAX_OUTPUT) {
    text = `...(输出已截断，仅保留末尾 ${MAX_OUTPUT} 字符)...\n${text.slice(-MAX_OUTPUT)}`
    return { text, truncated: true }
  }
  return { text, truncated: false }
}

export interface ShellRunOptions {
  /** 阻塞超时（ms）；后台/长驻命令应改用工具层的 background 参数。 */
  timeoutMs?: number
  /** agent 中止信号：触发时中断当前命令（后台会话不受影响）。 */
  signal?: AbortSignal
  /** 流式输出回调（完整累计文本，替换语义）。 */
  onUpdate?: (text: string) => void
  /** 工作目录：每次执行前显式 cd 到该目录（在持久化会话中同样生效并保留）。 */
  cwd?: string
  /** 启动 shell 时注入的环境（默认 process.env 继承）。 */
  env?: NodeJS.ProcessEnv
}

export interface ShellRunResult {
  text: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
  /** 是否超时被中断（返回部分输出，命令已在 shell 中被 SIGINT）。 */
  timedOut: boolean
  /** 是否因 agent 中止被中断。 */
  aborted: boolean
}

interface PendingCommand {
  id: string
  outputOut: string
  outputErr: string
  startedAt: number
  timer: NodeJS.Timeout | null
  settled: boolean
  timedOut: boolean
  aborted: boolean
  resolve: (result: ShellRunResult) => void
  onUpdate?: (text: string) => void
}

/**
 * 每个 Agent 会话一个持久化 shell（bash --noprofile --norc -s，从 stdin 读命令）：
 * - 命令按 FIFO 队列写入 stdin，用「唯一哨兵 + $?」标记每条命令的完成边界与退出码
 * - cd / export 在 shell 内保留（持久化会话）
 * - 阻塞命令执行期间经 onUpdate 节流推送合并输出（tool_execution_update 流式）
 * - 超时/中止：非交互 bash 与命令同进程组，无法只中断命令，故整组 SIGTERM → SIGKILL、
 *   会话整体重置（下次调用自动重建）；后台命令不受影响（abort 保留后台进程）
 * 纯 Node 实现，不依赖 electron/db（env/cwd 由工具层注入）。
 */
export class PersistentShell {
  readonly sessionId: string
  private child: ChildProcess | null = null
  /** 当前 child 是否已 close（信号杀死的进程 exitCode 为 null，存活判断以此为准）。 */
  private childClosed = false
  private queue: PendingCommand[] = []
  private lineBuf = ''
  private streamDirty = false
  private streamTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /** 惰性启动 shell（env/cwd 仅首次/重建时生效，之后由 shell 内 cd/export 决定）。 */
  private ensureStarted(env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
    if (this.child && !this.childClosed) return this.child
    const spec = resolveShell()
    const child = spawn(spec.command, spec.args, {
      cwd,
      env,
      // 独立进程组：超时/中止/销毁时可整体 kill 命令及其全部子进程
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.childClosed = false
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    // 仅当仍是当前 child 时才归因输出，避免被终止的旧 shell 残留输出污染新会话
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) this.onChunk('out', chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child) this.onChunk('err', chunk)
    })
    child.on('error', (err) => {
      log.error('持久 shell 启动失败', {
        sessionId: this.sessionId,
        command: spec.command,
        error: err.message
      })
      this.failAll(`shell 启动失败（${spec.command}）: ${err.message}`)
    })
    child.on('close', (code) => {
      if (this.child !== child) return // 已被新 shell 取代（超时/中止后重建），忽略旧 close
      this.childClosed = true
      log.warn('持久 shell 退出', { sessionId: this.sessionId, exitCode: code })
      this.failAll(`shell 会话已退出（exitCode=${code}），可重试或新建会话`)
    })
    log.info('持久 shell 已启动', { sessionId: this.sessionId, cwd, kind: spec.kind })
    return child
  }

  /** 执行一条命令（阻塞）：写入 stdin + 哨兵，等待哨兵返回输出与退出码。 */
  async run(command: string, opts: ShellRunOptions = {}): Promise<ShellRunResult> {
    const cwd = opts.cwd ?? ''
    const child = this.ensureStarted(opts.env ?? {}, cwd)
    const spec = resolveShell()
    // cwd 显式指定时先 cd（失败即退出码 1），保证参数权威且与旧版按 cwd 启动语义一致
    const effective = cwd ? `${cdCmd(cwd, spec.kind)}\n${command}` : command
    const id = randomUUID()
    const cmd: PendingCommand = {
      id,
      outputOut: '',
      outputErr: '',
      startedAt: Date.now(),
      timer: null,
      settled: false,
      timedOut: false,
      aborted: false,
      resolve: () => {},
      onUpdate: opts.onUpdate
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
    return new Promise<ShellRunResult>((resolve) => {
      cmd.resolve = resolve
      this.queue.push(cmd)
      try {
        child.stdin!.write(`${effective}\n${sentinelCmd(id, spec.kind)}\n`)
      } catch (err) {
        // stdin 已关闭（shell 已退出）：立即失败并清空队列
        this.failAll(`shell 会话不可用: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (timeoutMs > 0) {
        cmd.timer = setTimeout(() => this.interruptFront('timeout', timeoutMs), timeoutMs)
      }
      const onAbort = (): void => this.interruptFront('aborted', timeoutMs)
      if (opts.signal) {
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** 输出归因 + 哨兵扫描（stdout 兼做哨兵通道）。 */
  private onChunk(stream: 'out' | 'err', chunk: string): void {
    const front = this.queue[0]
    if (front && !front.settled) {
      // 原始缓冲滑动窗口保留尾部（与 mergeOutput 截断方向一致，错误信息通常在末尾）
      if (stream === 'out') front.outputOut = (front.outputOut + chunk).slice(-MAX_OUTPUT)
      else front.outputErr = (front.outputErr + chunk).slice(-MAX_OUTPUT)
      this.scheduleStream()
    }
    if (stream === 'out') this.scanSentinel(chunk)
  }

  /** 按行扫描哨兵：完整行进入判定，跨 chunk 的半行留在 lineBuf。 */
  private scanSentinel(chunk: string): void {
    this.lineBuf += chunk
    let idx: number
    while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, idx)
      this.lineBuf = this.lineBuf.slice(idx + 1)
      const m = SENTINEL_RE.exec(line)
      if (m) this.onSentinel(m[1], Number(m[2]), `${line}\n`)
    }
  }

  /** 哨兵到达：结束队首命令（从原始输出剔除哨兵行），推进队列。 */
  private onSentinel(id: string, exitCode: number, sentinelText: string): void {
    const front = this.queue[0]
    if (!front || front.id !== id) return
    const rawIdx = front.outputOut.lastIndexOf(sentinelText)
    if (rawIdx >= 0) front.outputOut = front.outputOut.slice(0, rawIdx)
    if (front.timer) {
      clearTimeout(front.timer)
      front.timer = null
    }
    this.flushStream()
    this.queue.shift()
    const merged = mergeOutput(front.outputOut, front.outputErr)
    this.settle(front, {
      text: merged.text,
      exitCode,
      truncated: merged.truncated,
      timedOut: front.timedOut,
      aborted: front.aborted
    })
  }

  /**
   * 超时/中止：终止整个 shell 会话。
   * 非交互 bash 与命令同进程组，向组内发任何信号（SIGINT 亦同）都会连带杀死 bash，
   * 无法单独中断当前命令且保留会话，故整组 SIGTERM → SIGKILL，会话下次调用自动重建。
   * 队首返回部分输出 + 标记；其余排队命令立即失败；旧 child 的 close 因已被替换而忽略。
   */
  private interruptFront(reason: 'timeout' | 'aborted', timeoutMs: number): void {
    const front = this.queue[0]
    if (!front || front.settled) return
    if (front.timer) {
      clearTimeout(front.timer)
      front.timer = null
    }
    if (reason === 'timeout') front.timedOut = true
    else front.aborted = true
    // 队首结算（部分输出 + 后缀）
    this.settleInterrupted(front, reason, timeoutMs)
    // 其余排队命令立即失败（它们随旧 shell 一起消亡）
    const rest = this.queue.slice(1)
    this.queue = []
    for (const c of rest) {
      this.settle(c, {
        text: '(命令未完成) 会话被中断，shell 已终止',
        exitCode: null,
        truncated: false,
        timedOut: false,
        aborted: false
      })
    }
    // 终止旧 shell 并让位给新 shell（close 事件因 this.child 已替换而被忽略）
    const child = this.child
    this.child = null
    this.childClosed = false
    if (child) {
      log.warn('命令超时/中止，终止 shell 会话', {
        sessionId: this.sessionId,
        reason,
        timeoutMs
      })
      this.killGroup(child, 'SIGTERM')
      const escalate = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          this.killGroup(child, 'SIGKILL')
        }
      }
      setTimeout(escalate, KILL_GRACE_MS)
    }
  }

  /** 结算被中断的命令（部分输出 + 超时/中止后缀）。 */
  private settleInterrupted(
    front: PendingCommand,
    reason: 'timeout' | 'aborted',
    timeoutMs: number
  ): void {
    this.flushStream()
    const merged = mergeOutput(front.outputOut, front.outputErr)
    const suffix =
      reason === 'timeout'
        ? `\n[命令执行超时（${timeoutMs}ms），已中断；会话已重置。若为长驻命令请改用 background=true；若为裸 REPL/读 stdin 的命令（如 node、python 裸调用），请改用非交互写法，如 node -e "code"、python -c "code"、python script.py]`
        : '\n[命令已中止；会话已重置]'
    this.settle(front, {
      text: merged.text + suffix,
      exitCode: null,
      truncated: merged.truncated,
      timedOut: reason === 'timeout',
      aborted: reason === 'aborted'
    })
  }

  /** 结算（幂等）：timeout/哨兵/shell 退出都可能触发。 */
  private settle(cmd: PendingCommand, result: Omit<ShellRunResult, 'durationMs'>): void {
    if (cmd.settled) return
    cmd.settled = true
    if (cmd.timer) {
      clearTimeout(cmd.timer)
      cmd.timer = null
    }
    cmd.resolve({ ...result, durationMs: Date.now() - cmd.startedAt })
  }

  /** shell 失效：全部排队命令以失败结算。 */
  private failAll(reason: string): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer)
      this.streamTimer = null
    }
    const pending = this.queue
    this.queue = []
    for (const cmd of pending) {
      this.settle(cmd, {
        text: `(命令未完成) ${reason}`,
        exitCode: null,
        truncated: false,
        timedOut: cmd.timedOut,
        aborted: cmd.aborted
      })
    }
  }

  /** 流式输出：节流推送队首命令的合并快照。 */
  private scheduleStream(): void {
    const front = this.queue[0]
    if (!front || !front.onUpdate || front.settled || this.streamTimer !== null) return
    this.streamDirty = true
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null
      if (this.streamDirty) this.emitStream()
    }, STREAM_INTERVAL_MS)
  }

  private emitStream(): void {
    if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer)
      this.streamTimer = null
    }
    this.streamDirty = false
    const front = this.queue[0]
    if (!front || !front.onUpdate || front.settled) return
    front.onUpdate(mergeOutput(front.outputOut, front.outputErr).text)
  }

  private flushStream(): void {
    if (this.streamDirty) this.emitStream()
    else if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer)
      this.streamTimer = null
    }
  }

  private killGroup(child: ChildProcess, sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
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

  /** 显式销毁（应用退出等）：SIGTERM → 宽限期 → SIGKILL。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (child && !this.childClosed) {
      this.killGroup(child, 'SIGTERM')
      const escalate = (): void => {
        if (!this.childClosed) this.killGroup(child, 'SIGKILL')
      }
      setTimeout(escalate, KILL_GRACE_MS)
    }
    this.failAll('shell 会话已销毁')
  }
}

/** 单次后台命令会话：独立进程组，stdin 可写入（交互式命令应答），输出缓冲，可读取/终止。 */
export class BackgroundShell {
  readonly sessionId: string
  /** 启动时执行的命令原文（面板展示用）。 */
  readonly command: string
  /** 进程启动时间（面板展示已运行时长用）。 */
  readonly startedAt: number
  /** 进程 pid（面板展示/排查用）。 */
  readonly pid: number | undefined
  /** 任务类型（统一后台任务注册表判别用）。 */
  readonly kind = 'shell' as const
  private child: ChildProcess
  private outputBuf = ''
  private tailOffset = 0
  exited = false
  exitCode: number | null = null
  /** 退出时刻（面板展示"运行时长"用；未退出为 null）。 */
  exitedAt: number | null = null
  errorMessage?: string
  /** 状态变更（退出/错误）通知：Manager 据此推送 renderer 面板刷新。 */
  private onStateChange?: () => void

  constructor(sessionId: string, child: ChildProcess, command: string, onStateChange?: () => void) {
    this.sessionId = sessionId
    this.command = command
    this.startedAt = Date.now()
    this.pid = child.pid
    this.child = child
    this.onStateChange = onStateChange
    // stdin 为 pipe（交互式命令应答通道）：吞掉 EPIPE 等写入错误，避免进程退出后的
    // 残留写入以 unhandled error 事件崩溃进程；写入失败由 write() 的同步返回上报。
    child.stdin?.on('error', () => {})
    // stdio 配置为 ['pipe', 'pipe', 'pipe']，stdout/stderr 必为可读流
    const stdout = child.stdout!
    const stderr = child.stderr!
    stdout.setEncoding('utf-8')
    stderr.setEncoding('utf-8')
    stdout.on('data', (chunk: string) => this.append(chunk))
    stderr.on('data', (chunk: string) => this.append(chunk))
    child.on('error', (err) => {
      this.errorMessage = err.message
      this.exited = true
      this.exitedAt = Date.now()
      this.exitCode = -1
      this.onStateChange?.()
    })
    child.on('close', (code) => {
      this.exited = true
      this.exitedAt = Date.now()
      // spawn 失败时先发 'error'（exitCode=-1）再必然发一次 'close'（code=null），
      // 保留首个有效退出码，避免失败终态被覆盖成 null
      if (this.exitCode === null) this.exitCode = code
      // 进程已退出，关闭 stdin 管道：让「读 stdin 到 EOF」语义在下游（如有管道级联）正确传播
      child.stdin?.end()
      this.onStateChange?.()
    })
  }

  /** 面板展示用的会话快照。 */
  info(): BackgroundSessionInfo {
    return {
      id: this.sessionId,
      command: this.command,
      startedAt: this.startedAt,
      pid: this.pid,
      exited: this.exited,
      exitCode: this.exitCode,
      exitedAt: this.exitedAt,
      outputBytes: this.outputBuf.length,
      kind: 'shell'
    }
  }

  private append(chunk: string): void {
    this.outputBuf += chunk
    if (this.outputBuf.length > MAX_SESSION_OUTPUT) {
      const drop = this.outputBuf.length - MAX_SESSION_OUTPUT
      this.outputBuf = this.outputBuf.slice(drop)
      this.tailOffset = Math.max(0, this.tailOffset - drop)
    }
  }

  /**
   * 向进程 stdin 写入内容（交互式命令应答）：agent 经 bash_input 工具调用。
   * 进程已退出或 stdin 已关闭时返回失败（EPIPE 由 stdin error 监听吞掉，不崩进程）。
   */
  write(input: string): { ok: boolean; error?: string } {
    if (this.exited) {
      return { ok: false, error: `进程已退出（exitCode=${this.exitCode}），无法写入` }
    }
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return { ok: false, error: 'stdin 不可写（进程可能未读 stdin 或已关闭）' }
    }
    try {
      stdin.write(input)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 关闭 stdin（发送 EOF）：供「读输入到结尾」的命令收尾（裸 cat / sort / wc 等）。 */
  endStdin(): { ok: boolean; error?: string } {
    if (this.exited) return { ok: true }
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed) return { ok: true }
    try {
      stdin.end()
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: `关闭 stdin 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /** 读取输出：tail=true 仅返回上次读取后的新增；false 返回全部。 */
  read(tail: boolean): {
    text: string
    exited: boolean
    exitCode: number | null
    errorMessage?: string
  } {
    let text: string
    if (tail) {
      text = this.outputBuf.slice(this.tailOffset)
      this.tailOffset = this.outputBuf.length
    } else {
      text = this.outputBuf
    }
    return { text, exited: this.exited, exitCode: this.exitCode, errorMessage: this.errorMessage }
  }

  /**
   * 等待进程退出，最多等 timeoutMs 毫秒（进程退出 / 超时 / abort 先到先返回）。
   * @returns true=已退出（调用方随后 read 即得最终输出）；false=仍在运行或已被中止
   */
  waitExit(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    const child = this.child
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        child.removeListener('close', onClose)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      const onClose = (): void => finish(true)
      const onAbort = (): void => finish(false)
      child.once('close', onClose)
      if (signal) {
        if (signal.aborted) finish(false)
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** 终止进程组（SIGTERM → 宽限期 → SIGKILL）。 */
  kill(): void {
    const child = this.child
    if (this.exited) return
    const send = (sig: 'SIGTERM' | 'SIGKILL'): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, sig)
          return
        } catch {
          // 进程组已不存在
        }
      }
      child.kill(sig)
    }
    send('SIGTERM')
    setTimeout(() => {
      if (!this.exited) send('SIGKILL')
    }, KILL_GRACE_MS)
  }
}

/** 后台下载进度快照（前台模式经 onProgress 转发为 tool_execution_update）。 */
interface DownloadProgressInfo {
  text: string
  bytes: number
  total: number | null
  durationMs: number
}

/** 后台下载任务：HTTP 流式下载，进度逐行写入输出缓冲，可终止（abort）、可等待终态。
 *  与 BackgroundShell 共用「输出缓冲 + 状态字段 + kill/waitExit」形态，由统一注册表管理，
 *  供 bash_output 读进度 / kill_shell 终止 / 侧栏面板展示；前台模式经 onProgress 转发流式进度。 */
class BackgroundDownload {
  readonly sessionId: string
  /** 面板展示用标签：URL。 */
  readonly command: string
  readonly startedAt: number
  readonly kind = 'download' as const
  /** 最终保存路径（结果提示用）。 */
  readonly dest: string
  exited = false
  exitCode: number | null = null
  exitedAt: number | null = null
  errorMessage?: string
  /** 已下载字节数（前台终态/面板读取用）。 */
  downloadedBytes = 0
  /** 总字节数（Content-Length 缺失时 null）。 */
  totalBytes: number | null = null
  private outputBuf = ''
  private tailOffset = 0
  private controller = new AbortController()
  private waiters = new Set<() => void>()
  private onStateChange?: () => void
  private onProgress?: (info: DownloadProgressInfo) => void
  private lastEmit = 0

  constructor(
    sessionId: string,
    url: string,
    dest: string,
    opts: { onStateChange?: () => void; onProgress?: (info: DownloadProgressInfo) => void }
  ) {
    this.sessionId = sessionId
    this.command = url
    this.dest = dest
    this.startedAt = Date.now()
    this.onStateChange = opts.onStateChange
    this.onProgress = opts.onProgress
    void this.#run(url)
  }

  /** 面板展示用的任务快照。 */
  info(): BackgroundSessionInfo {
    return {
      id: this.sessionId,
      command: this.command,
      startedAt: this.startedAt,
      pid: undefined,
      exited: this.exited,
      exitCode: this.exitCode,
      exitedAt: this.exitedAt,
      outputBytes: this.outputBuf.length,
      kind: 'download'
    }
  }

  /** 读取输出（进度日志 / 终态提示）：tail=true 仅返回新增；false 返回全部。 */
  read(tail: boolean): {
    text: string
    exited: boolean
    exitCode: number | null
    errorMessage?: string
  } {
    let text: string
    if (tail) {
      text = this.outputBuf.slice(this.tailOffset)
      this.tailOffset = this.outputBuf.length
    } else {
      text = this.outputBuf
    }
    return { text, exited: this.exited, exitCode: this.exitCode, errorMessage: this.errorMessage }
  }

  /** 终止下载（abort 底层 fetch 流）：结束后 exited 翻转并通知面板。 */
  kill(): void {
    this.controller.abort()
  }

  /** 等待下载结束，最多等 timeoutMs 毫秒（结束 / 超时 / abort 先到先返回）。 */
  waitExit(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters.delete(onFinish)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      const onFinish = (): void => finish(true)
      const onAbort = (): void => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.waiters.add(onFinish)
      if (signal) {
        if (signal.aborted) finish(false)
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private append(line: string): void {
    this.outputBuf += line
    if (this.outputBuf.length > MAX_SESSION_OUTPUT) {
      const drop = this.outputBuf.length - MAX_SESSION_OUTPUT
      this.outputBuf = this.outputBuf.slice(drop)
      this.tailOffset = Math.max(0, this.tailOffset - drop)
    }
  }

  /** 终态落定：翻转状态字段 + 唤醒等待者 + 通知面板。 */
  private finish(exitCode: number, errorMessage?: string): void {
    this.exited = true
    this.exitCode = exitCode
    this.exitedAt = Date.now()
    this.errorMessage = errorMessage
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const w of waiters) w()
    this.onStateChange?.()
  }

  async #run(url: string): Promise<void> {
    const start = Date.now()
    let stallTimer: ReturnType<typeof setInterval> | undefined
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) desktop-agent' },
        redirect: 'follow',
        signal: this.controller.signal
      })
      if (!res.ok) {
        this.append(`下载失败：HTTP ${res.status} ${res.statusText}\n`)
        this.finish(-1, `HTTP ${res.status} ${res.statusText}`)
        return
      }
      if (!res.body) {
        this.append('下载失败：响应无数据流（服务器未返回可下载内容）\n')
        this.finish(-1, '响应无数据流（服务器未返回可下载内容）')
        return
      }
      const declared = Number(res.headers.get('content-length') ?? NaN)
      this.totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null
      const fileStream = createWriteStream(this.dest)
      let streamErr: Error | null = null
      fileStream.on('error', (e: Error) => {
        streamErr = e
      })
      const reader = res.body.getReader()
      let lastChunkAt = Date.now()
      let speed = 0 // bytes/sec（指数移动平均）
      // 进度快照：200ms 节流写入缓冲 + 转发前台流式通道（下载中… X / Y（速度, pct%））
      const emit = (force = false): void => {
        const now = Date.now()
        if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return
        this.lastEmit = now
        const pct =
          this.totalBytes && this.downloadedBytes > 0
            ? `，${Math.round((this.downloadedBytes / this.totalBytes) * 100)}%`
            : ''
        const text = `下载中… ${formatBytes(this.downloadedBytes)} / ${
          this.totalBytes ? formatBytes(this.totalBytes) : '未知'
        }（${formatSpeed(speed)}${pct}）`
        this.append(`${text}\n`)
        this.onProgress?.({
          text,
          bytes: this.downloadedBytes,
          total: this.totalBytes,
          durationMs: Date.now() - start
        })
      }
      // 挂死检测：连接建立后长时间读不到新字节视为死链，强制中止
      stallTimer = setInterval(() => {
        if (Date.now() - lastChunkAt > STALL_TIMEOUT_MS) this.controller.abort()
      }, 5_000)
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
        this.downloadedBytes += value.byteLength
        emit()
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()))
      })
      if (streamErr) throw streamErr
      const pct = this.totalBytes
        ? `，${Math.round((this.downloadedBytes / this.totalBytes) * 100)}%`
        : ''
      this.append(`下载完成：${this.dest}（${formatBytes(this.downloadedBytes)}${pct}）\n`)
      this.finish(0)
    } catch (err) {
      const msg = this.controller.signal.aborted
        ? '已终止'
        : err instanceof Error
          ? err.message
          : '未知错误'
      this.append(`下载失败：${msg}\n`)
      this.finish(-1, msg)
    } finally {
      if (stallTimer) clearInterval(stallTimer)
    }
  }
}

/** 后台会话的只读快照（renderer「后台命令面板」展示用）。 */
export interface BackgroundSessionInfo {
  id: string
  command: string
  startedAt: number
  pid: number | undefined
  exited: boolean
  exitCode: number | null
  /** 退出时刻（未退出为 null）。 */
  exitedAt: number | null
  /** 已捕获输出字节数（UTF-8 字符数近似）。 */
  outputBytes: number
  /** 任务类型：shell 命令 / 后台下载（面板展示与 bash_output 状态头区分）。 */
  kind: 'shell' | 'download'
}

/** 会话注册表：默认持久会话（按 Agent 会话）+ 后台任务（shell/下载，LRU 淘汰）+ 全局清理。 */
class BashSessionManager {
  private defaults = new Map<string, PersistentShell>()
  private backgrounds = new Map<string, BackgroundShell | BackgroundDownload>()
  private bgLru: string[] = []
  /** 变更订阅（后台任务 启动/退出/终止 时回调），renderer 面板据此刷新。 */
  private listeners = new Set<() => void>()

  /** 获取/创建 Agent 会话的持久化 shell。 */
  getOrCreateDefault(sessionId: string): PersistentShell {
    let shell = this.defaults.get(sessionId)
    if (!shell) {
      shell = new PersistentShell(sessionId)
      this.defaults.set(sessionId, shell)
    }
    return shell
  }

  /** 启动一个后台命令会话，返回会话（含随机 sessionId）。 */
  startBackground(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): BackgroundShell {
    const id = randomUUID()
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      // stdin 保持管道：交互式命令可通过 bash_input 应答（无需应答的命令不受影响）
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // 退出/错误时回调：面板据状态变更刷新（startedAt 由 shell 内部记录）
    const shell = new BackgroundShell(id, child, command, () => this.#notify())
    this.#addBackground(shell)
    return shell
  }

  /** 启动一个后台下载任务，返回任务（含随机 sessionId）。onProgress 供前台模式转发流式进度。 */
  startDownload(
    url: string,
    dest: string,
    opts: { onProgress?: (info: DownloadProgressInfo) => void } = {}
  ): BackgroundDownload {
    const id = randomUUID()
    const task = new BackgroundDownload(id, url, dest, {
      onStateChange: () => this.#notify(),
      onProgress: opts.onProgress
    })
    this.#addBackground(task)
    return task
  }

  /** 注册后台任务：入表 + LRU 上限兜底（优先淘汰已退出的最久未读任务）+ 通知面板。 */
  #addBackground(task: BackgroundShell | BackgroundDownload): void {
    const id = task.sessionId
    this.backgrounds.set(id, task)
    this.bgLru.push(id)
    // 上限兜底：优先淘汰已退出的最久未读任务（全在运行时不动，避免杀用户长驻任务）
    if (this.backgrounds.size > MAX_BACKGROUND_SESSIONS) {
      for (const oldId of this.bgLru) {
        if (oldId === id) continue
        const old = this.backgrounds.get(oldId)
        if (old?.exited) {
          this.backgrounds.delete(oldId)
          this.bgLru.splice(this.bgLru.indexOf(oldId), 1)
          old.kill()
          break
        }
      }
    }
    this.#notify()
  }

  getBackground(id: string): BackgroundShell | BackgroundDownload | undefined {
    return this.backgrounds.get(id)
  }

  /** 后台 shell 会话（bash_input 写 stdin 用；下载任务无 stdin，返回 undefined）。 */
  getBackgroundShell(id: string): BackgroundShell | undefined {
    const task = this.backgrounds.get(id)
    return task?.kind === 'shell' ? task : undefined
  }

  /** 移除后台任务（仅已退出的任务可移除；运行中的请先终止）。 */
  removeBackground(id: string): { ok: boolean; error?: string } {
    const task = this.backgrounds.get(id)
    if (!task) return { ok: false, error: '后台任务不存在（可能已移除）' }
    if (!task.exited) return { ok: false, error: '任务仍在运行，请先终止再移除' }
    this.backgrounds.delete(id)
    const idx = this.bgLru.indexOf(id)
    if (idx >= 0) this.bgLru.splice(idx, 1)
    this.#notify()
    return { ok: true }
  }

  /** 订阅后台会话变更（返回取消订阅函数）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 全部后台会话快照（renderer 面板初始化/刷新用）。 */
  listBackground(): BackgroundSessionInfo[] {
    return [...this.backgrounds.values()].map((s) => s.info())
  }

  #notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** 应用退出：回收全部 shell 与后台进程。 */
  disposeAll(): void {
    for (const s of this.defaults.values()) s.dispose()
    for (const s of this.backgrounds.values()) s.kill()
    this.defaults.clear()
    this.backgrounds.clear()
    this.bgLru = []
  }
}

export const bashSessionManager = new BashSessionManager()
