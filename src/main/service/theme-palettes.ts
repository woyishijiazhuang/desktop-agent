/**
 * 预设主题色板（纯数据模块，主进程与渲染层共享，无运行时依赖）。
 *
 * 每个主题色提供浅/深两套 token（primary/hover/pressed/soft），供：
 * - 渲染层注入 base.css 的 --primary* CSS 变量（header 视图与内容视图共用）；
 * - App.vue 的 Naive UI themeOverrides（primaryColor 系列）。
 * 色号按 Tailwind 档位：light 取 600/700/800/100，dark 取 400/300/500/soft=rgba(主色,0.16)，
 * 与默认紫罗兰（violet）的取值规则保持一致，保证暗色对比度。
 */

/** 主题色 key（工作区/全局外观配置的存储值）。 */
export type ThemeColorKey =
  | 'violet'
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'emerald'
  | 'amber'
  | 'orange'
  | 'rose'
  | 'pink'
  | 'indigo'

/** 默认主题色（与既有紫罗兰品牌色一致）。 */
export const DEFAULT_THEME_COLOR: ThemeColorKey = 'violet'

export const THEME_COLOR_KEYS: ThemeColorKey[] = [
  'violet',
  'blue',
  'cyan',
  'teal',
  'emerald',
  'amber',
  'orange',
  'rose',
  'pink',
  'indigo'
]

/** 单一模式（浅/深）下的主题色 token 集。 */
export interface ThemeColorTokens {
  primary: string
  hover: string
  pressed: string
  /** 弱化底（浅色用 100 号色，深色用主色 16% 透明）。 */
  soft: string
}

/** 完整主题色：key + 浅/深两套 token（渲染层按生效模式取用）。 */
export interface ThemePalette {
  key: ThemeColorKey
  light: ThemeColorTokens
  dark: ThemeColorTokens
}

export const THEME_PALETTES: Record<ThemeColorKey, ThemePalette> = {
  violet: {
    key: 'violet',
    light: { primary: '#7c3aed', hover: '#6d28d9', pressed: '#5b21b6', soft: '#ede9fe' },
    dark: {
      primary: '#a78bfa',
      hover: '#c4b5fd',
      pressed: '#8b5cf6',
      soft: 'rgba(167, 139, 250, 0.16)'
    }
  },
  blue: {
    key: 'blue',
    light: { primary: '#2563eb', hover: '#1d4ed8', pressed: '#1e40af', soft: '#dbeafe' },
    dark: { primary: '#60a5fa', hover: '#93c5fd', pressed: '#3b82f6', soft: 'rgba(96, 165, 250, 0.16)' }
  },
  cyan: {
    key: 'cyan',
    light: { primary: '#0891b2', hover: '#0e7490', pressed: '#155e75', soft: '#cffafe' },
    dark: { primary: '#22d3ee', hover: '#67e8f9', pressed: '#06b6d4', soft: 'rgba(34, 211, 238, 0.16)' }
  },
  teal: {
    key: 'teal',
    light: { primary: '#0d9488', hover: '#0f766e', pressed: '#115e59', soft: '#ccfbf1' },
    dark: { primary: '#2dd4bf', hover: '#5eead4', pressed: '#14b8a6', soft: 'rgba(45, 212, 191, 0.16)' }
  },
  emerald: {
    key: 'emerald',
    light: { primary: '#059669', hover: '#047857', pressed: '#065f46', soft: '#d1fae5' },
    dark: { primary: '#34d399', hover: '#6ee7b7', pressed: '#10b981', soft: 'rgba(52, 211, 153, 0.16)' }
  },
  amber: {
    key: 'amber',
    light: { primary: '#d97706', hover: '#b45309', pressed: '#92400e', soft: '#fef3c7' },
    dark: { primary: '#fbbf24', hover: '#fcd34d', pressed: '#f59e0b', soft: 'rgba(251, 191, 36, 0.16)' }
  },
  orange: {
    key: 'orange',
    light: { primary: '#ea580c', hover: '#c2410c', pressed: '#9a3412', soft: '#ffedd5' },
    dark: { primary: '#fb923c', hover: '#fdba74', pressed: '#f97316', soft: 'rgba(251, 146, 60, 0.16)' }
  },
  rose: {
    key: 'rose',
    light: { primary: '#e11d48', hover: '#be123c', pressed: '#9f1239', soft: '#ffe4e6' },
    dark: { primary: '#fb7185', hover: '#fda4af', pressed: '#f43f5e', soft: 'rgba(251, 113, 133, 0.16)' }
  },
  pink: {
    key: 'pink',
    light: { primary: '#db2777', hover: '#be185d', pressed: '#9d174d', soft: '#fce7f3' },
    dark: { primary: '#f472b6', hover: '#f9a8d4', pressed: '#ec4899', soft: 'rgba(244, 114, 182, 0.16)' }
  },
  indigo: {
    key: 'indigo',
    light: { primary: '#4f46e5', hover: '#4338ca', pressed: '#3730a3', soft: '#e0e7ff' },
    dark: { primary: '#818cf8', hover: '#a5b4fc', pressed: '#6366f1', soft: 'rgba(129, 140, 248, 0.16)' }
  }
}

export function isThemeColorKey(v: unknown): v is ThemeColorKey {
  return typeof v === 'string' && v in THEME_PALETTES
}

/** 取主题色 palette；非法 key 回退默认紫罗兰（配置兜底，保证始终有可用色）。 */
export function getThemePalette(key: unknown): ThemePalette {
  return THEME_PALETTES[isThemeColorKey(key) ? key : DEFAULT_THEME_COLOR]
}
