import { computed, type ComputedRef } from 'vue'
import { darkTheme, type GlobalTheme, type GlobalThemeOverrides } from 'naive-ui'
import { useThemeStore } from '../store/useThemeStore'

/**
 * 品牌主题合成（浅/深 Naive UI themeOverrides + darkTheme 开关）。
 * 供工作区内容根组件（App.vue）与设置窗口根组件（settings/App.vue）共用，
 * 保证两处 Naive UI 配色始终一致。主色取自 useThemeStore 的主题色 palette。
 */

/** 品牌静态覆盖（非主色部分，浅/深共享）：圆角、字体族。主色随主题色 palette 动态取。 */
const brandStatic: GlobalThemeOverrides['common'] = {
  borderRadius: '8px',
  borderRadiusSmall: '6px',
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
  fontWeightStrong: '600'
}

/** 浅色主色覆盖：取自主题色 palette 的 light 组（默认紫罗兰），Naive UI 据此派生相关色。 */
const brand = computed<GlobalThemeOverrides['common']>(() => {
  const t = useThemeStore().tokensFor('light')
  return {
    ...brandStatic,
    primaryColor: t.primary,
    primaryColorHover: t.hover,
    primaryColorPressed: t.pressed,
    primaryColorSuppl: t.primary
  }
})

/** 深色模式表面色对齐（与浅色共享的非色 token 之外）。 */
const darkSurfaceStatic: GlobalThemeOverrides['common'] = {
  bodyColor: '#18181b',
  cardColor: '#1f1f23',
  modalColor: '#1f1f23',
  popoverColor: '#1f1f23',
  inputColor: '#18181b',
  borderColor: '#2a2a2e',
  dividerColor: '#2a2a2e',
  textColorBase: '#f4f4f5',
  textColor1: '#f4f4f5',
  textColor2: '#a1a1aa',
  textColor3: '#71717a',
  hoverColor: '#27272a',
  tableHeaderColor: '#1f1f23'
}

/**
 * 深色模式额外覆盖：把 Naive UI 表面色对齐到 base.css 的 zinc 炭灰暗色调，
 * 避免与 --bg(#18181b) 不一致。主色取主题色 palette 的 dark 组（保证暗底对比度）。
 * 文字/边框/悬停色同样对齐 token，保证 Naive UI 组件与自绘组件视觉统一。
 */
const darkSurface = computed<GlobalThemeOverrides['common']>(() => {
  const t = useThemeStore().tokensFor('dark')
  return {
    ...brand.value,
    ...darkSurfaceStatic,
    primaryColor: t.primary,
    primaryColorHover: t.hover,
    primaryColorPressed: t.pressed,
    primaryColorSuppl: t.primary
  }
})

/** 生成供根组件绑定的主题（darkTheme 开关 + overrides），随主题 store 响应式更新。 */
export function useNaiveTheme(): {
  theme: ComputedRef<GlobalTheme | null>
  themeOverrides: ComputedRef<GlobalThemeOverrides>
} {
  const themeStore = useThemeStore()
  const themeOverrides = computed<GlobalThemeOverrides>(() => ({
    common: themeStore.isDark ? darkSurface.value : brand.value
  }))
  const theme = computed(() => (themeStore.isDark ? darkTheme : null))
  return { theme, themeOverrides }
}
