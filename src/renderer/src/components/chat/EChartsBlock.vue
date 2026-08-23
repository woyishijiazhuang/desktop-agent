<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  init as echartsInit,
  ensureMapRegistered,
  collectMapNames,
  normalizeEChartsOption,
  type ECharts
} from '@renderer/utils/echarts'
import { NButton, NIcon } from 'naive-ui'
import { AlertCircleOutline, CopyOutline } from '@vicons/ionicons5'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { useCopy } from '@renderer/composables/useCopy'
import { tryPrettyJSON, toCodeFence } from '@renderer/utils/codeBlock'
import { MarkdownRender } from 'markstream-vue'

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
const { copy } = useCopy()

const container = ref<HTMLElement | null>(null)
const chart = ref<ECharts | null>(null)
let resizeObserver: ResizeObserver | null = null

/** 渲染失败提示（地图缺失/加载失败/init 或 setOption 异常），替代 ECharts 静默空白。 */
const error = ref<string | null>(null)
/** 渲染代次：异步渲染中 option/主题变化时使在途渲染失效，避免旧结果覆盖新内容。 */
let renderSeq = 0

/** 节点原始代码（可为空串，流式中途无内容）。 */
const rawCode = computed(() => props.node?.code ?? '')

/** 解析后的图表配置：剥离 height 控制字段，其余作为 ECharts option；解析失败为 null。 */
const parsed = computed<{ height: string; option: Record<string, unknown> } | null>(() => {
  const text = rawCode.value.trim()
  if (!text) return null
  try {
    const obj: unknown = JSON.parse(text)
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
    const record = obj as Record<string, unknown>
    const { height, ...option } = record
    return { height: normalizeHeight(height), option }
  } catch {
    return null
  }
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
 * 容器尺寸可用时执行 init / setOption；失败回收实例并置 error。
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
    chart.value.setOption(buildEChartsOption())
  } catch (e) {
    disposeChart()
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
  else error.value = null
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
    <!-- 终态且 JSON 不可解析：回退为源码展示（语言标签 + 复制） -->
    <div v-if="showFallback" class="echarts-block__fallback">
      <div class="echarts-block__head">
        <span class="echarts-block__lang">echarts</span>
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

    <!-- 渲染失败（地图缺失/加载失败/init 异常）：错误提示 + 复制配置 -->
    <div v-else-if="error" class="echarts-block__error">
      <div class="echarts-block__head">
        <span class="echarts-block__lang">echarts</span>
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
      <div class="echarts-block__error-msg">
        <NIcon :size="14" class="echarts-block__error-icon"><AlertCircleOutline /></NIcon>
        <span>{{ error }}</span>
      </div>
    </div>

    <!-- 图表 -->
    <div
      v-else-if="parsed"
      ref="container"
      class="echarts-block__chart"
      :style="{ height: chartHeight }"
    />

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
</style>
