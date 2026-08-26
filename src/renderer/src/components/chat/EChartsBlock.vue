<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  init as echartsInit,
  ensureMapRegistered,
  collectMapNames,
  normalizeEChartsOption,
  parseLooseJSON,
  buildEChartsFallbacks,
  type ECharts
} from '@renderer/utils/echarts'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { AlertCircleOutline, CopyOutline, HammerOutline, RefreshOutline } from '@vicons/ionicons5'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { useCopy } from '@renderer/composables/useCopy'
import { tryPrettyJSON, toCodeFence } from '@renderer/utils/codeBlock'
import { MarkdownRender } from 'markstream-vue'
import { chatMessageContextKey } from './chatMessageContext'

/**
 * markstream 语言级覆盖：```echarts 围栏 → ECharts 图表。
 *
 * 由 markstream-vue 的 setCustomComponents 按 fence 语言精确路由到本组件
 * （自定义组件会收到 node / loading / indexKey / customId / isDark）。
 * node 结构对齐 stream-markdown-parser 的 CodeBlockNode，此处本地声明以避免
 * 依赖第三方包的传递类型。
 */
interface CodeBlockNodeLike {
  code: string
  language: string
  loading?: boolean
  raw?: string
}

const props = defineProps<{
  node: CodeBlockNodeLike
  /** markstream 转发：节点是否仍在流式产出中 */
  loading?: boolean
}>()

const themeStore = useThemeStore()
const chatStore = useChatStore()
const { copy } = useCopy()
const toast = useMessage()

/**
 * 所属消息的 DB id（MessageItem provide 注入；流式未落库时为 undefined）：图表
 * 「重新生成」需要把新配置就地替换回原消息，必须知道要改哪条消息。
 */
const messageId = inject(chatMessageContextKey, ref<number | undefined>(undefined))
/** 是否正在请求重新生成（防重复点击；成功后本组件随新配置重新渲染）。 */
const regenerating = ref(false)

/**
 * 触发重新生成时带给 AI 的上下文：错误态用真实渲染错误，源码回退态（JSON 无法解析）
 * 用合成提示。null 表示当前无需重新生成（图表正常渲染中）。
 */
const regenerateContext = computed(() => {
  if (error.value) return error.value
  if (showFallback.value) return 'ECharts 配置无法解析为 JSON，请重新生成一份标准、可解析的配置'
  return null
})

/** 可触发「重新生成图表」：消息已落库（有 id）、空闲、未在请求中且有上下文。 */
const canRegenerate = computed(
  () =>
    !!regenerateContext.value &&
    messageId.value !== undefined &&
    !regenerating.value &&
    !chatStore.isBusy
)

/** 独立请求 AI 重新生成图表，成功后就地替换本条消息的 echarts 块；失败提示不修改原消息。 */
function onRegenerateChart(): void {
  const ctx = regenerateContext.value
  if (!canRegenerate.value || !ctx || messageId.value === undefined) return
  const sessionId = chatStore.currentSessionId
  if (!sessionId) return
  regenerating.value = true
  void chatStore
    .regenerateChart(sessionId, messageId.value, ctx, rawCode.value)
    .then(() => {
      // 成功：解除 loading，等待 message_end 事件刷新本块；若新配置仍渲染失败，
      // 错误视图按钮恢复可点，允许再次重新生成
      regenerating.value = false
    })
    .catch((err) => {
      regenerating.value = false
      toast.error(`图表重新生成失败：${err instanceof Error ? err.message : String(err)}`)
    })
}

const container = ref<HTMLElement | null>(null)
const chart = ref<ECharts | null>(null)
let resizeObserver: ResizeObserver | null = null

/** 渲染失败提示（地图缺失/加载失败/init 或 setOption 异常），替代 ECharts 静默空白。 */
const error = ref<string | null>(null)
/** 自动修复提示：按原始配置渲染失败、降级成功后说明（null 表示按原始配置渲染）。 */
const repairNote = ref<string | null>(null)
/** 渲染代次：异步渲染中 option/主题变化时使在途渲染失效，避免旧结果覆盖新内容。 */
let renderSeq = 0

/** 节点原始代码（可为空串，流式中途无内容）。 */
const rawCode = computed(() => props.node?.code ?? '')

/**
 * 解析后的图表配置：剥离 height 控制字段，其余作为 ECharts option；解析失败为 null。
 * 优先严格 JSON；失败时走宽松解析（去注释/尾逗号、单引号转双引号），loose 标记用于
 * 渲染成功后提示「已自动修正配置语法」。
 */
const parsed = computed<{
  height: string
  option: Record<string, unknown>
  loose: boolean
} | null>(() => {
  const text = rawCode.value.trim()
  if (!text) return null
  const res = parseLooseJSON(text)
  if (!res) return null
  if (typeof res.value !== 'object' || res.value === null || Array.isArray(res.value)) return null
  const record = res.value as Record<string, unknown>
  const { height, ...option } = record
  return { height: normalizeHeight(height), option, loose: res.loose }
})

/** 是否仍在流式产出。 */
const isStreaming = computed(() => props.loading ?? props.node?.loading ?? false)

/** 终态且 JSON 不可解析时回退为源码展示。 */
const showFallback = computed(
  () => !parsed.value && !isStreaming.value && rawCode.value.trim() !== ''
)

/** 图表容器高度：优先配置中的 height，默认 360px。 */
const chartHeight = computed(() => parsed.value?.height ?? '360px')

/** 回退源码：可解析则 pretty-print（JSON 走 Monaco 高亮），否则原样（pre 纯文本）。 */
const fallback = computed(() => {
  const pretty = tryPrettyJSON(rawCode.value)
  return {
    text: pretty ?? rawCode.value,
    language: (pretty !== null ? 'json' : null) as string | null
  }
})
const fallbackFence = computed(() => toCodeFence(fallback.value.text, fallback.value.language))
const fallbackRenderer = computed<'monaco' | 'pre'>(() =>
  fallback.value.language ? 'monaco' : 'pre'
)

/** height 归一化：数字 / 纯数字字符串 → px，带单位字符串原样，非法回退 360。 */
function normalizeHeight(h: unknown): string {
  if (typeof h === 'number') return `${Math.max(120, Math.round(h))}px`
  if (typeof h === 'string') {
    const n = Number(h)
    if (Number.isFinite(n)) return `${Math.max(120, Math.round(n))}px`
    return h
  }
  return '360px'
}

/** 注入透明背景（保留用户显式指定的 backgroundColor）并对 option 做最小修正
 *（geo 上 line→lines、剥离 geo 系列不支持的 mark*，见 utils/echarts.ts）。 */
function buildEChartsOption(): Record<string, unknown> {
  const base = parsed.value!.option
  return normalizeEChartsOption({
    ...base,
    backgroundColor: base.backgroundColor ?? 'transparent'
  })
}

/**
 * 容器尺寸可用时执行 init / setOption。
 * 原始配置 setOption 抛错时依次尝试降级候选（安全模式 → 纯数据图，见 utils/echarts.ts），
 * 首个成功的候选即最终呈现并提示修复说明；全部失败则回收实例并置 error。
 * 地图注册由 renderChart 在调用前保证（init 依赖地图存在，否则 ECharts 只 console 警告）。
 */
function applyOption(): void {
  if (!container.value) return
  const el = container.value
  if (!el.clientWidth || !el.clientHeight) return
  try {
    if (!chart.value) {
      chart.value = echartsInit(el, themeStore.isDark ? 'dark' : undefined)
    }
    const base = buildEChartsOption()
    const attempts: { option: Record<string, unknown>; note: string | null }[] = [
      { option: base, note: parsed.value?.loose ? '配置语法不标准，已自动修正后渲染' : null },
      ...buildEChartsFallbacks(base).map((f) => ({ option: f.option, note: f.note }))
    ]
    let lastErr: unknown = null
    for (const attempt of attempts) {
      try {
        // 前一档 setOption 抛错可能留下部分状态，先清空再试下一档
        chart.value.clear()
        chart.value.setOption(attempt.option)
        repairNote.value = attempt.note
        error.value = null
        return
      } catch (e) {
        lastErr = e
      }
    }
    disposeChart()
    repairNote.value = null
    error.value = `图表渲染失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}（已尝试自动修复，仍无法渲染）`
  } catch (e) {
    disposeChart()
    repairNote.value = null
    error.value = `图表渲染失败：${e instanceof Error ? e.message : String(e)}`
  }
}

function disposeChart(): void {
  chart.value?.dispose()
  chart.value = null
}

/**
 * 渲染入口：先确保 option 引用的地图已注册（懒加载，见 utils/echarts.ts），
 * 再等容器就绪后 applyOption。
 */
async function renderChart(): Promise<void> {
  if (!parsed.value) return
  const seq = ++renderSeq
  error.value = null
  repairNote.value = null
  try {
    for (const name of collectMapNames(parsed.value.option)) {
      await ensureMapRegistered(name)
    }
  } catch (e) {
    if (seq === renderSeq) error.value = e instanceof Error ? e.message : String(e)
    return
  }
  await nextTick()
  if (!container.value || seq !== renderSeq) return
  applyOption()
}

// 内容变化：JSON 可解析时更新图表；变为不可解析（流式中途）时保留已有图表不闪断，
// 终态不可解析则由 showFallback 接管模板。
watch(parsed, (p) => {
  if (p) void renderChart()
  else {
    error.value = null
    repairNote.value = null
  }
})

// 主题切换：销毁重建以应用 echarts 内置 dark 主题。
watch(
  () => themeStore.isDark,
  () => {
    if (!parsed.value) return
    renderSeq++
    disposeChart()
    void renderChart()
  }
)

// 容器模板 ref（v-if 分支切换时自动更新）：挂载即观察，负责
// - 容器尺寸变化时 resize 图表；
// - 容器从 0 尺寸变为可见（虚拟滚动 / 懒挂载 / 错误恢复）时补渲染（含地图注册）。
watch(
  container,
  (el) => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!el) {
      // 图表容器被卸载（回到占位/错误/回退态）：回收实例，避免复用已脱离 DOM 的画布
      disposeChart()
      return
    }
    resizeObserver = new ResizeObserver(() => {
      if (!container.value) return
      if (!chart.value) {
        if (parsed.value && container.value.clientWidth > 0) void renderChart()
        return
      }
      chart.value.resize()
    })
    resizeObserver.observe(el)
    if (parsed.value) void renderChart()
  },
  { flush: 'post' }
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  disposeChart()
})

function onCopyOption(): void {
  void copy(rawCode.value, '图表配置')
}
</script>

<template>
  <div class="echarts-block">
    <!-- 终态且 JSON 不可解析：回退为源码展示（语言标签 + 重新生成 + 复制） -->
    <div v-if="showFallback" class="echarts-block__fallback">
      <div class="echarts-block__head">
        <span class="echarts-block__lang">echarts</span>
        <div class="echarts-block__head-actions">
          <NButton
            v-if="canRegenerate || regenerating"
            quaternary
            size="tiny"
            :focusable="false"
            :loading="regenerating"
            title="配置无法解析，让 AI 重新生成图表"
            @click="onRegenerateChart"
          >
            <template #icon
              ><NIcon><RefreshOutline /></NIcon
            ></template>
            重新生成
          </NButton>
          <NButton
            quaternary
            size="tiny"
            :focusable="false"
            title="复制图表配置"
            @click="onCopyOption"
          >
            <template #icon
              ><NIcon><CopyOutline /></NIcon
            ></template>
          </NButton>
        </div>
      </div>
      <div class="echarts-block__code-wrap">
        <MarkdownRender
          mode="chat"
          custom-id="echarts-fallback"
          :content="fallbackFence"
          final
          :code-renderer="fallbackRenderer"
          :is-dark="themeStore.isDark"
          :code-block-props="{
            showCopyButton: false,
            showHeader: false,
            theme: { light: 'vitesse-light', dark: 'vitesse-dark' },
            monacoOptions: { wordWrap: 'on' }
          }"
          class="echarts-block__markdown"
        />
      </div>
    </div>

    <!-- 渲染失败（地图缺失/加载失败/init 异常）：错误提示 + 重新生成 + 复制配置 -->
    <div v-else-if="error" class="echarts-block__error">
      <div class="echarts-block__head">
        <span class="echarts-block__lang">echarts</span>
        <div class="echarts-block__head-actions">
          <NButton
            v-if="canRegenerate || regenerating"
            quaternary
            size="tiny"
            :focusable="false"
            :loading="regenerating"
            title="根据错误信息与原始配置让 AI 重新生成图表"
            @click="onRegenerateChart"
          >
            <template #icon
              ><NIcon><RefreshOutline /></NIcon
            ></template>
            重新生成
          </NButton>
          <NButton
            quaternary
            size="tiny"
            :focusable="false"
            title="复制图表配置"
            @click="onCopyOption"
          >
            <template #icon
              ><NIcon><CopyOutline /></NIcon
            ></template>
          </NButton>
        </div>
      </div>
      <div class="echarts-block__error-msg">
        <NIcon :size="14" class="echarts-block__error-icon"><AlertCircleOutline /></NIcon>
        <span>{{ error }}</span>
      </div>
    </div>

    <!-- 图表（下方可带自动修复提示条） -->
    <template v-else-if="parsed">
      <div ref="container" class="echarts-block__chart" :style="{ height: chartHeight }" />
      <div v-if="repairNote" class="echarts-block__repair">
        <NIcon :size="13" class="echarts-block__repair-icon"><HammerOutline /></NIcon>
        <span class="echarts-block__repair-text">{{ repairNote }}</span>
      </div>
    </template>

    <!-- 流式中尚未产出合法 JSON -->
    <div v-else-if="rawCode.trim()" class="echarts-block__placeholder">图表生成中…</div>
  </div>
</template>

<style scoped>
.echarts-block {
  margin: 10px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  overflow: hidden;
  max-width: 100%;
}
.echarts-block__chart {
  width: 100%;
  min-height: 120px;
}
.echarts-block__placeholder {
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-3);
}
.echarts-block__fallback {
  font-size: 12px;
}
.echarts-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-soft);
}
.echarts-block__head-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.echarts-block__lang {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
.echarts-block__code-wrap {
  padding: 10px 12px;
  background: var(--code-bg);
  max-height: 400px;
  overflow: auto;
  scrollbar-gutter: stable;
}
.echarts-block__markdown {
  font-size: 12px;
  max-width: 100%;
}
.echarts-block__markdown :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
}
.echarts-block__error-msg {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--error);
  background: var(--error-soft);
  word-break: break-all;
}
.echarts-block__error-icon {
  flex-shrink: 0;
  margin-top: 1px;
}
/* 自动修复提示条：降级渲染成功时说明，警示色弱底 + 图标 + 文案 */
.echarts-block__repair {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warning);
  background: var(--warning-soft);
  border-top: 1px solid var(--border-soft);
}
.echarts-block__repair-icon {
  flex-shrink: 0;
}
</style>
