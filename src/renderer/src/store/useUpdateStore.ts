import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { UpdatePhase, UpdateState } from '@main/service/update-service'
import { mainClient } from '../utils/main-client'

/**
 * 自动更新状态（设置页「关于」面板消费，全局单例）。
 * main 进程在状态机跳变时经 updateEvents.onStatus 推送快照；
 * 面板挂载时再调 refresh 拉一次兜底（避免推送早于订阅丢失）。
 */
export const useUpdateStore = defineStore('update', () => {
  const supported = ref(false)
  const phase = ref<UpdatePhase>('idle')
  const currentVersion = ref('')
  const availableVersion = ref<string | undefined>(undefined)
  const releaseDate = ref<string | undefined>(undefined)
  const releaseNotes = ref<string | undefined>(undefined)
  const percent = ref<number | undefined>(undefined)
  const bytesPerSecond = ref<number | undefined>(undefined)
  const error = ref<string | undefined>(undefined)
  const lastCheckedAt = ref<number | undefined>(undefined)
  const autoCheckEnabled = ref(true)

  const isBusy = computed(() => phase.value === 'checking' || phase.value === 'downloading')
  const hasAvailable = computed(() => phase.value === 'available' || phase.value === 'downloaded')

  function applyState(s: UpdateState): void {
    supported.value = s.supported
    phase.value = s.phase
    currentVersion.value = s.currentVersion
    availableVersion.value = s.availableVersion
    releaseDate.value = s.releaseDate
    releaseNotes.value = s.releaseNotes
    percent.value = s.percent
    bytesPerSecond.value = s.bytesPerSecond
    error.value = s.error
    lastCheckedAt.value = s.lastCheckedAt
    autoCheckEnabled.value = s.autoCheckEnabled
  }

  /** 拉取最新快照（面板挂载时调用）。 */
  async function refresh(): Promise<void> {
    applyState(await mainClient.update.getState())
  }

  /** 手动检查更新。 */
  async function checkNow(): Promise<void> {
    applyState(await mainClient.update.checkForUpdates(false))
  }

  /** 下载已发现的新版本。 */
  async function download(): Promise<void> {
    applyState(await mainClient.update.downloadUpdate())
  }

  /** 退出应用并安装更新。 */
  function install(): void {
    void mainClient.update.install()
  }

  /** 切换「启动自动检查」。 */
  async function setAutoCheckEnabled(enabled: boolean): Promise<void> {
    await mainClient.update.setAutoCheckEnabled(enabled)
    autoCheckEnabled.value = enabled
  }

  return {
    supported,
    phase,
    currentVersion,
    availableVersion,
    releaseDate,
    releaseNotes,
    percent,
    bytesPerSecond,
    error,
    lastCheckedAt,
    autoCheckEnabled,
    isBusy,
    hasAvailable,
    applyState,
    refresh,
    checkNow,
    download,
    install,
    setAutoCheckEnabled
  }
})
