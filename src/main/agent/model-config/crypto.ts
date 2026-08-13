import { safeStorage } from 'electron'
import { db } from '../../database'
import { createLogger } from '../../utils/log'

const log = createLogger('modelConfig')

/** 读取并解密某 config 的 API key。无 key 抛错。 */
export function getDecryptedApiKey(configId: string): string {
  const encrypted = db.getModelConfigApiKey(configId)
  if (!encrypted) throw new Error(`未找到模型配置 ${configId} 的 API key`)
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage 不可用），无法解密 API key')
  }
  return safeStorage.decryptString(Buffer.from(encrypted))
}

/** 加密并存储某 config 的 API key。 */
export function setConfigApiKey(configId: string, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage 不可用），无法加密 API key')
  }
  const encrypted = safeStorage.encryptString(key)
  db.upsertModelConfigApiKey(configId, Buffer.from(encrypted))
  log.info('已设置模型 API key', { configId })
}

/** 清除某 config 的 API key。 */
export function clearConfigApiKey(configId: string): void {
  db.upsertModelConfigApiKey(configId, null)
  log.info('已清除模型 API key', { configId })
}
