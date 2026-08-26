/**
 * ECharts 按需注册（tree-shaking）与内置地图懒加载。
 *
 * 背景：
 * - 直接 `import * as echarts from 'echarts'` 会打进完整 echarts（全部图表/组件/双渲染器），
 *   首屏包体大、图表初始化慢。这里改用 echarts/core + 按需 use，仅注册实际用到的能力。
 * - echarts 5+ 不再内置地图 GeoJSON，`geo.map / series.type='map'` 引用地图时若未
 *   registerMap，图表会渲染空白且仅 console 警告（不抛异常）。本项目内置中国地图
 *   GeoJSON 并懒加载注册（见 assets/geo/china.json），未知地图则抛错供 UI 提示。
 *
 * 用法：
 * ```ts
 * import { init, ensureMapRegistered, collectMapNames } from '@renderer/utils/echarts'
 * ```
 */
export * from 'echarts/core'
import * as echarts from 'echarts/core'
import {
  BarChart,
  LineChart,
  LinesChart,
  PieChart,
  ScatterChart,
  EffectScatterChart,
  MapChart
} from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GeoComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  DataZoomComponent,
  ToolboxComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

// 注册聊天/用量图表实际用到的图表类型、组件与渲染器（dark 主题已随 core 内置注册）。
echarts.use([
  BarChart,
  LineChart,
  LinesChart,
  PieChart,
  ScatterChart,
  EffectScatterChart,
  MapChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GeoComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer
])

/** 内置地图数据（懒加载：仅首个引用该地图的图表触发，生成独立 chunk 不进首屏主包）。 */
const builtinMaps: Record<string, () => Promise<unknown>> = {
  china: () => import('../assets/geo/china.json').then((m) => m.default)
}

/** 进行中的地图加载（同名单次加载，避免重复 import）。 */
const mapLoading = new Map<string, Promise<void>>()

/**
 * 确保某地图已注册。已注册直接返回；内置地图懒加载注册；未知地图抛错（调用方转成
 * 错误提示展示，替代 ECharts 静默空白）。
 */
export async function ensureMapRegistered(name: string): Promise<void> {
  if (echarts.getMap(name)) return
  const loader = builtinMaps[name]
  if (!loader) throw new Error(`未内置地图「${name}」，目前仅支持中国地图`)
  let pending = mapLoading.get(name)
  if (!pending) {
    pending = loader()
      .then((geoJson) => {
        echarts.registerMap(name, geoJson as Parameters<typeof echarts.registerMap>[1])
      })
      .catch((err: unknown) => {
        mapLoading.delete(name)
        throw new Error(
          `地图「${name}」数据加载失败：${err instanceof Error ? err.message : String(err)}`
        )
      })
    mapLoading.set(name, pending)
  }
  await pending
}

/**
 * 从解析后的 ECharts option 收集引用的地图名。
 * 覆盖 `geo` 组件（对象/数组）与 `series.type='map'`（对象/数组）中的 `map` 字段。
 */
export function collectMapNames(option: Record<string, unknown>): string[] {
  const names = new Set<string>()
  const pick = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    const map = (v as Record<string, unknown>).map
    if (typeof map === 'string' && map) names.add(map)
  }
  const geo = option.geo
  if (Array.isArray(geo)) geo.forEach(pick)
  else pick(geo)
  const series = option.series
  if (Array.isArray(series)) series.forEach(pick)
  else pick(series)
  return [...names]
}

/**
 * 修正 AI 生成的 ECharts option 中常见的「无效组合」，避免 setOption 抛错导致图表空白：
 * - `type:'line'` + `geoIndex`：LineChart 仅支持 cartesian/polar 坐标系，放上 geo 会抛
 *   `xAxis not found`。geo 上的路径应使用 `type:'lines'`（LinesChart 原生支持 geo），
 *   此处把数据重组为单条 polyline 并保留线样式；
 * - 仅写 `geoIndex` 而未写 `coordinateSystem:'geo'`：scatter/effectScatter 默认走
 *   cartesian2d，会因找不到 xAxis 抛错，需补上 geo 坐标系声明；
 * - geo/map 系列不支持 markArea/markLine/markPoint（需要直角坐标），剥离避免渲染异常；
 * - 仅接受函数的字段（如 tooltip.valueFormatter）被 AI 写成字符串时，ECharts 在渲染期
 *   （tooltip 触发等）会抛 `valueFormatter is not a function`，递归剥离（见下）。
 * 仅做最小修正，其余配置原样透传。
 */
export function normalizeEChartsOption(option: Record<string, unknown>): Record<string, unknown> {
  const safe = stripFunctionOnlyKeys(option) as Record<string, unknown>
  const series = safe.series
  let out = safe
  if (Array.isArray(series)) {
    out = { ...safe, series: series.map((s) => normalizeSeries(s as Record<string, unknown>)) }
  } else if (series && typeof series === 'object') {
    out = { ...safe, series: normalizeSeries(series as Record<string, unknown>) }
  }
  return sanitizeVisualMapForLine(out)
}

/**
 * 已知「仅接受函数」、AI 误写为字符串会在渲染期抛 TypeError 的字段。
 * 配置来自 JSON（不可能有真函数），命中即剥离。
 */
const FUNCTION_ONLY_KEYS = new Set(['valueFormatter'])

/** 递归剥离「仅接受函数」字段的非函数值（数组/对象内同样处理）。 */
function stripFunctionOnlyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFunctionOnlyKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FUNCTION_ONLY_KEYS.has(k) && typeof v !== 'function') continue
      out[k] = stripFunctionOnlyKeys(v)
    }
    return out
  }
  return value
}

/**
 * 修正「line/lines 系列 + 非 x/y 维度 visualMap」的无效组合：
 * line 系列的 visualMap 只支持按 x/y（dimension 0/1）做视觉映射，配置 dimension>=2
 *（如按第三维风速着色）会触发 ECharts 告警且映射不生效。这里把这类线型系列从
 * visualMap 的 seriesIndex 中剔除（退化为线型默认色）；全部被剔除的 visualMap 项
 * 一并移除，避免空转组件。scatter/effectScatter 支持任意维度，不受影响。
 */
function sanitizeVisualMapForLine(option: Record<string, unknown>): Record<string, unknown> {
  const vm = option.visualMap
  if (vm == null) return option
  const raw = option.series
  const series = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []) as Record<
    string,
    unknown
  >[]
  const vms = (Array.isArray(vm) ? vm : [vm]) as Record<string, unknown>[]
  const kept: Record<string, unknown>[] = []
  let changed = false
  for (const v of vms) {
    if (!v || typeof v !== 'object') {
      kept.push(v)
      continue
    }
    const dim = v.dimension as number | undefined
    // 缺省 dimension=0，line 合法；dimension 0/1 同样合法，直接保留
    if (dim === undefined || dim < 2) {
      kept.push(v)
      continue
    }
    const si = v.seriesIndex
    const idxs: number[] =
      si == null ? series.map((_, i) => i) : Array.isArray(si) ? (si as number[]) : [si as number]
    const keepIdx = idxs.filter((i) => {
      const s = series[i] as Record<string, unknown> | undefined
      return !s || typeof s !== 'object' || (s.type !== 'line' && s.type !== 'lines')
    })
    if (keepIdx.length === idxs.length) {
      kept.push(v)
      continue
    }
    changed = true
    // 目标系列全部是 line/lines：该 visualMap 项无作用，整体移除
    if (keepIdx.length === 0) continue
    kept.push({ ...v, seriesIndex: keepIdx })
  }
  if (!changed) return option
  const next = { ...option }
  if (kept.length === 0) delete next.visualMap
  else next.visualMap = Array.isArray(vm) ? kept : kept[0]
  return next
}

/** 系列是否绑定 geo 坐标系（geoIndex / coordinateSystem:'geo' / map 系列）。 */
function isGeoBound(s: Record<string, unknown>): boolean {
  return (
    (typeof s.geoIndex === 'number' && s.geoIndex >= 0) ||
    s.coordinateSystem === 'geo' ||
    s.type === 'map'
  )
}

function normalizeSeries(s: Record<string, unknown>): Record<string, unknown> {
  if (!isGeoBound(s)) return s
  const clean = { ...s }
  for (const k of ['markArea', 'markLine', 'markPoint']) delete clean[k]
  // map 系列自带坐标系；其余 geoIndex 系列必须显式声明 geo，否则默认走 cartesian2d 抛错。
  if (clean.type !== 'map' && clean.coordinateSystem == null) clean.coordinateSystem = 'geo'
  if (clean.type === 'line') return toGeoLines(clean)
  return clean
}

/** line → lines 转换：把所有折线点收拢成单条 polyline（geo 路径的标准表达）。 */
function toGeoLines(s: Record<string, unknown>): Record<string, unknown> {
  const data = s.data
  const coords: number[][] = []
  if (Array.isArray(data)) {
    for (const d of data) {
      if (d && typeof d === 'object') {
        const v = (d as Record<string, unknown>).value
        if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number') {
          coords.push([v[0], v[1]])
        }
      } else if (Array.isArray(d) && typeof d[0] === 'number' && typeof d[1] === 'number') {
        coords.push([d[0], d[1]])
      }
    }
  }
  const result: Record<string, unknown> = { ...s }
  delete result.symbol
  delete result.symbolSize
  result.type = 'lines'
  result.polyline = true
  result.data = coords.length > 0 ? [{ name: s.name, coords }] : []
  return result
}

/**
 * AI 输出的 ECharts 配置常带小语法问题（注释 / 尾逗号 / 单引号字符串），严格 JSON.parse
 * 会失败。这里先试严格解析，失败再做「去注释 + 去尾逗号 + 单引号转双引号」的宽松修正后
 * 再解析一次，避免这类可直接修复的文本直接落到「源码展示」回退。仍失败返回 null。
 */
export interface LooseJSONResult {
  /** 解析得到的值 */
  value: unknown
  /** 是否经过宽松修正（true 表示原始文本不是标准 JSON） */
  loose: boolean
}

export function parseLooseJSON(text: string): LooseJSONResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return { value: JSON.parse(trimmed), loose: false }
  } catch {
    // 继续宽松尝试
  }
  const strict = toStrictJSON(trimmed)
  if (strict === '') return null
  try {
    return { value: JSON.parse(strict), loose: true }
  } catch {
    return null
  }
}

/**
 * 把「近似 JSON」修正为标准 JSON：单引号字符串转双引号、剥离 // 行注释与多行块注释、
 * 删除对象/数组末尾多余逗号。字符串字面量内的内容不受影响；遇到未闭合字符串等无法
 * 安全处理的情况返回空串（由调用方按解析失败处理）。
 */
function toStrictJSON(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const quote = c
      out += '"'
      i++
      while (i < n) {
        const ch = text[i]
        if (ch === '\\') {
          const next = i + 1 < n ? text[i + 1] : ''
          // 单引号串里的 \' 在双引号串中不是合法转义，去反斜杠转成普通撇号
          if (quote === "'" && next === "'") out += "'"
          else {
            out += ch
            out += next
          }
          i += 2
          continue
        }
        if (ch === quote) {
          out += '"'
          i++
          break
        }
        // 未闭合字符串：放弃本次宽松解析
        if (ch === '\n' || ch === '\r') return ''
        out += ch
        i++
      }
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r'))
        j++
      if (text[j] === '}' || text[j] === ']') {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/**
 * ECharts 配置复杂，AI 生成的 option 即使 JSON 合法也可能因「无效组合」被 setOption 抛错
 *（normalizeEChartsOption 只做最小修正，覆盖不了全部情况）。这里生成从高保真到低保真的
 * 降级候选序列，由组件在 setOption 抛错时依次尝试：
 * 0. 原始 option（已 normalize）——保真度最高；
 * 1. 安全模式：只保留基本组件与受支持的系列，剥离易抛错的高阶配置；
 * 2. 纯数据图：从首条 series 提取数据，重建为 bar/pie/line，保证能画出来。
 * 全部失败才由组件展示错误（附原始配置复制入口）。
 */
export interface EChartsFallback {
  /** 降级后的 option（相对原始配置更保守，保证能通过 setOption） */
  option: Record<string, unknown>
  /** 降级说明（渲染后展示给用户的提示文案） */
  note: string
}

/** 已注册的系列类型（须与顶部 echarts.use 注册列表保持一致）。 */
const REGISTERED_SERIES_TYPES = new Set([
  'bar',
  'line',
  'lines',
  'pie',
  'scatter',
  'effectScatter',
  'map'
])

/** 依赖直角坐标系（grid + x/yAxis）的系列类型。 */
const CARTESIAN_SERIES_TYPES = new Set(['bar', 'line', 'scatter', 'effectScatter'])

export function buildEChartsFallbacks(option: Record<string, unknown>): EChartsFallback[] {
  const out: EChartsFallback[] = []
  const safe = buildSafeOption(option)
  if (safe) {
    out.push({ option: safe, note: '已自动修复：剥离不支持的配置后渲染（可能缺少部分效果）' })
  }
  const dataOnly = buildDataOnlyFallback(option)
  if (dataOnly) out.push(dataOnly)
  return out
}

/**
 * 安全模式：只保留「基本盘」组件（title/legend/grid/xAxis/yAxis/geo/color）与受支持的
 * 系列，自动补齐缺省直角坐标轴，并把越界的轴/坐标系索引收敛到 0。自定义 tooltip
 *（formatter 等）易写错，退化为默认触发形式。依赖特殊坐标系（radar/polar/calendar/
 * parallel 等）或未注册类型的系列直接丢弃；geo 坐标系系列在没有 geo 组件时丢弃
 *（否则会抛「geo 0 not found」）。无法得到任何可用系列时返回 null。
 */
function buildSafeOption(option: Record<string, unknown>): Record<string, unknown> | null {
  const next: Record<string, unknown> = {}
  for (const k of [
    'title',
    'legend',
    'grid',
    'xAxis',
    'yAxis',
    'geo',
    'color',
    'backgroundColor'
  ]) {
    if (option[k] !== undefined) next[k] = option[k]
  }
  const tooltip = option.tooltip
  if (tooltip && typeof tooltip === 'object') {
    const t = tooltip as Record<string, unknown>
    const cleaned: Record<string, unknown> = {}
    if (typeof t.trigger === 'string') cleaned.trigger = t.trigger
    if (t.axisPointer && typeof t.axisPointer === 'object') cleaned.axisPointer = t.axisPointer
    next.tooltip = cleaned
  }
  const rawSeries = (
    Array.isArray(option.series)
      ? option.series
      : option.series && typeof option.series === 'object'
        ? [option.series]
        : []
  ) as Record<string, unknown>[]
  const kept: Record<string, unknown>[] = []
  for (const s of rawSeries) {
    if (!s || typeof s !== 'object') continue
    if (typeof s.type !== 'string' || !REGISTERED_SERIES_TYPES.has(s.type)) continue
    const cs = s.coordinateSystem
    if (typeof cs === 'string' && cs !== 'cartesian2d' && cs !== 'geo') continue
    const clean: Record<string, unknown> = { ...s }
    for (const k of ['markArea', 'markLine', 'markPoint']) delete clean[k]
    // 越界的轴/坐标系索引收敛到 0（缺省轴 ECharts 会自动创建）
    for (const k of ['xAxisIndex', 'yAxisIndex', 'gridIndex', 'geoIndex'] as const) {
      if (typeof clean[k] === 'number' && (clean[k] as number) > 0) clean[k] = 0
    }
    kept.push(clean)
  }
  if (kept.length === 0) return null
  const hasGeo = next.geo !== undefined
  const usable = hasGeo ? kept : kept.filter((s) => s.coordinateSystem !== 'geo')
  if (usable.length === 0) return null
  next.series = usable
  if (usable.some((s) => CARTESIAN_SERIES_TYPES.has(s.type as string))) {
    if (next.xAxis === undefined) next.xAxis = { type: 'category' }
    if (next.yAxis === undefined) next.yAxis = { type: 'value' }
  }
  return next
}

/**
 * 纯数据图：从首条 series 提取 data，按数据类型重建为最简图（数字序列→柱状图、
 * {name,value}→饼图、[x,y] 或 {value:[x,y]}→折线图），保证有图可看。无可用数据返回 null。
 */
function buildDataOnlyFallback(option: Record<string, unknown>): EChartsFallback | null {
  const rawSeries = (
    Array.isArray(option.series)
      ? option.series
      : option.series && typeof option.series === 'object'
        ? [option.series]
        : []
  ) as Record<string, unknown>[]
  const s = rawSeries.find((x) => x && typeof x === 'object' && Array.isArray(x.data))
  if (!s) return null
  const data = (s.data as unknown[]) ?? []
  if (data.length === 0) return null
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  const isPair = (d: unknown): boolean =>
    Array.isArray(d) && d.length >= 2 && num(d[0]) && num(d[1])
  const isValuePair = (d: unknown): boolean =>
    !!d &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    Array.isArray((d as Record<string, unknown>).value) &&
    (d as { value: unknown[] }).value.length >= 2 &&
    num((d as { value: unknown[] }).value[0]) &&
    num((d as { value: unknown[] }).value[1])
  const isNameValue = (d: unknown): boolean =>
    !!d &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    'name' in (d as Record<string, unknown>) &&
    num((d as Record<string, unknown>).value)
  if (data.every(num)) {
    return {
      option: { series: [{ type: 'bar', data: data as number[] }] },
      note: '原始配置无法渲染，已按数据简化为柱状图'
    }
  }
  if (data.every(isNameValue)) {
    const items = (data as { name: unknown; value: unknown }[]).map((d) => ({
      name: d.name,
      value: d.value
    }))
    return {
      option: { series: [{ type: 'pie', data: items }] },
      note: '原始配置无法渲染，已按数据简化为饼图'
    }
  }
  if (data.every(isPair)) {
    const pts = data as [number, number][]
    return {
      option: {
        xAxis: { type: 'category', data: pts.map((p) => p[0]) },
        yAxis: { type: 'value' },
        series: [{ type: 'line', data: pts.map((p) => p[1]) }]
      },
      note: '原始配置无法渲染，已按数据简化为折线图'
    }
  }
  if (data.every(isValuePair)) {
    const pts = (data as { value: [number, number] }[]).map((d) => d.value)
    return {
      option: {
        xAxis: { type: 'category', data: pts.map((p) => p[0]) },
        yAxis: { type: 'value' },
        series: [{ type: 'line', data: pts.map((p) => p[1]) }]
      },
      note: '原始配置无法渲染，已按数据简化为折线图'
    }
  }
  return null
}
