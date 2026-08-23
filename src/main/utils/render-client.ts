import type { IpcRendererServices } from '@renderer/service'
import { sendToViews, type ViewTarget } from '../service/window-manager'

/**
 * 与 electron-ipc-service 的 renderer 侧约定的推送通道常量。
 * 库未导出该常量（package.json exports 仅含 . /preload /renderer），故在此本地定义。
 * 见 node_modules/electron-ipc-service/dist/constants.js。
 */
const IPC_RENDERER_SERVICE_CHANNEL = '__ELECTRON_IPC_SERVICE_RENDERER_SERVICE_CHANNEL__'

/**
 * 视图路由表：哪些 service.method 需要发给哪个视图。
 * - 'all'    标题栏 + 内容视图（默认）
 * - 'header' 仅标题栏（窗口状态同步等）
 * - 'content' 仅内容视图（toast / agent 事件等）
 *
 * 未列出的 method 默认走 'all'，保持向后兼容。
 */
const VIEW_ROUTES: Record<string, ViewTarget> = {
  // 标题栏只消费窗口状态
  'ui.windowStateChange': 'all',
  // toast / 托盘动作只由内容视图处理
  'ui.showToast': 'content',
  'ui.trayAction': 'content',
  // agent 事件只由内容视图消费
  'agentEvent.onEvent': 'content',
  'agentEvent.onSessionUpdate': 'content',
  'agentEvent.onPermissionRequest': 'content',
  'agentEvent.onPlanRequest': 'content'
}

function resolveViewTarget(service: string, method: string): ViewTarget {
  return VIEW_ROUTES[`${service}.${method}`] ?? 'all'
}

/**
 * 主进程 → 渲染进程的 IPC 客户端。
 * electron-ipc-service 的 createIpcMainClient 依赖 BrowserWindow.getAllWindows()，
 * BaseWindow 迁移后不可用，这里以相同 API 形状自建实现：
 * 消息按路由表发送到需要它的视图（fire-and-forget）。
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
                const target = resolveViewTarget(service, method as string)
                sendToViews(IPC_RENDERER_SERVICE_CHANNEL, { service, method, args }, target)
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
