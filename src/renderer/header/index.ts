import '@renderer/assets/base.css'
import './index.css'
import { initializeIpcRendererServices } from 'electron-ipc-service/renderer'
import {
  HeaderThemeService as HeaderThemeServiceBase,
  HeaderUiService as HeaderUiServiceBase
} from '@renderer/service/header-view-services'
import type { WindowState } from '@main/service/window-service'
import type { ThemePalette } from '@main/service/theme-palettes'
import { mainClient } from '@renderer/utils/main-client'

/**
 * 标题栏视图（独立 webContents，位于窗口顶部 32px）。
 * - 纯 HTML/CSS/JS，不引入 Vue/Pinia/Naive UI，保持轻量；
 * - 主题：主进程 nativeTheme 为唯一真源，本视图经 prefers-color-scheme 同步跟随，
 *   据此维护 <html>.dark 翻转 base.css token；主题色经 theme.getPalette 拉取、
 *   theme.colorChanged 推送后注入 --primary* CSS 变量；
 * - 窗口状态：主进程广播 windowStateChange 到全部视图，本视图只消费 ui 服务。
 */

/** 生效主题随主进程 themeSource 变化，给 <html> 落 .dark。 */
const themeMq = window.matchMedia('(prefers-color-scheme: dark)')
/** 本窗口生效主题色 palette（浅/深两套 token，按 themeMq 取生效组）。 */
let colorPalette: ThemePalette | null = null

function applyTheme(): void {
  document.documentElement.classList.toggle('dark', themeMq.matches)
  applyColorTokens()
}

/** 注入 --primary* CSS 变量（inline style 优先级高于 base.css 默认紫罗兰）。 */
function applyColorTokens(): void {
  const p = colorPalette
  if (!p) return
  const t = themeMq.matches ? p.dark : p.light
  const s = document.documentElement.style
  s.setProperty('--primary', t.primary)
  s.setProperty('--primary-hover', t.hover)
  s.setProperty('--primary-pressed', t.pressed)
  s.setProperty('--primary-soft', t.soft)
}
applyTheme()
// 主进程切换主题模式 / system 下系统外观变化时同步本视图
themeMq.addEventListener('change', applyTheme)

let windowState: WindowState | null = null

function render(state: WindowState): void {
  windowState = state
  document.documentElement.classList.toggle('win-max', state.isMaximized)
  document.documentElement.classList.toggle('win-focused', state.isFocused)
  document.documentElement.classList.toggle('win-on-top', state.isAlwaysOnTop)
  // 原生标题栏模式（macOS 红绿灯 / Windows overlay 系统按钮）：隐藏自绘窗口控制按钮
  document.documentElement.classList.toggle('win-native', state.isNativeTitleBar)
  const maximizeBtn = document.getElementById('btn-maximize') as HTMLButtonElement
  maximizeBtn.title = state.isMaximized ? '还原' : '最大化'
  const pinBtn = document.getElementById('btn-pin') as HTMLButtonElement
  pinBtn.title = state.isAlwaysOnTop ? '取消置顶' : '置顶窗口'
}

/**
 * 接收 main 推送：以子类 override 注入 header-view-services.ts 骨架声明的真实实现。
 * main 侧按骨架类推导投递目标，本视图未注册的推送（showToast / trayAction /
 * agentEvent.* 等）只会发往内容视图，不会到达标题栏，无需空实现兜底。
 * 新增接收方法需同时改骨架类（方法签名）与本文件（override 实现）。
 */
class HeaderUiService extends HeaderUiServiceBase {
  override windowStateChange(state: WindowState): void {
    render(state)
  }
}

class HeaderThemeService extends HeaderThemeServiceBase {
  override colorChanged(palette: ThemePalette): void {
    colorPalette = palette
    applyColorTokens()
  }
}

initializeIpcRendererServices([HeaderUiService, HeaderThemeService])

// 初始状态（广播可能早于注册到达，故主动拉取一次）
void mainClient.window.initWindow().then((state) => {
  render(state)
  // 拉取本窗口生效主题色（工作区自定义优先，否则全局默认）并注入 --primary* token
  return mainClient.theme.getPalette(state.workdir)
}).then((palette) => {
  colorPalette = palette
  applyColorTokens()
})

const pinBtn = document.getElementById('btn-pin') as HTMLButtonElement
const minimizeBtn = document.getElementById('btn-minimize') as HTMLButtonElement
const maximizeBtn = document.getElementById('btn-maximize') as HTMLButtonElement
const closeBtn = document.getElementById('btn-close') as HTMLButtonElement

pinBtn.addEventListener('click', () => {
  void mainClient.window
    .triggerWindowAction(windowState?.isAlwaysOnTop ? 'cancel-always-on-top' : 'always-on-top')
    .then(render)
})
minimizeBtn.addEventListener('click', () => {
  void mainClient.window.triggerWindowAction('minimize').then(render)
})
maximizeBtn.addEventListener('click', () => {
  void mainClient.window
    .triggerWindowAction(windowState?.isMaximized ? 'unmaximize' : 'maximize')
    .then(render)
})
closeBtn.addEventListener('click', () => {
  void mainClient.window.triggerWindowAction('close')
})
