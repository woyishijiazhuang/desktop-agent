<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NIcon, NPopconfirm, NScrollbar } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, CloseOutline } from '@vicons/ionicons5'
import { useBackgroundStore } from '@renderer/store/useBackgroundStore'
import type { BackgroundSessionInfo } from '@main/agent/bash-session'

/**
 * 侧栏「后台任务」面板：展示所有后台命令与后台下载（全局，与当前会话无关），
 * 支持查看输出 / 终止运行中任务 / 移除已退出任务。状态由 main 推送快照驱动。
 */
const store = useBackgroundStore()

/** 面板展开/收起。 */
const expanded = ref(true)
/** 拖拽后的固定高度（px）；null=按内容自适应（上限 60%），重启恢复默认。 */
const panelHeight = ref<number | null>(null)
/** 当前展开查看输出的会话 id（一次一个）。 */
const outputFor = ref<string | null>(null)
const outputText = ref('')
const outputLoading = ref(false)

/** 运行中刻度：每秒刷新，驱动 mm:ss 计时。 */
const now = ref(Date.now())
let tickTimer: number | undefined
onMounted(() => {
  void store.refresh()
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  clearInterval(tickTimer)
})

/** 顶部把手拖拽调整面板高度（向上拖变大；120px ~ 75% 窗口高）。 */
function startResize(e: MouseEvent): void {
  e.preventDefault()
  const startY = e.clientY
  const panelEl = (e.currentTarget as HTMLElement).parentElement
  const startH = panelHeight.value ?? panelEl?.offsetHeight ?? 240
  const minH = 120
  const maxH = window.innerHeight * 0.45
  const onMove = (ev: MouseEvent): void => {
    panelHeight.value = Math.round(Math.min(maxH, Math.max(minH, startH + (startY - ev.clientY))))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'ns-resize'
  document.body.style.userSelect = 'none'
}

const runningCount = computed(() => store.sessions.filter((s) => !s.exited).length)

/** 会话运行时长：已退出取退出时刻，运行中取当前时刻。 */
function elapsed(s: BackgroundSessionInfo): string {
  const end = s.exited && s.exitedAt !== null ? s.exitedAt : now.value
  return formatElapsed(Math.max(0, end - s.startedAt))
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 状态提示文案：下载任务与 shell 会话文案区分。 */
function stateText(s: BackgroundSessionInfo): string {
  if (!s.exited) return s.kind === 'download' ? `下载中 · ${elapsed(s)}` : `运行中 · ${elapsed(s)}`
  if (s.kind === 'download') {
    return s.exitCode === 0 ? `已完成 · ${elapsed(s)}` : `已失败 · ${elapsed(s)}`
  }
  return `已退出 · ${elapsed(s)}（exit ${s.exitCode}）`
}

async function toggleOutput(s: BackgroundSessionInfo): Promise<void> {
  if (outputFor.value === s.id) {
    outputFor.value = null
    return
  }
  outputFor.value = s.id
  outputLoading.value = true
  try {
    const r = await store.readOutput(s.id)
    outputText.value = r.text.slice(-2000) || '（无输出）'
  } catch {
    outputText.value = '（读取输出失败）'
  } finally {
    outputLoading.value = false
  }
}

function onKill(s: BackgroundSessionInfo): void {
  void store.kill(s.id)
}

function onRemove(s: BackgroundSessionInfo): void {
  if (outputFor.value === s.id) {
    outputFor.value = null
    outputText.value = ''
  }
  void store.remove(s.id)
}
</script>

<template>
  <div
    v-if="store.sessions.length > 0"
    class="bg-panel"
    :class="{ 'bg-panel--fixed': panelHeight !== null }"
    :style="panelHeight !== null ? { height: `${panelHeight}px` } : undefined"
  >
    <div class="bg-panel__grip" title="拖拽调整高度" @mousedown="startResize" />
    <div class="bg-panel__head" @click="expanded = !expanded">
      <span class="bg-panel__title">
        后台任务
        <span v-if="runningCount > 0" class="bg-panel__count">{{ runningCount }}</span>
      </span>
      <NIcon :size="13" class="bg-panel__chevron">
        <ChevronUpOutline v-if="expanded" />
        <ChevronDownOutline v-else />
      </NIcon>
    </div>

    <!-- v-show 放在真实元素上：直接放 NScrollbar 上会因组件链（vueuc ResizeObserver）
         渲染 Fragment 根节点导致运行时指令失效并告警，收起/展开也无法隐藏列表 -->
    <div v-show="expanded" class="bg-panel__list">
      <NScrollbar
        :content-style="{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: '6px' }"
      >
        <div v-for="s in store.sessions" :key="s.id" class="bg-item">
          <div class="bg-item__row">
            <span
              class="bg-item__dot"
              :class="s.exited ? 'bg-item__dot--done' : 'bg-item__dot--run'"
            />
            <span class="bg-item__cmd" :title="s.command">{{ s.command }}</span>
          </div>
          <div class="bg-item__meta">
            <span class="bg-item__state">{{ stateText(s) }}</span>
            <div class="bg-item__actions">
              <NButton quaternary size="tiny" :focusable="false" @click="toggleOutput(s)">
                {{ outputFor === s.id ? '收起' : '输出' }}
              </NButton>
              <template v-if="s.exited">
                <NButton
                  quaternary
                  circle
                  size="tiny"
                  :focusable="false"
                  class="bg-item__rm"
                  title="移除"
                  @click="onRemove(s)"
                >
                  <template #icon>
                    <NIcon><CloseOutline /></NIcon>
                  </template>
                </NButton>
              </template>
              <NPopconfirm
                v-else
                positive-text="终止"
                negative-text="取消"
                @positive-click="onKill(s)"
              >
                <template #trigger>
                  <NButton quaternary size="tiny" :focusable="false" type="error">
                    终止
                  </NButton>
                </template>
                <template #default>
                  终止「{{ s.command.slice(0, 30) }}」？进程组将被强制结束。
                </template>
              </NPopconfirm>
            </div>
          </div>
          <pre v-if="outputFor === s.id" class="bg-item__output">{{
            outputLoading ? '加载中…' : outputText
          }}</pre>
        </div>
      </NScrollbar>
    </div>
  </div>
</template>

<style scoped>
.bg-panel {
  border-top: 1px solid var(--border);
  /* 默认至少容纳约 2~3 个任务项；窗口过矮时受 60% 上限约束不溢出。
     flex-shrink:0 保证面板不被会话列表挤压（列表可滚动，空间让给面板）。 */
  min-height: min(180px, 10%);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}
/* 拖拽固定高度后不受上限与默认最小高度约束（上限由拖拽钳制到 45% 窗口高） */
.bg-panel--fixed {
  max-height: none;
  min-height: 0;
}
.bg-panel__grip {
  height: 5px;
  flex-shrink: 0;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bg-panel__grip::after {
  content: '';
  width: 36px;
  height: 2px;
  border-radius: 1px;
  background: var(--border);
  transition: background 0.15s;
}
.bg-panel__grip:hover::after {
  background: var(--text-3);
}
.bg-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
}
.bg-panel__head:hover {
  background: var(--hover-bg);
}
.bg-panel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.02em;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bg-panel__count {
  background: var(--warning);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 99px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bg-panel__chevron {
  color: var(--text-3);
}
/* 列表用 NScrollbar（与侧栏会话列表一致）：滚动条悬浮不占布局宽度，出现/消失内容宽度不变。
   v-show 挂在外层包装 div 上（NScrollbar 自身作为组件根是 Fragment 链，指令无法生效） */
.bg-panel__list {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.bg-panel__list :deep(.n-scrollbar) {
  flex: 1;
  min-width: 0;
}
.bg-item {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-mute);
  padding: 6px 8px;
}
.bg-item__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bg-item__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.bg-item__dot--run {
  background: var(--warning);
  animation: bg-dot-pulse 1.4s ease-in-out infinite;
}
@keyframes bg-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.bg-item__dot--done {
  background: var(--text-3);
}
.bg-item__cmd {
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.bg-item__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
}
.bg-item__state {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bg-item__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.bg-item__actions :deep(.n-button) {
  font-size: 11px;
  --n-height: 22px;
}
/* 移除（×）按钮：默认弱化，悬停变红 */
.bg-item__rm {
  color: var(--text-3);
}
.bg-item__rm:hover {
  color: var(--error);
}
.bg-item__output {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow: auto;
}
</style>
