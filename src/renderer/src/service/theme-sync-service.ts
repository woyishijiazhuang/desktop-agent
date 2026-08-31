import { IpcService } from 'electron-ipc-service/renderer'
import { useThemeStore } from '../store/useThemeStore'
import type { ThemePalette } from '@main/service/theme-palettes'

/**
 * 主题色变更推送（namespace `theme`）：主进程在 setColor 后按窗口定向投递，
 * 内容视图据此更新 palette 并重新注入 CSS 变量 / Naive UI 覆盖。
 * header 视图注册同名同方法服务，实现标题栏主题色跟随。
 */
export class ThemeSyncService extends IpcService {
  static override readonly namespace = 'theme'

  colorChanged(palette: ThemePalette): void {
    useThemeStore().applyPalette(palette)
  }
}
