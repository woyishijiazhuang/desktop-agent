<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { init as echartsInit, type ECharts, type EChartsCoreOption } from '@renderer/utils/echarts'
import { NRadioGroup, NRadioButton, NSpin, NEmpty } from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { formatTokens, formatCompactTokens, formatCost } from '@renderer/utils/format'
import type { UsageStats, UsageRangeDays, UsageModelStat } from '@main/database'

/** 面板激活（SettingsView 切到「用量」页）时自动刷新数据。 */
const props = defineProps<{ active: boolean }>()

const theme = useThemeStore()
const modelConfigs = useModelConfigsStore()

/** 时间范围选择（哨兵值，null 不适用于 NRadioButton 的 value 类型）。 */
type RangeKey = '7' | '30' | 'all'
const rangeKey = ref<RangeKey>('7')
const stats = ref<UsageStats | null>(null)
const loading = ref(false)

const rangeOptions: { label: string; value: RangeKey }[] = [
  { label: '近 7 天', value: '7' },
  { label: '近 30 天', value: '30' },
  { label: '全部', value: 'all' }
]

function toRangeDays(key: RangeKey): UsageRangeDays {
  return key === 'all' ? null : key === '30' ? 30 : 7
}

async function load(): Promise<void> {
  loading.value = true
  try {
    stats.value = await mainClient.db.getUsageStats(toRangeDays(rangeKey.value))
  } finally {
    loading.value = false
  }
}

// 切换范围立即重新查询
watch(rangeKey, () => {
  void load()
})

// 面板挂载或从隐藏切到可见时刷新（v-show 常驻挂载，切页后数据保持最新）
watch(
  () => props.active,
  (v) => {
    if (v) void load()
  }
)

/** 无任何用量数据时的空状态。 */
const isEmpty = computed(
  () => !!stats.value && stats.value.calls === 0 && stats.value.messages === 0
)

// ==================== ECharts 每日趋势 ====================

const chartEl = ref<HTMLElement | null>(null)
let chart: ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const axisColor = computed(() => (theme.isDark ? '#a1a1aa' : '#71717a'))
const splitLineColor = computed(() => (theme.isDark ? '#2a2a2e' : '#e4e4e7'))

const chartOption = computed<EChartsCoreOption>(() => {
  const days = stats.value?.byDay ?? []
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as { axisValueLabel: string; seriesName: string; value: number }[]
        const total = list.reduce((acc, p) => acc + (Number(p.value) || 0), 0)
        const lines = list.map((p) => `${p.seriesName}：${formatTokens(Number(p.value) || 0)}`)
        return `${list[0]?.axisValueLabel ?? ''}<br/>${lines.join('<br/>')}<br/><b>合计：${formatTokens(total)}</b>`
      }
    },
    legend: {
      data: ['输入', '输出'],
      top: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { fontSize: 12, color: axisColor.value }
    },
    grid: { left: 4, right: 4, top: 30, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: days.map((d) => d.day.slice(5)),
      axisLine: { lineStyle: { color: splitLineColor.value } },
      axisTick: { show: false },
      axisLabel: { color: axisColor.value, fontSize: 11, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: splitLineColor.value } },
      axisLabel: {
        color: axisColor.value,
        fontSize: 11,
        formatter: (v: number) => formatCompactTokens(v)
      }
    },
    series: [
      {
        name: '输入',
        type: 'bar',
        stack: 'tokens',
        barMaxWidth: 22,
        itemStyle: { color: '#8b5cf6', borderRadius: [0, 0, 0, 0] },
        data: days.map((d) => d.promptTokens)
      },
      {
        name: '输出',
        type: 'bar',
        stack: 'tokens',
        barMaxWidth: 22,
        itemStyle: { color: '#14b8a6', borderRadius: [3, 3, 0, 0] },
        data: days.map((d) => d.completionTokens)
      }
    ]
  }
})

function renderChart(): void {
  if (!chartEl.value) return
  const el = chartEl.value
  // 容器不可见（v-show 隐藏）时跳过，待可见后由 ResizeObserver 补初始化
  if (!el.clientWidth || !el.clientHeight) return
  if (!chart) chart = echartsInit(el, theme.isDark ? 'dark' : undefined)
  chart.setOption(chartOption.value)
}

function disposeChart(): void {
  chart?.dispose()
  chart = null
}

// 数据更新后重绘
watch(chartOption, () => renderChart())

// 主题切换：销毁重建以应用 echarts 内置 dark 主题
watch(
  () => theme.isDark,
  () => {
    disposeChart()
    renderChart()
  }
)

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (!chartEl.value) return
    if (!chart) {
      if (chartEl.value.clientWidth > 0) renderChart()
      return
    }
    chart.resize()
  })
  if (chartEl.value) resizeObserver.observe(chartEl.value)
  // 模型分布要映射 displayName，确保配置列表已加载
  if (modelConfigs.configs.length === 0) void modelConfigs.load()
  void load()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  disposeChart()
})

// ==================== 模型分布 ====================

/** 模型条形图宽度百分比（相对最大模型）。 */
function modelBarWidth(m: UsageModelStat): string {
  const max = Math.max(1, ...stats.value!.byModel.map((x) => x.totalTokens))
  return `${Math.round((m.totalTokens / max) * 100)}%`
}

/** 展示名：优先映射到模型配置的 displayName（provider = config.id），否则回退模型 id。 */
function modelName(m: UsageModelStat): string {
  const config = modelConfigs.configs.find((c) => c.id === m.provider && c.modelId === m.model)
  return config?.displayName ?? m.model
}

/** 模型来源定位信息（悬浮提示用）：provider · model。 */
function modelSource(m: UsageModelStat): string {
  return m.provider ? `${m.provider} · ${m.model}` : m.model
}
</script>

<template>
  <div class="usage-panel">
    <div class="usage-panel__head">
      <span class="usage-panel__hint">
        基于所有 LLM 调用（对话 / 标题生成 / 压缩摘要）的 token 用量统计，不含回收站会话。
      </span>
      <NRadioGroup :value="rangeKey" size="small" @update:value="(v) => (rangeKey = v as RangeKey)">
        <NRadioButton v-for="opt in rangeOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </NRadioButton>
      </NRadioGroup>
    </div>

    <NSpin :show="loading && !stats">
      <div v-if="!stats" class="usage-panel__loading" />
      <div v-else-if="isEmpty" class="usage-panel__empty">
        <NEmpty description="暂无用量数据" />
      </div>
      <template v-else>
        <!-- 汇总卡片 -->
        <div class="usage-cards">
          <div class="usage-card">
            <span class="usage-card__label">总 Token</span>
            <span class="usage-card__value">{{ formatTokens(stats.totalTokens) }}</span>
          </div>
          <div class="usage-card">
            <span class="usage-card__label">输入 Token</span>
            <span class="usage-card__value">{{ formatTokens(stats.promptTokens) }}</span>
          </div>
          <div class="usage-card">
            <span class="usage-card__label">输出 Token</span>
            <span class="usage-card__value">{{ formatTokens(stats.completionTokens) }}</span>
          </div>
          <div class="usage-card">
            <span class="usage-card__label">成本</span>
            <span class="usage-card__value">{{ formatCost(stats.cost) }}</span>
          </div>
          <div class="usage-card">
            <span class="usage-card__label">调用次数</span>
            <span class="usage-card__value">{{ stats.calls }}</span>
          </div>
          <div class="usage-card">
            <span class="usage-card__label">消息 / 会话</span>
            <span class="usage-card__value">{{ stats.messages }} / {{ stats.sessions }}</span>
          </div>
        </div>

        <!-- 每日趋势 -->
        <div class="usage-section">
          <div class="usage-section__title">每日 Token 用量</div>
          <div ref="chartEl" class="usage-chart" />
        </div>

        <!-- 模型分布 -->
        <div v-if="stats.byModel.length > 0" class="usage-section">
          <div class="usage-section__title">按模型统计</div>
          <div class="usage-models">
            <div v-for="m in stats.byModel" :key="`${m.provider}:${m.model}`" class="usage-model">
              <div class="usage-model__head">
                <span class="usage-model__name" :title="modelSource(m)">{{ modelName(m) }}</span>
                <span class="usage-model__num">
                  {{ formatTokens(m.totalTokens) }} tokens · {{ m.messageCount }} 次
                </span>
              </div>
              <div class="usage-model__track">
                <div class="usage-model__bar" :style="{ width: modelBarWidth(m) }" />
              </div>
              <div class="usage-model__foot">
                <span>输入 {{ formatTokens(m.promptTokens) }}</span>
                <span>输出 {{ formatTokens(m.completionTokens) }}</span>
                <span>成本 {{ formatCost(m.cost) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </NSpin>
  </div>
</template>

<style scoped>
.usage-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.usage-panel__hint {
  font-size: 12px;
  color: var(--text-3);
}
.usage-panel__loading {
  height: 200px;
}
.usage-panel__empty {
  padding: 32px 0;
}

/* ===== 汇总卡片 ===== */
.usage-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.usage-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.usage-card__label {
  font-size: 12px;
  color: var(--text-3);
}
.usage-card__value {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}

/* ===== 区块 ===== */
.usage-section {
  margin-top: 20px;
}
.usage-section__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 10px;
}
.usage-chart {
  width: 100%;
  height: 240px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  padding: 8px;
}

/* ===== 模型分布 ===== */
.usage-models {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.usage-model {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.usage-model__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.usage-model__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-model__num {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-3);
}
.usage-model__track {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-mute);
  overflow: hidden;
}
.usage-model__bar {
  height: 100%;
  border-radius: 3px;
  background: var(--primary);
  transition: width 0.3s ease;
}
.usage-model__foot {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
}
</style>
