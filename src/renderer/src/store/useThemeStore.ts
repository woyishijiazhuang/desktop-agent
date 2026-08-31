import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { ThemeMode } from '@main/agent/types'
import type { ThemeColorTokens, ThemePalette } from '@main/service/theme-palettes'

/**
 * 默认紫罗兰 token（与 base.css :root 及 theme-palettes 的 violet 一致）：
 * palette 尚未从主进程拉取时的兜底，保证首帧 CSS 变量与 Naive UI 覆盖有值。
 */
const DEFAULT_LIGHT: ThemeColorTokens = {
  primary: '#7c3aed',
  hover: '#6d28d9',
  pressed: '#5b21b6',
  soft: '#ede9fe'
}
const DEFAULT_DARK: ThemeColorTokens = {
  primary: '#a78bfa',
  hover: '#c4b5fd',
  pressed: '#8b5cf6',
  soft: 'rgba(167, 139, 250, 0.16)'
}

/**
 * 主题状态：light / dark / system 模式 + 主题色（工作区自定义优先，否则全局默认）。
 *
 * 主进程为唯一真源：模式持久化于 settings 表（ThemeService）并驱动
 * nativeTheme.themeSource；主题色持久化于 workspaces.theme_color / settings。
 * 渲染层只做同步跟随——prefers-color-scheme 随 themeSource 自动变化，这里据此维护
 * isDark、切换 <html>.dark（base.css / markstream 翻转 token，Naive UI darkTheme 联动）；
 * 主题色经 inline style 注入 --primary* CSS 变量（优先级高于 base.css 默认色），
 * 并按模式给 Naive UI themeOverrides 提供 token。
 * 首帧即正确：主进程在创建窗口前已按设置应用 themeSource。
 */
export const useThemeStore = defineStore('theme', () => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const isDark = ref(mq.matches)
  /** 设置页展示用：模式由主进程持久化，启动时异步拉取。 */
  const mode = ref<ThemeMode>('system')
  /** 生效主题色 palette（浅/深两套 token；启动时按当前窗口工作区拉取）。 */
  const palette = ref<ThemePalette | null>(null)

  /** 当前生效 token（按 isDark 取浅/深组；palette 未拉取前用默认紫罗兰兜底）。 */
  const tokens = computed<ThemeColorTokens>(() => {
    const p = palette.value
    if (!p) return isDark.value ? DEFAULT_DARK : DEFAULT_LIGHT
    return isDark.value ? p.dark : p.light
  })

  /** 供 App.vue 的 Naive UI themeOverrides 按指定模式取 token。 */
  function tokensFor(lightOrDark: 'light' | 'dark'): ThemeColorTokens {
    const p = palette.value
    if (!p) return lightOrDark === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT
    return lightOrDark === 'dark' ? p.dark : p.light
  }

  function apply(): void {
    const root = document.documentElement
    root.classList.toggle('dark', isDark.value)
    // inline style 优先级高于 base.css 的 :root / :root.dark 定义，注入生效组即可
    const t = tokens.value
    const s = root.style
    s.setProperty('--primary', t.primary)
    s.setProperty('--primary-hover', t.hover)
    s.setProperty('--primary-pressed', t.pressed)
    s.setProperty('--primary-soft', t.soft)
  }

  // 生效主题随主进程 themeSource 变化（切换模式 / system 下系统外观变化）
  mq.addEventListener('change', (e) => {
    isDark.value = e.matches
    apply()
  })

  async function init(): Promise<void> {
    mode.value = await mainClient.theme.getMode()
    // 当前窗口所属工作区：经 window.initWindow 获取（幂等查询，windowStore 亦调用）
    const winState = await mainClient.window.initWindow()
    palette.value = await mainClient.theme.getPalette(winState.workdir)
    apply()
  }

  /** 主进程推送主题色变更（setColor 后定向投递到本窗口）时更新并重新注入。 */
  function applyPalette(next: ThemePalette): void {
    palette.value = next
    apply()
  }

  /** 设置模式：主进程持久化并驱动 nativeTheme，prefers-color-scheme 自动跟随。 */
  async function setMode(next: ThemeMode): Promise<void> {
    await mainClient.theme.setMode(next)
    mode.value = next
  }

  /** 快捷切换 light ↔ dark（忽略 system，用于标题栏按钮）。 */
  function toggle(): void {
    void setMode(isDark.value ? 'light' : 'dark')
  }

  // 构造时立即应用一次（首帧正确：主进程在创建窗口前已按设置应用 themeSource）
  apply()
  // 拉取模式与主题色供展示/注入
  void init()

  return { mode, isDark, palette, tokens, tokensFor, applyPalette, setMode, toggle }
})

export type { ThemeMode }
