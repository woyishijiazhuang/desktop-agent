import { useMessage } from 'naive-ui'

/**
 * 复制文本到剪贴板，并在 Naive UI message 上给出反馈。
 * 供工具调用卡 / 工具结果卡等「一键复制」按钮复用。
 *
 * 须在 NMessageProvider 子树内调用（组件 setup 中调用本组合式即可满足）。
 */
export function useCopy(): {
  copy: (text: string, label?: string) => Promise<void>
} {
  const message = useMessage()

  async function copy(text: string, label?: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      message.success(label ? `已复制${label}` : '已复制')
    } catch {
      message.error('复制失败')
    }
  }

  return { copy }
}
