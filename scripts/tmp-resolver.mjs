// 临时测试辅助：拦截 electron-log 依赖 + 相对导入补 .ts（仅测试用，验证后删除）
import { pathToFileURL } from 'node:url'

const STUB = pathToFileURL(new URL('./tmp-log-stub.mjs', import.meta.url).pathname).href

export async function resolve(specifier, context, next) {
  if (specifier === 'electron-log/main') {
    return { url: STUB, format: 'module', shortCircuit: true }
  }
  try {
    return await next(specifier, context)
  } catch (err) {
    if (
      err?.code === 'ERR_MODULE_NOT_FOUND' &&
      !specifier.startsWith('node:') &&
      (specifier.startsWith('.') || specifier.startsWith('/'))
    ) {
      try {
        return await next(`${specifier}.ts`, context)
      } catch {
        throw err
      }
    }
    throw err
  }
}
