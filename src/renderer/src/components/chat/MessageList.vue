<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { NIcon, NScrollbar } from 'naive-ui'
import { ChevronDownOutline } from '@vicons/ionicons5'
import { useStickToBottom } from 'vue-stick-to-bottom'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import MessageItem from './MessageItem.vue'
import CompressDivider from './CompressDivider.vue'
import WelcomeView from './WelcomeView.vue'
import { useStableMessageKeys } from '@renderer/composables/useStableMessageKeys'
import { useChatStore } from '@renderer/store/useChatStore'

const props = defineProps<{
  messages: AgentMessage[]
  isBusy: boolean
  /** 当前会话 id（欢迎页 AI 建议生成 / 用量记录用；临时会话可能为 null）。 */
  sessionId?: string | null
  /** 压缩分界：最后一个被压缩的消息 DB id（非空时在其后渲染分界卡片）。 */
  compressLastIndex?: number | null
  /** 压缩摘要全文（分界卡片展开时展示）。 */
  compressSummary?: string | null
}>()
const emit = defineEmits<{ send: [text: string]; regenerate: [] }>()
const chatStore = useChatStore()

const keyed = useStableMessageKeys(() => props.messages)

interface LayoutItem {
  id: string
  message: AgentMessage
  /** 工具调用 → 匹配到的 toolResult（仅 assistant 消息携带），供 ToolCallCard 合并展示 */
  matchedToolResults?: Map<string, ToolResultMessage>
  /**
   * 压缩分界（compressLastIndex）是否落在本条：
   * 本条自身 id 即分界，或本条消费了 id 为分界的合并 toolResult。
   * 供模板在该条之后渲染 CompressDivider——分界消息若是 toolResult 且已并入工具卡，
   * 不再独立成行，必须挂到宿主管道之后，否则分界卡永远不出现。
   */
  isCompressBoundary?: boolean
}

/**
 * 把 toolResult 消息合并进对应的工具调用卡片（ChatGPT 风格：一次工具调用 = 一张卡）。
 * 按 toolCallId 匹配；被合并进卡片的 toolResult 不再单独成行。
 * 分页边界可能把 toolCall（前一页）与 toolResult（本页）拆开，此时 toolResult 找不到
 * 调用卡片，仍保留为独立的「孤儿结果卡」兜底展示。
 */
const layout = computed<LayoutItem[]>(() => {
  const resultByCall = new Map<string, ToolResultMessage>()
  for (const item of keyed.value) {
    const m = item.message as { role?: string }
    if (m.role === 'toolResult') {
      const t = m as ToolResultMessage
      if (t.toolCallId) resultByCall.set(t.toolCallId, t)
    }
  }
  const consumed = new Set<string>()
  const boundary = props.compressLastIndex
  const out: LayoutItem[] = []
  for (const item of keyed.value) {
    const m = item.message as { role?: string; content?: unknown; id?: number }
    if (m.role === 'assistant') {
      const content = m.content
      const calls = Array.isArray(content)
        ? (content as { type?: string; id?: string }[]).filter((b) => b.type === 'toolCall')
        : []
      const matched = new Map<string, ToolResultMessage>()
      for (const c of calls) {
        const callId = c.id
        const res = callId ? resultByCall.get(callId) : undefined
        if (callId && res) {
          matched.set(callId, res)
          consumed.add(callId)
        }
      }
      // 分界消息若被并入本条（boundary 是 toolResult），同样由本条承接分界标记
      let mergedBoundary = false
      if (boundary != null) {
        for (const res of matched.values()) {
          if ((res as { id?: number }).id === boundary) {
            mergedBoundary = true
            break
          }
        }
      }
      // 无匹配结果时传 undefined（保持 prop 引用稳定）：layout 在流式期间每帧重算，
      // 若为无 toolCall 的消息也新建空 Map，所有 assistant 子组件都会因 prop 引用
      // 变化而每帧重渲染。仅在有结果时传递，非末条消息便不再随流式刷新。
      out.push({
        id: item.id,
        message: item.message,
        matchedToolResults: matched.size > 0 ? matched : undefined,
        isCompressBoundary: m.id === boundary || mergedBoundary
      })
    } else if (m.role === 'toolResult' && consumed.has((m as ToolResultMessage).toolCallId)) {
      // 结果已并入对应工具卡，跳过独立渲染
      continue
    } else {
      out.push({ id: item.id, message: item.message, isCompressBoundary: m.id === boundary })
    }
  }
  return out
})

/** 已压缩消息条数（id <= compressLastIndex 的已落库消息；乐观/流式中消息无 id 不计）。 */
const compressedCount = computed(() => {
  const boundary = props.compressLastIndex
  if (boundary === null || boundary === undefined) return 0
  return props.messages.filter((m) => {
    const id = (m as { id?: number }).id
    return id !== undefined && id <= boundary
  }).length
})

/**
 * 聊天列表「粘底」滚动：委托 vue-stick-to-bottom（use-stick-to-bottom 的 Vue 移植，
 * 同 pi-web-ui / Vercel AI chatbot 等 AI 聊天界面的滚动方案）。
 *
 * 默认「不粘底」：仅流式生成（isBusy）时跟随内容增长自动滚底；空闲态任何内容变化
 * （展开卡片、markdown 重排、切换会话、图片加载）都不再挪动滚动位置，把页面控制权
 * 完全交还用户——此前「空闲也粘底」会在切换会话（A 消息少→B 消息多，本在 A 底部）
 * 或展开卡片时被视作内容增长而强制滚底，产生一次明显的滚动闪烁。
 *
 * 实现要点：
 * - `initial: false`：首屏不再依赖库的初始滚动，统一由下方「落底/恢复锚点」逻辑在
 *   布局后同步设置 scrollTop（先于浏览器绘制，无中间帧）。
 * - isBusy 切换：生成开始 `scrollToBottom` 恢复跟随；生成结束等终态内容重排完成后
 *   `stopScroll` 关闭跟随。
 * - 兜底：空闲态库在「用户滚到近底部」时会自行把 isAtBottom 置回 true，这里 watch
 *   到即回收，保证空闲绝不自动跟随。
 * - 用户上滚浏览历史时 isAtBottom 变 false，自动停止粘底，不被流式更新打扰。
 * - 会话间位置记忆采用「消息 id + 视口偏移」锚点（非像素/距底部距离）：会话内容含
 *   延迟渲染卡片（echarts/markdown/monaco），高度异步变化会让像素位置失真，锚定到
 *   具体消息行则不受其下方内容高度变化影响；恢复后补两帧锚定抵消进入视口的卡片位移。
 */
const { scrollRef, contentRef, isAtBottom, isNearBottom, scrollToBottom, stopScroll, setOptions } =
  useStickToBottom({
    resize: 'instant',
    initial: false
  })

/** 生成结束延迟关闭粘底的 rAF id（等终态内容在跟随下重排完成，再停掉跟随）。 */
let stopScrollRaf: number | null = null

// 生成中平滑跟随（smooth）；空闲时任何显式滚动都即时到位。
watch(
  () => props.isBusy,
  (busy) => {
    setOptions({ resize: busy ? 'smooth' : 'instant' })
    if (busy) {
      // 新一轮生成：立即贴底并恢复粘底跟随（用户刚发送，通常本就在底部，无跳动）
      if (stopScrollRaf !== null) {
        cancelAnimationFrame(stopScrollRaf)
        stopScrollRaf = null
      }
      void scrollToBottom('instant')
    } else {
      // 生成结束：等终态内容（markdown 重排/代码高亮）在粘底跟随下完成，再关闭粘底
      stopScrollRaf = requestAnimationFrame(() => {
        stopScrollRaf = requestAnimationFrame(() => {
          stopScrollRaf = null
          stopScroll()
        })
      })
    }
  },
  { immediate: true }
)

// 空闲态强制不粘底：库在「用户滚到近底部」时会把 isAtBottom 置回 true（恢复跟随），
// 这里一旦发现空闲却粘底立即回收，保证空闲时内容变化不再自动滚动。
watch(
  isAtBottom,
  (atBottom) => {
    if (atBottom && !props.isBusy) stopScroll()
  },
  { flush: 'post' }
)

/**
 * 函数式模板 ref：vue-tsc 的 noUnusedLocals 不把静态 `ref="scrollRef"` 计为使用，
 * 改用 `:ref="setContentRef"` 表达式形式。滚动容器（scrollRef）不在模板上直接绑定：
 * NScrollbar 的模板 ref 拿到的是暴露对象（无 $el），改为在 scrollWrapRef
 * 的 DOM 树里查 .n-scrollbar-container（见 scrollWrapRef 的 watch），供 vue-stick-to-bottom /
 * 分页哨兵 / 搜索跳转直接操作。
 */
function setContentRef(el: Element | ComponentPublicInstance | null): void {
  contentRef.value = el instanceof HTMLElement ? el : null
}

/** 上一次 watch 记录到的「会话 + 末条消息」（区分同会话尾部新增 / 跨会话替换）。 */
let lastTail: { sessionId: string | null | undefined; message: AgentMessage | null } | null = null

// 用户发送的新消息强制滚底（即便用户正在上滚浏览历史，发送后也应跳到底部看回复）。
// assistant / toolResult 追加与流式 token 增长一律交给库的 ResizeObserver：在底部时
// 自动跟随，上滚时不打扰。flush:'post' 确保用户消息已渲染后再滚动到真实底部。
// 分页适配：向上加载 prepend 也会让 length 增长，但末条引用未变（lastTail 相同），
// 不会误触滚底，避免打断用户阅读历史。
// 跨会话适配：仅「同会话内新增 user 消息」才滚底；切换会话引起的 length 变化不滚底，
// 交给下方的 applyScrollRestore 恢复该会话的滚动锚点。
watch(
  () => props.messages.length,
  (newLen, oldLen) => {
    if (newLen <= (oldLen ?? 0)) return
    const last = props.messages[newLen - 1] as { role?: string } | undefined
    const sameSession = lastTail?.sessionId === props.sessionId
    lastTail = { sessionId: props.sessionId, message: last as AgentMessage | null }
    if (sameSession && last?.role === 'user') void scrollToBottom('instant')
  },
  { flush: 'post' }
)

/**
 * 历史分页：顶部哨兵 + IntersectionObserver 自动加载更早消息。
 * - 哨兵挂在内容顶部，root 为滚动容器，rootMargin 提前 120px 触发，上滚临近顶部即加载下一页。
 * - 用户停在底部看流式回复时哨兵不在视口内，不会触发加载（与流式不冲突）。
 * - 加载后按「距底部距离」锚定滚动位置：prepend + nextTick 后恢复 scrollTop，
 *   保证正在阅读的历史不被顶出视口。
 */
const sentinelRef = ref<HTMLElement | null>(null)
/** 包裹 NScrollbar 的普通 div：挂载后从中查找内部滚动容器（.n-scrollbar-container）。 */
const scrollWrapRef = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null

/** 滚动容器上一次记录的可见高度（容器 ResizeObserver 判定「变高/变矮」用）。 */
let lastContainerHeight: number | null = null
/** 观察滚动容器自身高度变化（内容元素之外的布局挤压/回弹）。 */
let containerObserver: ResizeObserver | null = null
/** 恢复粘底的延迟 rAF id（钳制 scroll 事件派发后再执行）。 */
let restickRaf: number | null = null

/**
 * 滚动容器就绪回调：滚动区现在仅在有消息时挂载（空会话渲染 WelcomeView），
 * 首屏可能是欢迎页、发消息后滚动区才出现，因此不能用 onMounted 一次性赋值。
 * 监听 scrollWrapRef 模板 ref（挂载/卸载时自动更新），每次就绪时：
 * - 把 NScrollbar 内部的原生滚动容器交给 vue-stick-to-bottom（watchEffect 侦测到
 *   scrollRef 赋值后自动 attach）；
 * - 重建顶部哨兵观察器（滚动容器/哨兵任一重新挂载后旧 observer 已失效）。
 */
watch(
  scrollWrapRef,
  (wrap) => {
    scrollRef.value = wrap?.querySelector<HTMLElement>('.n-scrollbar-container') ?? null
    sentinelObserver?.disconnect()
    sentinelObserver = null
    const root = scrollRef.value
    const target = sentinelRef.value
    if (root && target) {
      sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) void loadOlder()
        },
        { root, rootMargin: '120px 0px 0px 0px' }
      )
      sentinelObserver.observe(target)
    }
    // 容器（重新）挂载：优先恢复该会话上次滚动锚点；无记录/正在生成则落底
    if (root) applyScrollRestore(root)
  },
  { flush: 'post' }
)

/** 视口顶部第一条「底部未滚出视口」的消息行作为滚动锚点；offset 为该行顶部相对视口顶部的距离（可为负）。 */
function captureScrollAnchor(el: HTMLElement): { mid: number; offset: number } | null {
  const viewportTop = el.getBoundingClientRect().top
  for (const row of el.querySelectorAll<HTMLElement>('.row[data-mid]')) {
    if (row.getBoundingClientRect().bottom > viewportTop) {
      const mid = Number(row.dataset.mid)
      if (Number.isFinite(mid))
        return { mid, offset: row.getBoundingClientRect().top - viewportTop }
    }
  }
  return null
}

/** 把锚点消息行恢复到「行顶 = 视口顶 + offset」；消息不在当前加载窗口时返回 false。 */
function restoreScrollAnchor(el: HTMLElement, anchor: { mid: number; offset: number }): boolean {
  const row = el.querySelector<HTMLElement>(`.row[data-mid="${anchor.mid}"]`)
  if (!row) return false
  const viewportTop = el.getBoundingClientRect().top
  el.scrollTop += row.getBoundingClientRect().top - viewportTop - anchor.offset
  return true
}

/**
 * 会话恢复后的「沉降窗口」：延迟渲染卡片（echarts/markdown/monaco）进入视口后内容
 * 高度会异步变化，期间每次内容高度变化都把锚点行重新拉回原位，直到位置稳定或超时。
 * 若不处理，恢复时内容仍是「占位高度」，锚点会被钳制到错误位置，卡片渲染后位置漂移。
 */
interface SettlingAnchor {
  el: HTMLElement
  anchor: { mid: number; offset: number }
  lastScrollTop: number
  until: number
}
const SETTLE_MS = 2500
let settlingAnchor: SettlingAnchor | null = null
let contentObserver: ResizeObserver | null = null

// 观察内容元素高度：会话恢复后（settlingAnchor 非空）内容高度一变化就重新落锚。
watch(
  () => contentRef.value,
  (content) => {
    contentObserver?.disconnect()
    contentObserver = null
    if (!content) return
    contentObserver = new ResizeObserver(() => {
      const s = settlingAnchor
      if (!s || scrollRef.value !== s.el) {
        settlingAnchor = null
        return
      }
      if (!restoreScrollAnchor(s.el, s.anchor)) {
        settlingAnchor = null
        return
      }
      const moved = Math.abs(s.el.scrollTop - s.lastScrollTop)
      s.lastScrollTop = s.el.scrollTop
      if (moved <= 1 || performance.now() > s.until) settlingAnchor = null
    })
    contentObserver.observe(content)
  },
  { flush: 'post' }
)

/** 恢复会话滚动锚点：正在生成则落底跟随；有锚点则定位到锚点消息行；无记录/锚点不在窗口则落底。 */
function applyScrollRestore(el: HTMLElement): void {
  settlingAnchor = null
  if (props.isBusy) {
    el.scrollTop = el.scrollHeight
    isNearBottom.value = true
    return
  }
  const anchor = props.sessionId ? chatStore.getSessionScroll(props.sessionId) : undefined
  if (anchor && restoreScrollAnchor(el, anchor)) {
    isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 70
    // 关键：立即关闭库的粘底跟随。恢复位置后库的 isAtBottom 仍是上一个会话残留的
    // true（scroll 事件派发有延迟），内容渲染会触发库自动 scrollToBottom 把位置拉回
    // 底部（掉底根因）。stopScroll 让库停止跟随，直到用户重新滚到近底部。
    stopScroll()
    // 进入沉降窗口：内容高度变化时持续补锚，覆盖延迟渲染卡片的异步高度变化
    settlingAnchor = {
      el,
      anchor,
      lastScrollTop: el.scrollTop,
      until: performance.now() + SETTLE_MS
    }
    return
  }
  el.scrollTop = el.scrollHeight
  isNearBottom.value = true
}

/** 保存当前会话的滚动锚点（须在旧内容仍挂载时调用）。 */
function saveCurrentAnchor(sessionId: string | null | undefined): void {
  const el = scrollRef.value
  if (!el || !sessionId) return
  const anchor = captureScrollAnchor(el)
  if (anchor) chatStore.saveSessionScroll(sessionId, anchor)
}

// 切走会话前（DOM 仍是旧会话内容）保存滚动锚点；切回后由 applyScrollRestore 恢复。
watch(
  () => props.sessionId,
  (_newId, oldId) => {
    if (oldId) saveCurrentAnchor(oldId)
  }
)

/**
 * 切换会话：消息整体替换后恢复该会话上次滚动锚点（无记录/正在生成则落底）。
 * 同步定位（先于浏览器绘制，无中间帧）：既不「先见中间再滑到底」，也不在旧会话
 * 贴底时被视作「内容增长」触发平滑滚底/跳变闪烁。
 */
watch(
  () => props.sessionId,
  () => {
    const el = scrollRef.value
    if (!el || props.messages.length === 0) return
    applyScrollRestore(el)
  },
  { flush: 'post' }
)

/**
 * 滚动容器自身高度变化（外部布局挤压/回弹，如权限确认条出现/消失、窗口高度变化）
 * 不会触发库的 ResizeObserver——它只观察内容元素，感知不到容器高度变化。当容器
 * 变高（布局回弹）时，若滚动位置恰贴在旧底部，浏览器会把 scrollTop 钳制回新底部
 * 并触发 scroll 事件，被库误判为「用户上滚」而永久解除粘底（isAtBottom=false +
 * escapedFromLock=true），此后流式内容增长不再跟随滚底（如确认工具后页面不再下滚）。
 * 处理：容器回弹且位置贴底时，在钳制 scroll 事件派发后的下一帧补一次 scrollToBottom
 * 恢复粘底；滚动位置本就在底部，不会产生可见跳动。
 */
watch(
  () => scrollRef.value,
  (el) => {
    containerObserver?.disconnect()
    containerObserver = null
    if (restickRaf !== null) {
      cancelAnimationFrame(restickRaf)
      restickRaf = null
    }
    if (!el) return
    lastContainerHeight = el.clientHeight
    containerObserver = new ResizeObserver(() => {
      const h = el.clientHeight
      const prev = lastContainerHeight
      lastContainerHeight = h
      // 仅处理容器变高（回弹）；变矮是挤压，滚动位置不会越界，无需处理。
      if (prev == null || h <= prev) return
      const target = el.scrollHeight - el.clientHeight
      // 位置未贴底（用户已上滚）时，变高不会触发 scrollTop 钳制，不受影响。
      if (el.scrollTop < target - 1) return
      // 容器回弹且贴底：补一次 scrollToBottom 恢复粘底。不能按「isAtBottom 为 false」
      // 才补——库的公开 isAtBottom 含「近底部」语义，钳制后仍为 true，但内部
      // state.isAtBottom 已被误判的 scroll 事件清掉，流式内容增长将不再跟随。
      // 空闲态此处立即被上方 isAtBottom 兜底 watch 回收，不会产生空闲自动跟随。
      restickRaf = requestAnimationFrame(() => {
        restickRaf = requestAnimationFrame(() => {
          restickRaf = null
          if (!scrollRef.value) return
          void scrollToBottom('instant')
        })
      })
    })
    containerObserver.observe(el)
  },
  { flush: 'post' }
)

onBeforeUnmount(() => {
  // 路由离开（如切到设置页）前保存当前会话滚动锚点，返回聊天页时可恢复
  saveCurrentAnchor(props.sessionId)
  contentObserver?.disconnect()
  contentObserver = null
  settlingAnchor = null
  sentinelObserver?.disconnect()
  sentinelObserver = null
  containerObserver?.disconnect()
  containerObserver = null
  if (restickRaf !== null) {
    cancelAnimationFrame(restickRaf)
    restickRaf = null
  }
  if (stopScrollRaf !== null) {
    cancelAnimationFrame(stopScrollRaf)
    stopScrollRaf = null
  }
})

async function loadOlder(): Promise<void> {
  if (chatStore.loadingOlder || !chatStore.hasMore) return
  const el = scrollRef.value
  const anchor = el ? el.scrollHeight - el.scrollTop : 0
  await chatStore.loadMoreMessages()
  await nextTick()
  const el2 = scrollRef.value
  if (el2) el2.scrollTop = el2.scrollHeight - anchor
}

/**
 * 搜索跳转定位：消费 chatStore.pendingJumpMessageId，滚动到目标消息并闪亮高亮。
 * - 在 post 渲染后按 data-mid 找到行节点，垂直居中到视口。
 * - 随后 stopScroll 解除「粘底」锁定（isAtBottom=false），使库对本次窗口替换触发的
 *   ResizeObserver 滚底在 rAF 校验时因不在底部而中止，保证定位不被顶走。
 * - 高亮通过临时 class 实现，1.8s 后移除。
 */
watch(
  () => chatStore.pendingJumpMessageId,
  async (targetId) => {
    if (targetId == null) return
    await nextTick()
    const scroll = scrollRef.value
    if (!scroll) return
    // 目标消息若是被并入工具调用卡片的 toolResult（layout 不单独成行，DOM 无对应
    // .row[data-mid]），退化为锚定到包含它的助手消息行再滚动 + 高亮。
    let anchorId = targetId
    const host = layout.value.find((it) => {
      const m = it.message as { role?: string }
      if (m.role !== 'assistant' || !it.matchedToolResults) return false
      for (const res of it.matchedToolResults.values()) {
        if ((res as { id?: number }).id === targetId) return true
      }
      return false
    })
    if (host) anchorId = (host.message as { id?: number }).id ?? targetId
    const row = scroll.querySelector<HTMLElement>(`.row[data-mid="${anchorId}"]`)
    if (row) {
      const scrollRect = scroll.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const top =
        scroll.scrollTop +
        (rowRect.top - scrollRect.top) -
        scroll.clientHeight / 2 +
        row.offsetHeight / 2
      scroll.scrollTop = Math.max(0, top)
      stopScroll()
      row.classList.add('row--flash')
      window.setTimeout(() => row.classList.remove('row--flash'), 1800)
    }
    chatStore.clearPendingJump()
  },
  { flush: 'post' }
)
</script>

<template>
  <div class="message-list">
    <!-- 空会话：欢迎页（不渲染滚动容器；welcome 在 flex 容器内直接居中） -->
    <WelcomeView
      v-if="messages.length === 0"
      :is-busy="isBusy"
      :session-id="sessionId"
      @send="emit('send', $event)"
    />

    <template v-else>
      <!-- 滚动容器：naive-ui NScrollbar 接管（与应用其余区域一致：悬停显示滚动条、自带淡入淡出）。
           外层 scrollWrapRef 用于挂载后定位内部 .n-scrollbar-container（见 watch）。 -->
      <div ref="scrollWrapRef" class="message-list__scroll-wrap">
        <NScrollbar class="message-list__scroll">
          <div :ref="setContentRef" class="message-list__content">
            <!-- 历史分页哨兵：上滚到顶部附近时自动加载更早消息（hasMore 时显示加载态） -->
            <div ref="sentinelRef" class="message-list__sentinel">
              <span v-if="chatStore.loadingOlder" class="message-list__sentinel-tip">
                加载更早的消息…
              </span>
            </div>
            <template v-for="(item, i) in layout" :key="item.id">
              <MessageItem
                :message="item.message"
                :matched-tool-results="item.matchedToolResults"
                :is-last-message="i === layout.length - 1"
                @regenerate="emit('regenerate')"
              />
              <!-- 压缩分界：在该条（或分界 toolResult 所并入的工具卡）之后插入分界卡片 -->
              <CompressDivider
                v-if="
                  compressLastIndex !== null &&
                  compressLastIndex !== undefined &&
                  item.isCompressBoundary
                "
                :count="compressedCount"
                :summary="compressSummary ?? null"
              />
            </template>
          </div>
        </NScrollbar>
      </div>

      <!-- 回到底部：用户上滚离开底部时浮现 -->
      <Transition name="to-bottom">
        <button
          v-if="!isAtBottom && !isNearBottom && messages.length > 0"
          class="message-list__to-bottom"
          type="button"
          title="回到底部"
          @click="scrollToBottom()"
        >
          <NIcon :size="18"><ChevronDownOutline /></NIcon>
        </button>
      </Transition>
    </template>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
/* 包裹 NScrollbar 的外层：占满消息区高度，NScrollbar 根元素在其中纵向撑满 */
.message-list__scroll-wrap {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* NScrollbar 根元素：撑满外层，滚动由内部 .n-scrollbar-container 承担 */
.message-list__scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
/* 关闭内部滚动容器的原生滚动锚定，交由 vue-stick-to-bottom 管理 scrollTop，
 * 避免与 ResizeObserver 粘底冲突（naive-ui 已隐藏该容器的原生滚动条并自绘轨道）。
 * 需用 scroll-wrap 前缀 + :deep()：n-scrollbar-container 是 NScrollbar 内部元素，
 * 且 .message-list__scroll 是组件根（不带本组件 data-v），以它为前缀会永远不命中。 */
.message-list__scroll-wrap :deep(.n-scrollbar-container) {
  overflow-anchor: none;
}
/* 让滚动内容层纵向撑满滚动区（消息不满一屏时滚动区整体可见，顶部哨兵贴顶） */
.message-list__scroll-wrap :deep(.n-scrollbar-content) {
  min-height: 100%;
}
.message-list__content {
  display: flex;
  flex-direction: column;
  /* 行间距由 MessageItem .row 的 padding-bottom 统一管理（为悬停操作条预留空间） */
  gap: 0;
  /* 左右 16px 对称内边距：NScrollbar 的滚动条轨道是绝对定位悬浮叠加（不占布局），
   * 右侧留白保证轨道不会压住右对齐的用户头像；左留白保持对称 */
  padding: 24px 16px;
}

/* 历史分页哨兵：默认零高，加载时显示提示文案 */
.message-list__sentinel {
  display: flex;
  justify-content: center;
  min-height: 0;
}
.message-list__sentinel-tip {
  padding: 4px 0 8px;
  font-size: 12px;
  color: var(--text-3);
}

.message-list__to-bottom {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-2);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.message-list__to-bottom:hover {
  background: var(--primary);
  color: #fff;
}

.to-bottom-enter-active,
.to-bottom-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.to-bottom-enter-from,
.to-bottom-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}

/* ===== 搜索跳转高亮：目标消息短暂闪亮后淡出 ===== */
.message-list__scroll-wrap :deep(.row--flash) {
  animation: row-flash 1.8s ease;
}
@keyframes row-flash {
  0% {
    background: var(--primary-soft);
  }
  100% {
    background: transparent;
  }
}
</style>
