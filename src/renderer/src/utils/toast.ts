import type { MessageApi } from 'naive-ui'

/** 已挂载的 Naive UI message API（由 ToastBridge 在 Provider 子树内注册）。 */
let messageApi: MessageApi | null = null

/** 在 NMessageProvider 子树内获取 useMessage() 并注册，供非组件上下文（IPC 服务）使用。 */
export function registerToast(api: MessageApi): void {
  messageApi = api
}

/** main 进程经 rendererClient.ui.showToast(options) 传入的弹窗参数，对应 Naive UI message 组件属性。 */
export interface ShowToastOptions {
  /** 弹窗类型；default 为无图标中性提示。 */
  type?: 'default' | 'info' | 'success' | 'warning' | 'error'
  /** 提示内容。 */
  content: string
  /** 显示时长（ms），默认 3000。 */
  duration?: number
  /** 是否显示关闭按钮。 */
  closable?: boolean
  /** 鼠标悬停时保持不消失。 */
  keepAliveOnHover?: boolean
}

/** 展示全局 toast。message API 未就绪（App 尚未挂载）时降级为 console 输出，不阻塞调用方。 */
export function showToast(options: ShowToastOptions): void {
  const api = messageApi
  if (!api) {
    console.warn('[ui] message API 未就绪，toast 未显示：', options.content)
    return
  }
  const { type = 'default', content, ...rest } = options
  const fn = type === 'default' ? api.create : api[type]
  fn(content, rest)
}
