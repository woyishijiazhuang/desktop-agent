import { IpcService } from 'electron-ipc-service'
import { nativeTheme } from 'electron'
import { db } from '../database'
import { SETTING_THEME_MODE, type ThemeMode } from '../agent/types'
import {
  DEFAULT_THEME_COLOR,
  getThemePalette,
  isThemeColorKey,
  type ThemeColorKey,
  type ThemePalette
} from './theme-palettes'
import { rendererClientForWorkspace } from './render-client'
import { createLogger } from '../utils/log'

const log = createLogger('theme')

/** 默认主题模式：跟随系统。 */
export const DEFAULT_THEME_MODE: ThemeMode = 'system'

/** 全局默认主题色设置键（settings 表；工作区未自定义主题色时跟随）。 */
export const SETTING_THEME_COLOR = 'appearance.themeColor'

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

/** 解析生效主题色 key：工作区自定义优先，否则全局默认，再回退默认紫罗兰。 */
function resolveColorKey(workdir: string | null): ThemeColorKey {
  const wsColor = workdir ? db.getWorkspace(workdir)?.themeColor : undefined
  const globalColor = db.getSetting<string>(SETTING_THEME_COLOR)
  const key = wsColor ?? globalColor
  return isThemeColorKey(key) ? key : DEFAULT_THEME_COLOR
}

/**
 * 主题服务：主题模式由主进程持久化（settings 表）并驱动 nativeTheme.themeSource，
 * 渲染层不再独立管理（localStorage/matchMedia 仅作跟随）。
 * 主题色同理：工作区自定义优先（workspaces.theme_color），否则跟随全局默认
 * （settings 的 appearance.themeColor）；变更后按窗口定向推送 palette。
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

  /**
   * 读取生效主题色 palette（含浅/深两套 token）。
   * workdir 非空 → 该工作区的自定义色（无则全局默认）；null（设置窗口）→ 全局默认。
   */
  getPalette(workdir: string | null): ThemePalette {
    return getThemePalette(resolveColorKey(workdir))
  }

  /**
   * 设置主题色：workdir 非空写入该工作区自定义色；null 写入全局默认（appearance.themeColor）。
   * color 传 null 表示工作区恢复跟随全局默认。变更后定向推送 palette 到受影响窗口：
   * - 工作区级 → 仅该工作区窗口；
   * - 全局默认 → 全部未自定义主题色的工作区窗口（已自定义的不受影响）。
   */
  setColor(workdir: string | null, color: string | null): ThemePalette {
    const key = color ?? DEFAULT_THEME_COLOR
    if (!isThemeColorKey(key)) {
      log.warn('非法主题色', { workdir, color })
      return this.getPalette(workdir)
    }
    if (workdir) {
      db.setWorkspaceThemeColor(workdir, color)
      rendererClientForWorkspace(workdir).theme.colorChanged(this.getPalette(workdir))
    } else {
      db.setSetting(SETTING_THEME_COLOR, key)
      for (const ws of db.listWorkspaces()) {
        // 仅推送跟随全局默认的工作区窗口；已自定义主题色的窗口不受影响
        if (!ws.themeColor) {
          rendererClientForWorkspace(ws.workdir).theme.colorChanged(getThemePalette(key))
        }
      }
    }
    log.info('主题色已设置', { workdir, color: key })
    return getThemePalette(key)
  }
}
