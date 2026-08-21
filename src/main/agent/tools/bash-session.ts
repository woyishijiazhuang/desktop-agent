import { spawn, type ChildProcess } from 'node:child_process'
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

/** 命令完成哨兵（bash printf 输出，格式固定便于正则匹配）。 */
const SENTINEL_RE = /^__PI_BASH_DONE_([0-9a-f-]{36})__:(-?\d+)\r?$/
function sentinelCmd(id: string): string {
  return `printf '__PI_BASH_DONE_${id}__:%d\\n' "$?"`
}

/** shell 单引号转义（cwd 参数 cd 用）。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
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
    const child = spawn('bash', ['--noprofile', '--norc', '-s'], {
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
      log.error('持久 shell 启动失败', { sessionId: this.sessionId, error: err.message })
      this.failAll(`shell 启动失败: ${err.message}`)
    })
    child.on('close', (code) => {
      if (this.child !== child) return // 已被新 shell 取代（超时/中止后重建），忽略旧 close
      this.childClosed = true
      log.warn('持久 shell 退出', { sessionId: this.sessionId, exitCode: code })
      this.failAll(`shell 会话已退出（exitCode=${code}），可重试或新建会话`)
    })
    log.info('持久 shell 已启动', { sessionId: this.sessionId, cwd })
    return child
  }

  /** 执行一条命令（阻塞）：写入 stdin + 哨兵，等待哨兵返回输出与退出码。 */
  async run(command: string, opts: ShellRunOptions = {}): Promise<ShellRunResult> {
    const cwd = opts.cwd ?? ''
    const child = this.ensureStarted(opts.env ?? {}, cwd)
    // cwd 显式指定时先 cd（失败即退出码 1），保证参数权威且与旧版按 cwd 启动语义一致
    const effective = cwd ? `cd ${shellQuote(cwd)} || exit 1\n${command}` : command
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
        child.stdin!.write(`${effective}\n${sentinelCmd(id)}\n`)
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
        ? `\n[命令执行超时（${timeoutMs}ms），已中断；长驻命令请改用 background=true；会话已重置]`
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

/** 单次后台命令会话：独立进程组，输出缓冲，可读取/终止。 */
export class BackgroundShell {
  readonly sessionId: string
  private child: ChildProcess
  private outputBuf = ''
  private tailOffset = 0
  exited = false
  exitCode: number | null = null
  errorMessage?: string

  constructor(sessionId: string, child: ChildProcess) {
    this.sessionId = sessionId
    this.child = child
    // stdio 配置为 ['ignore', 'pipe', 'pipe']，stdout/stderr 必为可读流
    const stdout = child.stdout!
    const stderr = child.stderr!
    stdout.setEncoding('utf-8')
    stderr.setEncoding('utf-8')
    stdout.on('data', (chunk: string) => this.append(chunk))
    stderr.on('data', (chunk: string) => this.append(chunk))
    child.on('error', (err) => {
      this.errorMessage = err.message
      this.exited = true
      this.exitCode = -1
    })
    child.on('close', (code) => {
      this.exited = true
      this.exitCode = code
    })
  }

  private append(chunk: string): void {
    this.outputBuf += chunk
    if (this.outputBuf.length > MAX_SESSION_OUTPUT) {
      const drop = this.outputBuf.length - MAX_SESSION_OUTPUT
      this.outputBuf = this.outputBuf.slice(drop)
      this.tailOffset = Math.max(0, this.tailOffset - drop)
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

/** 会话注册表：默认持久会话（按 Agent 会话）+ 后台会话（LRU 淘汰）+ 全局清理。 */
class BashSessionManager {
  private defaults = new Map<string, PersistentShell>()
  private backgrounds = new Map<string, BackgroundShell>()
  private bgLru: string[] = []

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
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const shell = new BackgroundShell(id, child)
    this.backgrounds.set(id, shell)
    this.bgLru.push(id)
    // 上限兜底：优先淘汰已退出的最久未读会话
    if (this.backgrounds.size > MAX_BACKGROUND_SESSIONS) {
      for (const oldId of this.bgLru) {
        if (oldId === id) continue
        const old = this.backgrounds.get(oldId)
        if (old?.exited) {
          this.backgrounds.delete(oldId)
          old.kill()
          break
        }
      }
    }
    return shell
  }

  getBackground(id: string): BackgroundShell | undefined {
    return this.backgrounds.get(id)
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
