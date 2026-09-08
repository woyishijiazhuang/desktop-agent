import type { IpcService, IpcServiceConstructor, IpcServices } from 'electron-ipc-service/renderer'

/**
 * 渲染层推送注册的容错守卫（替代库的 initializeIpcRendererServices）。
 *
 * 背景：拆出独立设置入口后会出现多种内容视图（工作区=全量、设置=子集），
 * 库的 dispatcher（electron-ipc-service/dist/renderer.js）收到未注册 service/method
 * 的消息会直接 `services[service][method](...)` 抛 TypeError 崩页面。本模块与其同构
 * 构建 services 映射、自写 dispatcher：方法不存在时 console.warn 后忽略，把「能力表」
 * 从正确性来源降级为精准投递优化——任何未来路由/能力配置漂移都不会再崩渲染层。
 *
 * 常量镜像：库未导出 IPC_RENDERER_SERVICE_FN（package.json exports 仅含
 * . /preload /renderer，见 node_modules/electron-ipc-service/dist/constants.js），
 * 与 render-client 中 channel 常量的本地定义处理一致。
 */
const IPC_RENDERER_SERVICE_FN = '__ELECTRON_IPC_SERVICE_RENDERER_SERVICE_FN__'

/** preload 转发到 callback 的消息形状（见 electron-ipc-service/dist/preload.js）。 */
interface RendererServiceMessage {
  service: string
  method: string
  args: unknown[]
}

/** 与库同构的 services 映射构建（namespace 判重等校验保持一致）。 */
function createSafeIpcRendererServices<T extends readonly IpcServiceConstructor[]>(
  Services: T
): IpcServices<T> {
  const services = {} as IpcServices<T>
  const registry = services as Record<string, IpcService>
  for (const Service of Services) {
    const namespace = Service.namespace
    if (!namespace) throw new Error('IpcService namespace is required.')
    if (registry[namespace]) {
      throw new Error(`Found duplicate IpcService namespace: ${namespace}`)
    }
    registry[namespace] = new Service()
  }
  return services
}

/**
 * 与库的 initializeIpcRendererServices 同签名/同返回值形状注册渲染层接收服务，
 * 仅把「未注册即抛错」替换为「warn 后忽略」。返回映射的形状与库一致，
 * 故 `ipcRendererServices` / `IpcRendererServices` 的类型推导保持不变，
 * main 侧的类型引用零改动。
 */
export function initializeSafeRendererServices<T extends readonly IpcServiceConstructor[]>(
  Services: T
): IpcServices<T> {
  const services = createSafeIpcRendererServices(Services)
  const register = (window as unknown as Record<string, unknown>)[IPC_RENDERER_SERVICE_FN] as
    ((cb: (message: RendererServiceMessage) => void) => void) | undefined
  if (!register) {
    throw new Error(
      'IPC channel is not available. Make sure to call `initializeIpcPreload()` in the preload script.'
    )
  }
  register((message) => {
    const serviceObj = (services as Record<string, Record<string, unknown>>)[message.service]
    const fn = serviceObj?.[message.method]
    if (typeof fn !== 'function') {
      // main 推送了本视图未注册的调用：能力配置漂移时降级为告警忽略，不崩页面
      console.warn(`[ipc] main 推送了本视图未注册的调用: ${message.service}.${message.method}`)
      return
    }
    // 必须以成员调用方式保 this：直接 `fn(...)` 会让方法体里 this 为 undefined，
    // 触及私有状态（如 AgentEventService 的 #bufferUpdate/#flushUpdate）时 V8 抛
    // 「Cannot read properties of undefined (reading 'AgentEventService')」。
    ;(fn as (...args: unknown[]) => unknown).call(serviceObj, ...(message.args ?? []))
  })
  return services
}
