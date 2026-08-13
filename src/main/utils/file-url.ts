import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 把 file:// URL 解码为本地路径。
 * - file:///Users/foo/bar%20baz → /Users/foo/bar baz
 * - file://~/foo → ~/foo → 展开为 /Users/<当前用户>/foo（非标准写法兼容）
 * 非 file 协议或解析失败返回 null。
 */
export function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    // file://~/... 的 hostname 是 "~"，路径要拼回 ~ 前缀
    let path = parsed.hostname === '~' ? `~${parsed.pathname}` : parsed.pathname
    path = decodeURIComponent(path)
    // 兼容 file://~/foo 写法：展开为用户主目录
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
    return path || null
  } catch {
    // 非标准 URL（如部分 shell 拼出的 file://~/...），手动剥协议前缀
    const rest = url.slice('file://'.length)
    return rest ? decodeURIComponent(rest) : null
  }
}
