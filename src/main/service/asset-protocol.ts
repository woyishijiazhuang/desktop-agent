import { app, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../utils/log'

const log = createLogger('asset')

/**
 * 渲染进程静态资源协议（appasset://）。
 *
 * 语音 VAD 的 Silero onnx 模型与 onnxruntime-web 的 wasm 运行时要被渲染进程 fetch，
 * 而生产环境窗口经 file:// 加载，Chromium 禁止 fetch file:// 资源（AudioWorklet.addModule
 * 也受同源限制）——故注册自定义 standard scheme，从 node_modules 直接读文件返回。
 * dev 与打包后均可用：app.getAppPath() 在打包态指向 asar，fs.readFile 对 asar 透明。
 *
 * 路由：
 *   appasset://voice/<file>        → node_modules/@ricky0123/vad-web/dist/<file>（onnx 模型等）
 *   appasset://voice/ort/<file>    → node_modules/onnxruntime-web/dist/<file>（ort wasm）
 */
const SCHEME = 'appasset'

const VAD_WEB_DIR = '@ricky0123/vad-web/dist'
const ORT_WEB_DIR = 'onnxruntime-web/dist'

const MIME_BY_EXT: Record<string, string> = {
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript'
}

/** appasset:// 与文档（dev http://localhost / 打包 file://）非同源：
 * onnx 模型 fetch、ort wasm fetch、ort 胶水 .mjs 的模块动态 import 均走 CORS 校验，
 * 必须回 ACAO 头放行跨源读取（配合 registerSchemesAsPrivileged 的 corsEnabled）。 */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' }

/** 必须在 app ready 之前调用（protocol.registerSchemesAsPrivileged 前置要求）。 */
export function registerVoiceAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** app ready 之后安装协议处理器。 */
export function installVoiceAssetProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // URL 形如 appasset://voice/ort/xxx.wasm：'voice' 是 host，pathname 是 /ort/xxx.wasm。
      // 用 hostname + pathname 还原虚拟路径 voice/ort/xxx.wasm 后再路由。
      const host = url.hostname
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const virtual = host ? `${host}/${path}` : path
      const rel = resolveNodeModuleRel(virtual)
      if (!rel) {
        log.warn('appasset 未知路径', { url: request.url, virtual })
        return new Response('not found', { status: 404 })
      }
      const filePath = join(app.getAppPath(), 'node_modules', rel)
      const data = await readFile(filePath)
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      return new Response(data, {
        headers: { 'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream', ...CORS_HEADERS }
      })
    } catch (err) {
      log.warn('appasset 读取失败', {
        url: request.url,
        error: err instanceof Error ? err.message : String(err)
      })
      return new Response('not found', { status: 404 })
    }
  })
}

/** 虚拟路径 → node_modules 相对路径；未知路径返回 null。 */
function resolveNodeModuleRel(pathname: string): string | null {
  // voice/ort/<file> → onnxruntime-web/dist/<file>
  if (pathname.startsWith('voice/ort/')) {
    const file = pathname.slice('voice/ort/'.length)
    if (!file || file.includes('/') || file.includes('..')) return null
    // ort 可能请求 dist 中不存在的变体名（如非 threaded 版）；统一回退到
    // 唯一存在的 ort-wasm-simd-threaded.wasm（线程由运行时开关控制，二进制通用）。
    if (file.endsWith('.wasm') && file !== 'ort-wasm-simd-threaded.wasm') {
      return join(ORT_WEB_DIR, 'ort-wasm-simd-threaded.wasm')
    }
    return join(ORT_WEB_DIR, file)
  }
  // voice/<file> → @ricky0123/vad-web/dist/<file>
  if (pathname.startsWith('voice/')) {
    const file = pathname.slice('voice/'.length)
    if (!file || file.includes('/') || file.includes('..')) return null
    return join(VAD_WEB_DIR, file)
  }
  return null
}
