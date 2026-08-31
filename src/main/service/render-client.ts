import type { IpcRendererServices } from '@renderer/service'
import {
  broadcastToViews,
  sendToAppWindow,
  sendToWorkspace,
  getWorkspaceWindows,
  type AppWindow,
  type ViewTarget
} from './window-manager'
import { resolveSessionWorkdir } from '../agent/workdir'

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
  // 设置 tab 导航只由内容视图消费（标题栏视图未注册 settingsTab 方法）
  'ui.settingsTab': 'content',
  // 设置变更只由内容视图消费（标题栏视图仅注册 ui 服务）
  'settingsSync.settingChanged': 'content',
  // agent 事件只由内容视图消费
  'agentEvent.onEvent': 'content',
  'agentEvent.onSessionUpdate': 'content',
  'agentEvent.onPermissionRequest': 'content',
  'agentEvent.onPlanRequest': 'content',
  'agentEvent.onPlanProgress': 'content',
  'agentEvent.onAskUserRequest': 'content',
  'agentEvent.onBackgroundSessions': 'content'
}

function resolveViewTarget(service: string, method: string): ViewTarget {
  return VIEW_ROUTES[`${service}.${method}`] ?? 'all'
}

/**
 * 主进程 → 渲染进程的 IPC 客户端工厂。
 * electron-ipc-service 的 createIpcMainClient 依赖 BrowserWindow.getAllWindows()，
 * BaseWindow 迁移后不可用，这里以相同 API 形状自建实现：
 * 消息按路由表由 deliver 投递（fire-and-forget）。
 */
function createMainClient<T extends object>(
  deliver: (service: string, method: string, args: unknown[]) => void
): T {
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
                deliver(service, method as string, args)
              }
          }
        )
        serviceCache.set(service, serviceProxy)
      }
      return serviceProxy
    }
  })
}

/** 从事件载荷提取会话 id：agent 事件载荷多为 { sessionId, ... } 或会话对象（{ id, ... }）。 */
function extractSessionId(args: unknown[]): string | undefined {
  const first = args[0]
  if (!first || typeof first !== 'object') return undefined
  const obj = first as { sessionId?: unknown; id?: unknown }
  const id = obj.sessionId ?? obj.id
  return typeof id === 'string' ? id : undefined
}

/** 后台命令快照按工作区过滤后投递给对应窗口（设置窗口无该 UI，跳过）。 */
function deliverBackgroundSessions(channel: string, args: unknown[]): void {
  const list = (args[0] as { sessionId: string }[] | undefined) ?? []
  for (const aw of getWorkspaceWindows()) {
    const filtered = list.filter((item) => resolveSessionWorkdir(item.sessionId) === aw.workdir)
    sendToAppWindow(
      aw,
      channel,
      { service: 'agentEvent', method: 'onBackgroundSessions', args: [filtered] },
      'content'
    )
  }
}

/** 广播到全部应用窗口（主题/全局设置变更等全局事件）。 */
export const rendererClient = createMainClient<IpcRendererServices>((service, method, args) => {
  const target = resolveViewTarget(service, method)
  const channel = IPC_RENDERER_SERVICE_CHANNEL
  if (service === 'agentEvent') {
    // agent 事件按会话归属工作区定向投递，避免广播到其他工作区窗口
    if (method === 'onBackgroundSessions') {
      deliverBackgroundSessions(channel, args)
      return
    }
    const sessionId = extractSessionId(args)
    if (sessionId) {
      const workdir = resolveSessionWorkdir(sessionId)
      if (workdir) {
        sendToWorkspace(workdir, channel, { service, method, args }, target)
        return
      }
    }
  }
  broadcastToViews(channel, { service, method, args }, target)
})

/** 定向发送到指定应用窗口（窗口状态同步、托盘动作等按窗口分发的场景）。 */
export function rendererClientFor(aw: AppWindow): IpcRendererServices {
  return createMainClient<IpcRendererServices>((service, method, args) => {
    const target = resolveViewTarget(service, method)
    sendToAppWindow(aw, IPC_RENDERER_SERVICE_CHANNEL, { service, method, args }, target)
  })
}

/** 定向发送到指定工作区的窗口（agent 事件按会话归属工作区投递）。 */
export function rendererClientForWorkspace(workdir: string): IpcRendererServices {
  return createMainClient<IpcRendererServices>((service, method, args) => {
    const target = resolveViewTarget(service, method)
    sendToWorkspace(workdir, IPC_RENDERER_SERVICE_CHANNEL, { service, method, args }, target)
  })
}
