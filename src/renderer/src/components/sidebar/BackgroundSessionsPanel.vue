<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NIcon, NPopconfirm } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline } from '@vicons/ionicons5'
import { useBackgroundStore } from '@renderer/store/useBackgroundStore'
import type { BackgroundSessionInfo } from '@main/agent/tools/bash-session'

/**
 * 侧栏「后台命令」面板：展示所有后台运行的命令（全局，与当前会话无关），
 * 支持查看输出 / 终止。状态由 main 推送快照驱动（启动/退出/终止时全量更新）。
 */
const store = useBackgroundStore()

/** 面板展开/收起。 */
const expanded = ref(true)
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

/** 状态提示文案。 */
function stateText(s: BackgroundSessionInfo): string {
  if (!s.exited) return `运行中 · ${elapsed(s)}`
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
</script>

<template>
  <div v-if="store.sessions.length > 0" class="bg-panel">
    <div class="bg-panel__head" @click="expanded = !expanded">
      <span class="bg-panel__title">
        后台命令
        <span v-if="runningCount > 0" class="bg-panel__count">{{ runningCount }}</span>
      </span>
      <NIcon :size="13" class="bg-panel__chevron">
        <ChevronUpOutline v-if="expanded" />
        <ChevronDownOutline v-else />
      </NIcon>
    </div>

    <div v-show="expanded" class="bg-panel__list">
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
            <NPopconfirm
              :disabled="s.exited"
              positive-text="终止"
              negative-text="取消"
              @positive-click="onKill(s)"
            >
              <template #trigger>
                <NButton
                  quaternary
                  size="tiny"
                  :focusable="false"
                  :disabled="s.exited"
                  type="error"
                >
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
    </div>
  </div>
</template>

<style scoped>
.bg-panel {
  border-top: 1px solid var(--border);
  max-height: 40%;
  display: flex;
  flex-direction: column;
  min-height: 0;
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
.bg-panel__list {
  overflow: auto;
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  scrollbar-gutter: stable;
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
  max-height: 160px;
  overflow: auto;
}
</style>
