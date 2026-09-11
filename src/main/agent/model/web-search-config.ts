import { db } from '../database'
import { createLogger } from '../utils/log'
import { encryptSecret, decryptSecret } from '../utils/safe-key'

const log = createLogger('webSearch')

/**
 * Tavily Web Search API Key 的加密存取。
 * 与模型配置的 key 一致：safeStorage 加密后以 base64 存入 settings 表，明文永不落库、
 * 永不通过 IPC 回传渲染进程（渲染层只读 hasWebSearchApiKey 的布尔状态）。
 */

/** settings 表中存储 Tavily API Key 的 key。 */
export const SETTING_WEB_SEARCH_API_KEY = 'webSearchApiKey'

/** 是否已配置 Tavily API Key（renderer 状态展示用）。 */
export function hasWebSearchApiKey(): boolean {
  return !!db.getSetting<string>(SETTING_WEB_SEARCH_API_KEY)
}

/** 解密并返回 Tavily API Key。未配置时抛错，引导用户先去设置中配置。 */
export function getWebSearchApiKey(): string {
  const b64 = db.getSetting<string>(SETTING_WEB_SEARCH_API_KEY)
  if (!b64) throw new Error('未配置 Tavily API Key，请先在「设置 → 工具」中配置')
  return decryptSecret(Buffer.from(b64, 'base64'))
}

/** 加密并保存 Tavily API Key（覆盖旧值）。 */
export function setWebSearchApiKeyConfig(key: string): void {
  db.setSetting(SETTING_WEB_SEARCH_API_KEY, encryptSecret(key).toString('base64'))
  log.info('已保存 Tavily API Key')
}

/** 清除 Tavily API Key。 */
export function clearWebSearchApiKeyConfig(): void {
  db.deleteSetting(SETTING_WEB_SEARCH_API_KEY)
  log.info('已清除 Tavily API Key')
}
