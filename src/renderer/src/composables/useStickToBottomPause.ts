import { inject, provide, type InjectionKey } from 'vue'

/**
 * 暂停「粘底」自动滚动：由 MessageList 提供，可展开卡片在用户手动切换时调用。
 *
 * 解决的 bug：用户滚到底部后展开某张卡片，MessageList 的内容 ResizeObserver 会把
 * 本次高度变化当作内容增长而强制滚底（stick 跟随），卡片头部被顶起，视觉上变成
 * 「往上展开」。调用本函数解除跟随锁定，让卡片就地向下展开、视口保持稳定，不再被
 * 拉回底部（用户可点「回到底部」按钮恢复跟随）。
 */
export type StickToBottomPause = () => void

const KEY: InjectionKey<StickToBottomPause> = Symbol('stick-to-bottom-pause')

/** 提供暂停函数（MessageList 调用）。 */
export function provideStickToBottomPause(pause: StickToBottomPause): void {
  provide(KEY, pause)
}

/** 注入暂停函数（可展开卡片调用）；未处于 MessageList 后代时返回 undefined。 */
export function useStickToBottomPause(): StickToBottomPause | undefined {
  return inject(KEY, undefined)
}
