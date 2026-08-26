import type { InjectionKey, Ref } from 'vue'

/**
 * 消息级上下文注入键：MessageItem 向子树提供本条消息的 DB id（可能 undefined，如流式
 * 中尚未落库），供 markstream 自定义组件（如 EChartsBlock）感知——图表「重新生成」
 * 需要把新配置就地替换回原消息，必须知道要改哪条消息。
 */
export const chatMessageContextKey: InjectionKey<Ref<number | undefined>> =
  Symbol('chatMessageContext')
