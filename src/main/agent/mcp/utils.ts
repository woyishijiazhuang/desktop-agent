import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import { createLogger } from '../../utils/log'

const log = createLogger('mcp')

/** 带超时的 Promise（超时只判定失败，不取消底层操作）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 工具名前缀：server 名净化后 + 下划线，避免多 server 工具名冲突。 */
export function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 24)
  return cleaned || 'mcp'
}

/** MCP callTool 结果 → pi-ai content blocks。 */
export function mcpResultToContent(content: unknown): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = []
  if (Array.isArray(content)) {
    for (const item of content as Record<string, unknown>[]) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        out.push({ type: 'text', text: item.text })
      } else if (item?.type === 'image' && typeof item.data === 'string') {
        out.push({
          type: 'image',
          data: item.data,
          mimeType: (item.mimeType as string) ?? 'image/png'
        })
      } else if (item?.type === 'resource') {
        out.push({ type: 'text', text: JSON.stringify(item.resource ?? null) })
      }
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '（工具无输出）' })
  return out
}

// ---- stdio 子进程 PATH 解析 ----
//
// 打包后的 GUI 应用（macOS 从 Finder/Dock 启动、部分 Linux 桌面）不继承终端 shell 的
// PATH，只有 /usr/bin:/bin 等最小集合；而 npx/node 常装在 /opt/homebrew/bin、
// /usr/local/bin（Homebrew/官方安装包）或 ~/.nvm/versions/node/vX/bin（nvm，PATH
// 由 ~/.zshrc 交互注入），导致 spawn('npx') 报 ENOENT。dev 下从终端启动 PATH 完整，
// 故问题只在打包后出现。这里启动时一次性合并「登录 shell PATH + 常见 Node 安装目录
// + 当前进程 PATH」，缓存复用。

/** 登录 shell 输出 PATH 时包裹的标记（交互 shell 的 rc 脚本可能向 stdout 混入噪声，用标记截取）。 */
const PATH_MARK_BEGIN = '__MCP_PATH_BEGIN__'
const PATH_MARK_END = '__MCP_PATH_END__'

let cachedEnvPromise: Promise<Record<string, string>> | null = null

/** 探测用户登录 shell（-i 交互 + -l 登录）中的 PATH；失败返回空数组。异步执行，不阻塞主进程。 */
function shellPathDirs(): Promise<string[]> {
  if (process.platform === 'win32') return Promise.resolve([])
  const shell = process.env.SHELL
  if (!shell || !existsSync(shell)) return Promise.resolve([])
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (dirs: string[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(dirs)
    }
    // -i：加载 ~/.zshrc/~/.bashrc（nvm/fnm 多在此注入 PATH）；stderr 丢弃提示符/警告噪声。
    // ${PATH} 必须带花括号：否则 $PATH 与紧随的下划线标记连成一个变量名（PATH__...__），展开为空。
    const child = spawn(
      shell,
      ['-ilc', `printf '%s' "${PATH_MARK_BEGIN}\${PATH}${PATH_MARK_END}"`],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const timer = setTimeout(() => {
      log.warn('登录 shell PATH 探测超时，回退常见目录', { shell })
      child.kill()
      finish([])
    }, 8000)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('error', (err) => {
      log.warn('登录 shell PATH 探测失败，回退常见目录', {
        shell,
        error: err instanceof Error ? err.message : String(err)
      })
      finish([])
    })
    child.on('close', (code) => {
      if (code !== 0) {
        log.warn('登录 shell PATH 探测失败，回退常见目录', { shell, error: `exit ${code}` })
        finish([])
        return
      }
      const matched = stdout.match(new RegExp(`${PATH_MARK_BEGIN}([\\s\\S]*)${PATH_MARK_END}`))
      if (!matched) {
        finish([])
        return
      }
      // PATH 本身不含换行/冒号以外的空白；取标记间内容按分隔符拆，过滤异常片段
      finish(
        matched[1]
          .split(':')
          .map((d) => d.trim())
          .filter((d) => d && !d.includes('\n') && !d.includes('\r'))
      )
    })
  })
}

/** 不依赖 shell 配置的常见 Node/包管理器安装目录（存在才保留）。 */
function staticPathDirs(): string[] {
  const home = homedir()
  const dirs: string[] = []
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    dirs.push(
      join(programFiles, 'nodejs'),
      join(programFilesX86, 'nodejs'),
      join(localAppData, 'Volta', 'bin'),
      join(appData, 'npm')
    )
    // nvm-windows
    if (process.env.NVM_SYMLINK) dirs.push(process.env.NVM_SYMLINK)
    if (process.env.NVM_HOME) dirs.push(process.env.NVM_HOME)
    return dirs
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'bin'),
    join(home, '.nix-profile', 'bin'),
    '/run/current-system/sw/bin'
  )
  // nvm：~/.nvm/versions/node/<version>/bin（每个已装版本一条）
  pushVersionBinDirs(dirs, join(home, '.nvm', 'versions', 'node'), (v) =>
    join(home, '.nvm', 'versions', 'node', v, 'bin')
  )
  // fnm：~/.local/share/fnm/node-versions/<version>/installation/bin
  pushVersionBinDirs(dirs, join(home, '.local', 'share', 'fnm', 'node-versions'), (v) =>
    join(home, '.local', 'share', 'fnm', 'node-versions', v, 'installation', 'bin')
  )
  return dirs
}

/** 列出 <root>/<version> 形式目录并映射出 bin 路径（nvm/fnm 版本目录通用）。 */
function pushVersionBinDirs(
  dirs: string[],
  root: string,
  toBin: (version: string) => string
): void {
  try {
    if (!existsSync(root)) return
    for (const version of readdirSync(root)) {
      const bin = toBin(version)
      if (existsSync(bin)) dirs.push(bin)
    }
  } catch {
    // 目录不可读时忽略
  }
}

/**
 * 构造 stdio MCP server 子进程环境：在默认环境之上提供增强 PATH。
 * 解析只做一次、并发调用共享同一 Promise（用户安装位置不会在运行期间变化）；
 * server 行内自定义 env 合并在后，用户显式设置的 PATH 拥有最高优先级。
 */
export function buildMcpSpawnEnv(userEnv: Record<string, string>): Promise<Record<string, string>> {
  if (!cachedEnvPromise) {
    cachedEnvPromise = (async () => {
      const sep = process.platform === 'win32' ? ';' : ':'
      const currentPath = (process.env.PATH ?? '')
        .split(sep)
        .map((d) => d.trim())
        .filter(Boolean)
      // shell 探测目录优先（尊重用户 nvm 当前版本等选择），静态目录与现有 PATH 兜底
      const candidates = [...(await shellPathDirs()), ...staticPathDirs(), ...currentPath]
      const seen = new Set<string>()
      const resolved: string[] = []
      for (const dir of candidates) {
        if (seen.has(dir)) continue
        if (!existsSync(dir)) continue
        seen.add(dir)
        resolved.push(dir)
      }
      log.info('MCP stdio 子进程 PATH 已解析', { dirCount: resolved.length, dirs: resolved })
      return { PATH: resolved.join(sep) }
    })()
    // 探测异常不固化失败态：置空后下次连接重新探测
    cachedEnvPromise.catch(() => {
      cachedEnvPromise = null
    })
  }
  return cachedEnvPromise.then((base) => ({ ...base, ...userEnv }))
}
