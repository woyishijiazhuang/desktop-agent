import { inject, provide, type InjectionKey } from 'vue'

/**
 * 暂停「粘底」自动滚动：由 MessageList 提供，可展开卡片在用户手动切换时调用。
 *
 * 解决的 bug：用户滚到底部后展开某张卡片，vue-stick-to-bottom 的 ResizeObserver 会把
 * 本次高度变化当作流式增长而强制滚底。但其 scrollToBottom 经 requestAnimationFrame
 * 调度，落后于布局一帧：先绘出「内容长高、视口被顶起」的一帧，再瞬间跳回底部，
 * 形成「先挤下去、再跳到底部」的闪烁。调用本函数解除粘底锁定，让卡片就地展开、
 * 视口保持稳定，不再被强制拉回底部（用户可点「回到底部」按钮恢复跟随）。
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
