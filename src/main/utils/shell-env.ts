import { spawn } from 'node:child_process'
import { createLogger } from './log'

const log = createLogger('shell-env')

/** 抓取超时（ms）：rc 文件里若有慢初始化（如 nvm 版本检查）超时即放弃，回退 process.env。 */
const CAPTURE_TIMEOUT_MS = 4000
/** 输出上限（字符）：防止 rc 文件打印海量内容撑爆内存。 */
const MAX_OUTPUT = 64 * 1024

let cached: Promise<Record<string, string>> | null = null

/**
 * 抓取用户 shell 环境：source rc 文件后 dump env，合并进 bash 子进程环境，
 * 解决打包应用从 Dock/Finder 启动时丢失 .zshrc/.bashrc 环境变量的问题
 * （spawn(shell:true) 不会 source 任何 rc 文件，只继承主进程启动时的极简环境）。
 * - 仅首次调用真正执行，结果缓存到本次进程生命周期。
 * - 平台：darwin 用 zsh（source ~/.zshrc）；linux 用 bash（source ~/.bashrc）；win32 跳过。
 * - 失败/超时返回 {}，子进程仍可用 process.env，不影响功能。
 * - 注：source rc 会执行用户自己的 shell 配置（与用户手动开终端等价），属常规做法。
 */
export function getShellEnv(): Promise<Record<string, string>> {
  if (!cached) cached = captureSafely()
  return cached
}

/**
 * 重新抓取 shell 环境并更新缓存：用户修改 .zshrc/.bashrc 后无需重启应用即可生效。
 * 返回本次抓取到的环境（调用方可用于展示变量数）；失败时缓存为 {} 并返回 {}。
 */
export function refreshShellEnv(): Promise<Record<string, string>> {
  cached = captureSafely()
  return cached
}

function captureSafely(): Promise<Record<string, string>> {
  return captureShellEnv().catch((err) => {
    log.warn('抓取 shell 环境失败，回退到 process.env', {
      error: err instanceof Error ? err.message : String(err)
    })
    return {}
  })
}

function captureShellEnv(): Promise<Record<string, string>> {
  const platform = process.platform
  if (platform === 'win32') return Promise.resolve({})
  const shell = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  // source 自身输出重定向到 /dev/null（rc 里常有 echo/别名等噪音），只取最后 env 的 dump。
  // rc 文件名按平台取 .zshrc / .bashrc；zsh 非交互 source .zshrc 是安全的（只执行 export 等）。
  const rc = platform === 'darwin' ? '$HOME/.zshrc' : '$HOME/.bashrc'
  const script = `source ${rc} >/dev/null 2>&1; env`
  return new Promise((resolve) => {
    const child = spawn(shell, ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf-8')
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT)
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf-8')
      if (err.length > MAX_OUTPUT) err = err.slice(0, MAX_OUTPUT)
    })
    const timer = setTimeout(() => {
      log.warn('shell 环境抓取超时，已终止', { platform, timeoutMs: CAPTURE_TIMEOUT_MS })
      child.kill('SIGKILL')
    }, CAPTURE_TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({})
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (err) log.debug('shell 环境抓取 stderr', { err: err.slice(0, 500) })
      resolve(parseEnvOutput(out))
    })
  })
}

/** 解析 `env` 输出：仅保留合法 KEY=VALUE 行，跳过函数定义等噪音。 */
function parseEnvOutput(out: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of out.split('\n')) {
    // bash 会把导出的函数以 `name=() { ... }` / `BASH_FUNC_name%%=...` 形式写入环境，跳过
    if (line.includes('()')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = line.slice(idx + 1)
  }
  return env
}
