import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { ThemeMode } from '@main/agent/types'

/**
 * 主题状态：light / dark / system。
 *
 * 主进程为唯一真源：模式持久化于 settings 表（ThemeService）并驱动
 * nativeTheme.themeSource；渲染层只做同步跟随——prefers-color-scheme 随
 * themeSource 自动变化，这里据此维护 isDark、切换 <html>.dark
 *（base.css / markstream 翻转 token，Naive UI darkTheme 联动）。
 * 首帧即正确：主进程在创建窗口前已按设置应用 themeSource。
 */
export const useThemeStore = defineStore('theme', () => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const isDark = ref(mq.matches)
  /** 设置页展示用：模式由主进程持久化，启动时异步拉取。 */
  const mode = ref<ThemeMode>('system')

  function apply(): void {
    document.documentElement.classList.toggle('dark', isDark.value)
  }

  // 生效主题随主进程 themeSource 变化（切换模式 / system 下系统外观变化）
  mq.addEventListener('change', (e) => {
    isDark.value = e.matches
    apply()
  })

  async function init(): Promise<void> {
    mode.value = await mainClient.theme.getMode()
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
  // 拉取模式供设置页展示
  void init()

  return { mode, isDark, setMode, toggle }
})

export type { ThemeMode }
