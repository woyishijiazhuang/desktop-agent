<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { NIcon, NScrollbar } from 'naive-ui'
import { ChevronDownOutline } from '@vicons/ionicons5'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import MessageItem from './MessageItem.vue'
import CompressDivider from './CompressDivider.vue'
import WelcomeView from './WelcomeView.vue'
import { useStableMessageKeys } from '@renderer/composables/useStableMessageKeys'
import { provideStickToBottomPause } from '@renderer/composables/useStickToBottomPause'
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
  if (boundary == null) return 0
  return props.messages.filter((m) => {
    const id = (m as { id?: number }).id
    return id !== undefined && id <= boundary
  }).length
})

/* ===== 手写精简「粘底」滚动 =====
 * 规则：仅当「用户处于近底部」时才跟随内容增长滚到底；用户一上滚即解除跟随，此后
 * 完全不动 scrollTop，内容异步变高（echarts / monaco / 代码高亮）由浏览器原生
 * overflow-anchor 同帧补偿（CSS 已恢复 auto），不再用 JS 补锚，从根上消除跳动。
 * 原方案显式 overflow-anchor: none + ResizeObserver 逐帧补锚，补偿与库的 scrollTop
 * 写入互相竞争且晚于浏览器原生机制，是「小距离跳动」的来源。
 */
const NEAR_BOTTOM_PX = 70
/** NScrollbar 内部的原生滚动容器。 */
const scrollRef = ref<HTMLElement | null>(null)
/** 滚动内容层（观察高度变化）。 */
const contentEl = ref<HTMLElement | null>(null)
/** 距底 <= 70px（「回到底部」按钮显隐）。 */
const isNearBottom = ref(true)
/** 是否跟随内容增长滚底。 */
let stick = false
/** 生成结束延迟解除跟随的 rAF id。 */
let stickRaf = 0
let contentObserver: ResizeObserver | null = null

/**
 * 会话恢复后的「沉降窗口」：恢复瞬间锚点行按「占位高度」定位，延迟渲染卡片
 * （echarts / monaco / markdown）进入视口后内容高度异步变化会把锚点行顶走。
 * 原生 overflow-anchor 补偿正常阅读时的变高，但恢复这一瞬仍会漂移，需要短窗口
 * 补锚——补锚只在锚点行实际偏离目标位置时动作（原生已补偿时 delta 为 0，不冲突），
 * 用户主动滚动或窗口超时即放弃。
 */
interface SettleAnchor {
  el: HTMLElement
  anchor: { mid: number; offset: number }
  lastScrollTop: number
  until: number
}
const SETTLE_MS = 2500
let settleAnchor: SettleAnchor | null = null

/** 近底部判定（与分页/恢复逻辑同一阈值）。 */
function updateNearBottom(el: HTMLElement): void {
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

/** 滚动位置变化后同步粘底跟随状态（近底则跟随，上滚则解除）。 */
function syncStickState(el: HTMLElement): void {
  updateNearBottom(el)
  stick = isNearBottom.value
}

/** 滚动事件：近底部恢复跟随，上滚解除；沉降窗口内用户主动滚动则放弃锚定。 */
function onScroll(): void {
  const el = scrollRef.value
  if (!el) return
  syncStickState(el)
  const s = settleAnchor
  if (s && s.el === el && s.lastScrollTop !== el.scrollTop) {
    // 用户在沉降窗口内主动滚动：恢复锚定交给原生 overflow-anchor，不再补锚
    settleAnchor = null
  }
}

/** 立即滚到底并开启跟随（发送消息 / 生成开始 / 点回到底部）。滚到底后必然近底，直接置位。 */
function scrollToBottom(): void {
  const el = scrollRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  isNearBottom.value = true
  stick = true
}

/** 解除跟随（可展开卡片展开 / 搜索跳转定位后）。 */
function stopStick(): void {
  stick = false
}

/**
 * 沉降窗口内：把锚点行补回目标位置。窗口超时 / 锚点行不在当前加载窗口 /
 * 补锚无位移（原生锚定已接手）→ 结束沉降窗口。
 */
function trySettle(el: HTMLElement): void {
  const s = settleAnchor
  if (!s || s.el !== el) return
  if (performance.now() > s.until || !restoreScrollAnchor(el, s.anchor)) {
    settleAnchor = null
    return
  }
  const moved = Math.abs(el.scrollTop - s.lastScrollTop)
  s.lastScrollTop = el.scrollTop
  if (moved <= 1) settleAnchor = null
}

/** 开启沉降窗口：记录锚点行与窗口截止时间，内容异步变高时由 trySettle 补锚。 */
function openSettleWindow(el: HTMLElement, anchor: { mid: number; offset: number }): void {
  settleAnchor = {
    el,
    anchor,
    lastScrollTop: el.scrollTop,
    until: performance.now() + SETTLE_MS
  }
}

/** 内容高度变化：跟随中滚底；沉降窗口内补回锚点行；否则仅同步 nearBottom（原生 overflow-anchor 已同帧补偿视口）。 */
function onContentResize(): void {
  const el = scrollRef.value
  if (!el) return
  if (stick) {
    el.scrollTop = el.scrollHeight
    return
  }
  if (settleAnchor) {
    trySettle(el)
    return
  }
  updateNearBottom(el)
}

/**
 * 向可展开卡片（ToolCallCard / ReasoningBlock 等）提供「暂停粘底」入口：
 * 点击展开时先解除跟随，让卡片就地向下撑开、视口稳定，不被拉回底部。
 */
provideStickToBottomPause(stopStick)

// 生成中跟随滚底；生成结束等终态内容（markdown 重排/代码高亮）在跟随下完成，
// 再解除跟随（用户仍贴底时保持跟随）。
watch(
  () => props.isBusy,
  (busy) => {
    if (busy) {
      if (stickRaf) cancelAnimationFrame(stickRaf)
      scrollToBottom()
    } else {
      stickRaf = requestAnimationFrame(() => {
        stickRaf = requestAnimationFrame(() => {
          stickRaf = 0
          const el = scrollRef.value
          if (el) updateNearBottom(el)
          if (!isNearBottom.value) stick = false
        })
      })
    }
  },
  { immediate: true }
)

/** 回到底部按钮：空闲时平滑滚到底（到位后 onScroll 恢复跟随）；生成中即时滚底并保持跟随。 */
function onScrollToBottom(): void {
  const el = scrollRef.value
  if (!el) return
  if (props.isBusy) {
    scrollToBottom()
  } else {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
}

/**
 * 函数式模板 ref：vue-tsc 的 noUnusedLocals 不把静态 `ref="scrollRef"` 计为使用，
 * 改用 `:ref="setContentRef"` 表达式形式。滚动容器（scrollRef）不在模板上直接绑定：
 * NScrollbar 的模板 ref 拿到的是暴露对象（无 $el），改为在 scrollWrapRef
 * 的 DOM 树里查 .n-scrollbar-container（见 scrollWrapRef 的 watch），供滚动监听 /
 * 分页哨兵 / 搜索跳转直接操作。
 */
function setContentRef(el: Element | ComponentPublicInstance | null): void {
  contentEl.value = el instanceof HTMLElement ? el : null
}

/** 上一次 watch 记录到的「会话 + 末条消息」（区分同会话尾部新增 / 跨会话替换）。 */
let lastTail: { sessionId: string | null | undefined; message: AgentMessage | null } | null = null

// 用户发送的新消息强制滚底（即便用户正在上滚浏览历史，发送后也应跳到底部看回复）。
// assistant / toolResult 追加与流式 token 增长一律交给内容 ResizeObserver：在底部时
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
    if (sameSession && last?.role === 'user') scrollToBottom()
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
let scrollListenerEl: HTMLElement | null = null

function detachScrollListener(): void {
  scrollListenerEl?.removeEventListener('scroll', onScroll)
  scrollListenerEl = null
}

/**
 * 滚动容器就绪回调：滚动区现在仅在有消息时挂载（空会话渲染 WelcomeView），
 * 首屏可能是欢迎页、发消息后滚动区才出现，因此不能用 onMounted 一次性赋值。
 * 监听 scrollWrapRef 模板 ref（挂载/卸载时自动更新），每次就绪时挂滚动监听、
 * 重建顶部哨兵观察器（滚动容器/哨兵任一重新挂载后旧 observer 已失效），
 * 并恢复该会话上次滚动锚点（无记录/正在生成则落底）。
 */
watch(
  scrollWrapRef,
  (wrap) => {
    scrollRef.value = wrap?.querySelector<HTMLElement>('.n-scrollbar-container') ?? null
    detachScrollListener()
    const el = scrollRef.value
    if (el) {
      el.addEventListener('scroll', onScroll, { passive: true })
      scrollListenerEl = el
    }
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

// 观察内容元素高度：跟随中滚底，否则仅同步 nearBottom（非底部变高由原生
// overflow-anchor 同帧补偿，无需也不应再手动补锚）。
watch(
  contentEl,
  (content) => {
    contentObserver?.disconnect()
    contentObserver = null
    if (content) {
      contentObserver = new ResizeObserver(onContentResize)
      contentObserver.observe(content)
    }
  },
  { flush: 'post' }
)

/** 恢复会话滚动锚点：正在生成则落底跟随；有锚点则定位到锚点消息行；无记录/锚点不在窗口则落底。 */
function applyScrollRestore(el: HTMLElement): void {
  settleAnchor = null
  const anchor = props.sessionId ? chatStore.getSessionScroll(props.sessionId) : undefined
  if (props.isBusy || !anchor || !restoreScrollAnchor(el, anchor)) {
    el.scrollTop = el.scrollHeight
    syncStickState(el)
    return
  }
  // 恢复成功：进入沉降窗口，内容异步变高时把锚点行补回原位（原生锚定已接手时无位移、自动退出）
  openSettleWindow(el, anchor)
  syncStickState(el)
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

onBeforeUnmount(() => {
  // 路由离开（如切到设置页）前保存当前会话滚动锚点，返回聊天页时可恢复
  saveCurrentAnchor(props.sessionId)
  contentObserver?.disconnect()
  contentObserver = null
  settleAnchor = null
  detachScrollListener()
  sentinelObserver?.disconnect()
  sentinelObserver = null
  if (stickRaf) cancelAnimationFrame(stickRaf)
})

async function loadOlder(): Promise<void> {
  if (chatStore.loadingOlder || !chatStore.hasMore) return
  const el = scrollRef.value
  const sessionIdAtStart = props.sessionId
  // 消息行锚点（与会话恢复同策略）：加载前记录「视口顶部第一条可见消息行」。
  // 新页消息在加载后持续异步变高（markstream 节点分批渲染、Monaco 挂载），
  // 像素锚（距底距离）会随 scrollHeight 漂移导致恢复位置偏移；消息行锚点
  // 只依赖该行自身位置，不受其上下内容高度变化影响。
  const anchor = el ? captureScrollAnchor(el) : null
  // 兜底像素锚：视口内找不到带 id 的消息行时使用
  const distanceFromBottom = el ? el.scrollHeight - el.scrollTop : 0
  await chatStore.loadMoreMessages()
  await nextTick()
  // 加载期间切换了会话：锚点行已不在 DOM，恢复交给会话切换 watch（applyScrollRestore）
  if (props.sessionId !== sessionIdAtStart) return
  const el2 = scrollRef.value
  if (!el2) return
  if (anchor && restoreScrollAnchor(el2, anchor)) {
    // 新页消息异步变高同样会让锚点行漂移，进入沉降窗口补锚
    openSettleWindow(el2, anchor)
    syncStickState(el2)
    return
  }
  el2.scrollTop = el2.scrollHeight - distanceFromBottom
  syncStickState(el2)
}

/**
 * 搜索跳转定位：消费 chatStore.pendingJumpMessageId，滚动到目标消息并闪亮高亮。
 * - 在 post 渲染后按 data-mid 找到行节点，垂直居中到视口。
 * - 随后解除跟随（stick=false），避免随后的内容渲染把位置拉回底部。
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
      stopStick()
      settleAnchor = null
      updateNearBottom(scroll)
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
                v-if="compressLastIndex != null && item.isCompressBoundary"
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
          v-if="!isNearBottom && messages.length > 0"
          class="message-list__to-bottom"
          type="button"
          title="回到底部"
          @click="onScrollToBottom"
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
/* 保留内部滚动容器的原生滚动锚定（overflow-anchor 默认 auto）：非底部浏览时，
 * 视口上方内容异步变高（echarts/monaco/代码高亮）由浏览器同帧补偿，肉眼不可见；
 * 底部跟随由 JS 粘底逻辑负责，两者互不冲突（不要再设 overflow-anchor: none）。 */
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
