import { IpcService } from 'electron-ipc-service'
import { nativeTheme } from 'electron'
import { db } from '../database'
import { SETTING_THEME_MODE, type ThemeMode } from '../agent/types'
import { createLogger } from '../utils/log'

const log = createLogger('theme')

/** 默认主题模式：跟随系统。 */
export const DEFAULT_THEME_MODE: ThemeMode = 'system'

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

/**
 * 按 settings 表存储的主题模式设置 nativeTheme.themeSource。
 * 在创建主窗口前调用（主进程是主题唯一真源：渲染层经 prefers-color-scheme 跟随）。
 */
export function applyStoredThemeMode(): void {
  nativeTheme.themeSource = isThemeMode(db.getSetting(SETTING_THEME_MODE))
    ? db.getSetting<ThemeMode>(SETTING_THEME_MODE)!
    : DEFAULT_THEME_MODE
}

/**
 * 主题服务：主题模式由主进程持久化（settings 表）并驱动 nativeTheme.themeSource，
 * 渲染层不再独立管理（localStorage/matchMedia 仅作跟随）。
 */
export class ThemeService extends IpcService {
  static override readonly namespace = 'theme'

  /** 读取当前主题模式（渲染层设置页展示用）。 */
  getMode(): ThemeMode {
    const v = db.getSetting(SETTING_THEME_MODE)
    return isThemeMode(v) ? v : DEFAULT_THEME_MODE
  }

  /** 切换主题模式：持久化并同步 nativeTheme（触发 updated，窗口底色/渲染层随之更新）。 */
  setMode(mode: ThemeMode): void {
    if (!isThemeMode(mode)) {
      log.warn('非法主题模式', { mode })
      return
    }
    db.setSetting(SETTING_THEME_MODE, mode)
    nativeTheme.themeSource = mode
    log.info('主题模式已切换', { mode })
  }
}
