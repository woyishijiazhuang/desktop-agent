import type { IpcRendererServices } from '@renderer/service'
import { broadcastToAllViews } from '../service/window-manager'

/**
 * 与 electron-ipc-service 的 renderer 侧约定的推送通道常量。
 * 库未导出该常量（package.json exports 仅含 . /preload /renderer），故在此本地定义。
 * 见 node_modules/electron-ipc-service/dist/constants.js。
 */
const IPC_RENDERER_SERVICE_CHANNEL = '__ELECTRON_IPC_SERVICE_RENDERER_SERVICE_CHANNEL__'

/**
 * 主进程 → 渲染进程的广播客户端。
 * electron-ipc-service 的 createIpcMainClient 依赖 BrowserWindow.getAllWindows()，
 * BaseWindow 迁移后不可用，这里以相同 API 形状自建实现：
 * 消息广播到本应用全部视图（标题栏 view + 内容 view）的 webContents（fire-and-forget）。
 */
function createMainClient<T extends object>(): T {
  const serviceCache = new Map<string, unknown>()
  return new Proxy({} as T, {
    get(_target, service: string) {
      let serviceProxy = serviceCache.get(service)
      if (!serviceProxy) {
        serviceProxy = new Proxy(
          {},
          {
            get:
              (_serviceTarget, method: string) =>
              (...args: unknown[]) => {
                broadcastToAllViews(IPC_RENDERER_SERVICE_CHANNEL, { service, method, args })
              }
          }
        )
        serviceCache.set(service, serviceProxy)
      }
      return serviceProxy
    }
  })
}

export const rendererClient = createMainClient<IpcRendererServices>()
