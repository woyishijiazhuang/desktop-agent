<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NIcon, NPopover, NSpin } from 'naive-ui'
import { ArchiveOutline } from '@vicons/ionicons5'
import { init as echartsInit, type ECharts, type EChartsCoreOption } from '@renderer/utils/echarts'
import { useChatStore } from '@renderer/store/useChatStore'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { mainClient } from '@renderer/utils/main-client'
import { formatCompactTokens, formatContextWindow } from '@renderer/utils/format'

/** 达到压缩阈值变橙、≥90% 变红。 */
const DANGER_FRACTION = 0.9

interface ContextUsage {
  contextWindow: number
  threshold: number
  summaryTokens: number
  chatTokens: number
  toolTokens: number
  systemTokens: number
  usedTotal: number
}

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ compress: [] }>()

const chatStore = useChatStore()
const theme = useThemeStore()

const usage = ref<ContextUsage | null>(null)
const loading = ref(false)
const popoverShow = ref(false)

/** 占用百分比（0~100，无会话/无模型为 0）。 */
const percent = computed(() => {
  const u = usage.value
  if (!u || u.contextWindow <= 0) return 0
  return Math.min(100, (u.usedTotal / u.contextWindow) * 100)
})

/** 状态色：danger > warn > 常规。 */
const stateClass = computed(() =>
  percent.value >= DANGER_FRACTION * 100
    ? 'ctx-ring--danger'
    : percent.value >= (usage.value?.threshold ?? 100)
      ? 'ctx-ring--warn'
      : ''
)

/** 剩余可用 token（下限 0）。 */
const freeTokens = computed(() => {
  const u = usage.value
  return u ? Math.max(0, u.contextWindow - u.usedTotal) : 0
})

/** 文本提示（按占用状态给出建议）。 */
const advice = computed(() => {
  const u = usage.value
  if (!u || u.contextWindow <= 0) return ''
  if (percent.value >= DANGER_FRACTION * 100) return '上下文接近溢出，建议立即压缩历史或开启新会话'
  if (percent.value >= u.threshold) return `已达压缩阈值（${u.threshold}%），建议压缩历史释放空间`
  return '上下文空间充足'
})

// ==================== 数据刷新 ====================

let timer: ReturnType<typeof setTimeout> | undefined
function scheduleRefresh(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 300)
}

async function refresh(): Promise<void> {
  const sessionId = chatStore.currentSessionId
  if (!sessionId) {
    usage.value = null
    return
  }
  loading.value = true
  try {
    usage.value = await mainClient.agent.getSessionContextUsage(sessionId)
  } catch {
    usage.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => chatStore.currentSessionId,
  () => void refresh()
)
watch(
  () => chatStore.isBusy,
  (busy, prev) => {
    if (!busy && prev) scheduleRefresh()
  }
)
watch(
  () => chatStore.compressLastIndex,
  () => scheduleRefresh()
)

// ==================== ECharts 详情 ====================

const chartEl = ref<HTMLElement | null>(null)
let chart: ECharts | null = null

/** 方案 B 分段条：各段占模型窗口的百分比宽度（剩余为轨道底色）。 */
function segWidth(key: 'chat' | 'tool' | 'system' | 'summary'): string {
  const u = usage.value
  if (!u || u.contextWindow <= 0) return '0%'
  const v =
    key === 'chat'
      ? u.chatTokens
      : key === 'tool'
        ? u.toolTokens
        : key === 'system'
          ? u.systemTokens
          : u.summaryTokens
  return `${(v / u.contextWindow) * 100}%`
}

const chartOption = computed<EChartsCoreOption>(() => {
  const u = usage.value
  const border = theme.isDark ? '#18181b' : '#ffffff'
  const labelColor = theme.isDark ? '#f4f4f5' : '#27272a'
  // 顶部饼图：分段构成（对话/工具/系统/摘要），标注带引出线、文字在上、占用在下
  const pieData = [
    { name: '对话', value: u?.chatTokens ?? 0, itemStyle: { color: '#6d5ce7' } },
    { name: '工具', value: u?.toolTokens ?? 0, itemStyle: { color: '#ec4899' } },
    { name: '系统', value: u?.systemTokens ?? 0, itemStyle: { color: '#9aa3ad' } },
    { name: '摘要', value: u?.summaryTokens ?? 0, itemStyle: { color: '#14b8a6' } }
  ].filter((d) => d.value > 0)
  return {
    series: [
      {
        type: 'pie',
        radius: ['36%', '62%'],
        center: ['50%', '52%'],
        avoidLabelOverlap: true,
        minAngle: 3,
        itemStyle: { borderColor: border, borderWidth: 1, borderRadius: 2 },
        label: {
          position: 'outside',
          fontSize: 11,
          lineHeight: 15,
          color: labelColor,
          formatter: (p: { name: string; value: number }) =>
            `${p.name}\n${formatCompactTokens(p.value)}`
        },
        labelLine: { length: 10, length2: 8, lineStyle: { color: '#9aa3ad' } },
        data: pieData
      }
    ]
  }
})

function renderChart(): void {
  if (!chartEl.value) return
  if (!chart) chart = echartsInit(chartEl.value)
  chart.setOption(chartOption.value, true)
}

function disposeChart(): void {
  chart?.dispose()
  chart = null
}

// 弹层打开时先刷新数据，等 DOM 就绪再渲染图表；关闭时销毁释放资源
watch(popoverShow, async (show) => {
  if (show) {
    await refresh()
    await nextTick()
    renderChart()
  } else {
    disposeChart()
  }
})

/** 点击压缩：关闭弹层并通知父组件执行压缩确认流程。 */
function onCompressClick(): void {
  popoverShow.value = false
  emit('compress')
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  disposeChart()
})
</script>

<template>
  <NPopover
    v-model:show="popoverShow"
    trigger="click"
    placement="top-start"
    :disabled="disabled || !chatStore.currentSessionId"
    :style="{ padding: '0', borderRadius: '12px', width: '330px' }"
  >
    <template #trigger>
      <NButton
        quaternary
        circle
        size="small"
        class="sidebar__foot-btn ctx-ring"
        :class="stateClass"
        :disabled="disabled"
        title="上下文占用与压缩"
      >
        <template #icon>
          <span class="ctx-ring__wrap">
            <svg class="ctx-ring__svg" viewBox="0 0 36 36">
              <circle class="ctx-ring__track" cx="18" cy="18" r="15" />
              <circle
                class="ctx-ring__fill"
                cx="18"
                cy="18"
                r="15"
                :stroke-dasharray="2 * Math.PI * 15"
                :stroke-dashoffset="2 * Math.PI * 15 * (1 - percent / 100)"
              />
            </svg>
            <NIcon :size="14" class="ctx-ring__icon"><ArchiveOutline /></NIcon>
          </span>
        </template>
      </NButton>
    </template>

    <!-- 详情面板：ECharts（gauge + 分段）+ 文本提示 + 压缩动作 -->
    <div class="ctx-detail">
      <div class="ctx-detail__head">
        <span class="ctx-detail__title">上下文占用</span>
        <span class="ctx-detail__summary" :class="stateClass">
          {{
            usage
              ? `${formatCompactTokens(usage.usedTotal)} / ${formatContextWindow(usage.contextWindow)}`
              : '—'
          }}
        </span>
      </div>

      <div class="ctx-detail__chart">
        <div v-if="loading" class="ctx-detail__loading">
          <NSpin size="small" />
        </div>
        <div ref="chartEl" class="ctx-detail__chart-el"></div>
      </div>

      <!-- 方案 B 风格：分段占用条（各段占模型窗口比例，剩余为轨道底色） -->
      <div class="ctx-bar">
        <div class="ctx-bar__track">
          <span
            v-if="(usage?.chatTokens ?? 0) > 0"
            class="ctx-bar__seg ctx-bar__seg--chat"
            :style="{ width: segWidth('chat') }"
          ></span>
          <span
            v-if="(usage?.toolTokens ?? 0) > 0"
            class="ctx-bar__seg ctx-bar__seg--tool"
            :style="{ width: segWidth('tool') }"
          ></span>
          <span
            v-if="(usage?.systemTokens ?? 0) > 0"
            class="ctx-bar__seg ctx-bar__seg--sys"
            :style="{ width: segWidth('system') }"
          ></span>
          <span
            v-if="(usage?.summaryTokens ?? 0) > 0"
            class="ctx-bar__seg ctx-bar__seg--summary"
            :style="{ width: segWidth('summary') }"
          ></span>
        </div>
        <div class="ctx-bar__meta">
          已用
          {{ usage ? formatCompactTokens(usage.usedTotal) : '—' }} /
          {{ usage ? formatContextWindow(usage.contextWindow) : '—' }}
        </div>
      </div>

      <div class="ctx-detail__hints">
        <div class="ctx-detail__hint">
          剩余约 <b>{{ formatCompactTokens(freeTokens) }}</b> · 自动压缩阈值
          {{ usage?.threshold ?? 70 }}%
        </div>
        <div class="ctx-detail__advice" :class="stateClass">{{ advice }}</div>
      </div>

      <div class="ctx-detail__actions">
        <NButton size="small" type="primary" :disabled="disabled" @click="onCompressClick">
          压缩历史
        </NButton>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.ctx-ring__wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}
.ctx-ring__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ctx-ring__track {
  fill: none;
  stroke: var(--bg-mute);
  stroke-width: 2.5;
}
.ctx-ring__fill {
  fill: none;
  stroke: var(--primary);
  stroke-width: 2.5;
  stroke-linecap: round;
  transition:
    stroke-dashoffset 0.3s ease,
    stroke 0.2s ease;
}
.ctx-ring--warn .ctx-ring__fill {
  stroke: #f59e0b;
}
.ctx-ring--danger .ctx-ring__fill {
  stroke: #ef4444;
}
.ctx-ring__icon {
  color: var(--text-2);
}

.ctx-detail {
  padding: 14px 14px 12px;
}
.ctx-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.ctx-detail__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.ctx-detail__summary {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.ctx-detail__summary.ctx-ring--warn,
.ctx-detail__advice.ctx-ring--warn {
  color: #f59e0b;
}
.ctx-detail__summary.ctx-ring--danger,
.ctx-detail__advice.ctx-ring--danger {
  color: #ef4444;
}
.ctx-detail__chart {
  position: relative;
  height: 178px;
}
.ctx-detail__chart-el {
  width: 100%;
  height: 100%;
}
.ctx-detail__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 方案 B 风格：分段占用条 */
.ctx-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.ctx-bar__track {
  display: flex;
  height: 7px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-mute);
}
.ctx-bar__seg {
  height: 100%;
}
.ctx-bar__seg--chat {
  background: #6d5ce7;
}
.ctx-bar__seg--tool {
  background: #ec4899;
}
.ctx-bar__seg--sys {
  background: #9aa3ad;
}
.ctx-bar__seg--summary {
  background: #14b8a6;
}
.ctx-bar__meta {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.ctx-detail__hints {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ctx-detail__hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}
.ctx-detail__hint b {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ctx-detail__advice {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.5;
}
.ctx-detail__actions {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}
</style>
