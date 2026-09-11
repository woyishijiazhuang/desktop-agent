/**
 * 把模型配置流程里的底层错误转换为面向用户的中文提示。
 *
 * 底层错误来源有两类：
 * - 在线拉取模型（preset-catalog.ts）自造的 `HTTP 401 Unauthorized`；
 * - 测试连接（test.ts）透传的服务商 SDK 英文报错（如 `401 {"error":...}`）。
 * 两者都不适合直接弹给用户，这里按 HTTP 状态码 / 关键词映射为可读中文。
 */

/** 鉴权失败：401/403 或服务商返回的鉴权类关键词。 */
const AUTH_PATTERN =
  /\b(?:401|403)\b|unauthorized|forbidden|invalid[ _-]?(?:api[ _-]?key|x-api-key)|incorrect[ _-]?api[ _-]?key|api[ _-]?key[ _-]?(?:invalid|not[ _-]?valid|incorrect)|authentication[ _-]?(?:error|fails|failed)|no[ _-]?api[ _-]?key/i

/** 地址/路径错误。 */
const NOT_FOUND_PATTERN = /\b404\b|not found/i

/** 限流 / 额度不足。 */
const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests/i

/** 网络层失败（含超时、被中止）。 */
const NETWORK_PATTERN =
  /fetch failed|enotfound|econnrefused|econnreset|etimedout|eai_again|network|socket hang up|timed? ?out|timeout|aborted/i

export function toFriendlyModelError(raw: string | undefined | null): string {
  const text = (raw ?? '').trim()
  if (!text) return '连接失败，请稍后重试。'
  if (AUTH_PATTERN.test(text)) return 'API Key 无效或已过期，请检查后重新输入。'
  if (NOT_FOUND_PATTERN.test(text)) return '接口地址不存在（404），请检查 Base URL 是否正确。'
  if (RATE_LIMIT_PATTERN.test(text)) return '请求过于频繁或额度不足（429），请稍后重试。'
  if (NETWORK_PATTERN.test(text)) return '网络连接失败或超时，请检查网络、代理与请求地址。'
  return text
}
