import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import picomatch from 'picomatch'

/**
 * glob / grep 工具共享的文件系统遍历辅助。
 * 独立成模块是因为两个工具需要完全一致的忽略规则与 glob 语义。
 */

/**
 * 遍历时跳过的目录名（依赖目录 / 构建产物 / VCS 元数据等），对齐 ripgrep 默认忽略项。
 * node_modules 与 .git 是搜索噪声与性能黑洞的主要来源。
 */
export const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'out',
  'build',
  'release',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode'
])

/**
 * 创建 glob 匹配器（picomatch，成熟实现，语义对齐 ripgrep / gitignore）：
 * - `dot: false`（默认）：`*`/`**`/`?` 通配符不匹配以 `.` 开头的隐藏文件/目录段，
 *   除非模式里显式写了点号（如 `.*`、`.env*`）
 * - 不含 `/` 的模式（如 `*.ts`、`*.{ts,js}`）按任意深度的文件名匹配（matchBase），
 *   与 ripgrep `-g` 语义一致；含 `/` 的模式按相对路径全匹配
 * 注意：picomatch 的 matchBase 只应作用于无 `/` 的模式——对含 `/` 的模式开启反而会
 * 让全部路径匹配失败，故按模式动态决定。
 * @param pattern glob 模式
 * @returns 匹配函数（入参为以 / 分隔的相对路径）
 */
export function createGlobMatcher(pattern: string): (path: string) => boolean {
  // 归一化：去掉 ./ 与 / 前缀，Windows 分隔符统一为 /
  const normalized = pattern.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/')
  return picomatch(normalized, {
    dot: false,
    matchBase: !normalized.includes('/'),
    windows: false
  })
}

/** 相对路径统一为 / 分隔，供 glob 匹配与展示。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export interface WalkResult {
  /** 文件绝对路径列表（不含目录本身）。 */
  files: string[]
  /** 是否因达到 maxEntries 上限而提前截断。 */
  truncated: boolean
}

/**
 * 递归遍历目录收集全部文件（跳过 IGNORE_DIRS 与隐藏目录，含隐藏文件本身）。
 * 上限 maxEntries 防止超大目录（如用户主目录）遍历失控，超出即停止并标记 truncated。
 * 单个目录读取失败（权限等）跳过该目录，不中断整体遍历。
 * 隐藏目录（以 . 开头）不遍历，对齐 ripgrep / Claude Code Glob 默认语义；
 * 隐藏文件仍会列出（是否匹配由模式决定，picomatch dot:false 默认不匹配）。
 */
export async function walkFiles(root: string, maxEntries: number): Promise<WalkResult> {
  const files: string[] = []
  let truncated = false
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
    if (!entries) continue
    for (const e of entries) {
      if (files.length >= maxEntries) {
        truncated = true
        return { files, truncated }
      }
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !IGNORE_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) {
        files.push(full)
      }
      // 符号链接等其他类型跳过，避免成环
    }
  }
  return { files, truncated }
}
