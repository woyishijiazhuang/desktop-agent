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
 * - geo/map 系列不支持 markArea/markLine/markPoint（需要直角坐标），剥离避免渲染异常。
 * 仅做最小修正，其余配置原样透传。
 */
export function normalizeEChartsOption(option: Record<string, unknown>): Record<string, unknown> {
  const series = option.series
  let out = option
  if (Array.isArray(series)) {
    out = { ...option, series: series.map((s) => normalizeSeries(s as Record<string, unknown>)) }
  } else if (series && typeof series === 'object') {
    out = { ...option, series: normalizeSeries(series as Record<string, unknown>) }
  }
  return sanitizeVisualMapForLine(out)
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
