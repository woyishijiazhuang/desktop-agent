import { IpcService } from 'electron-ipc-service/renderer'
import { useSettingsStore } from '../store/useSettingsStore'

/** 设置变更同步载荷（key 为 settings 表键）。 */
export interface SettingChangedPayload {
  key: string
  value: unknown
}

/**
 * 设置变更同步服务：main 进程在 db.setSetting 后经
 * rendererClient.settingsSync.settingChanged 广播到全部窗口，
 * 各窗口据此刷新内存设置（多窗口下设置全局共享、实时同步）。
 */
export class SettingsSyncService extends IpcService {
  static override readonly namespace = 'settingsSync'

  /** 设置项变更（广播到所有窗口，含发起方自身；幂等刷新）。 */
  settingChanged(payload: SettingChangedPayload): void {
    useSettingsStore().handleSettingChanged(payload.key, payload.value)
  }
}
