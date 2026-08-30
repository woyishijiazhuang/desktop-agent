import { safeStorage } from 'electron'

/**
 * safeStorage 加解密统一封装（模型 API key / Tavily key 等机密存取共用）。
 * 明文仅在内存中存在，永不落库；落库形态由调用方决定（字节列或 base64 字符串）。
 */

/** 校验系统安全存储可用，不可用时抛出引导性错误。 */
function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage 不可用），无法加解密 API key')
  }
}

/** safeStorage 加密，返回加密字节。 */
export function encryptSecret(plain: string): Buffer {
  assertEncryptionAvailable()
  return Buffer.from(safeStorage.encryptString(plain))
}

/** safeStorage 解密（输入为 encryptSecret 的返回字节）。 */
export function decryptSecret(encrypted: Uint8Array): string {
  assertEncryptionAvailable()
  return safeStorage.decryptString(Buffer.from(encrypted))
}
