import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { WindowState } from '../../../main/service/window-service'
import { mainClient } from '../utils/main-client'

export const useWindowStore = defineStore('window', () => {
  const state = reactive<WindowState>({
    isMaximized: false,
    isMinimized: false,
    isFullScreen: false,
    isAlwaysOnTop: false,
    isFocused: false,
    isNativeTitleBar: false,
    windowType: 'workspace',
    workdir: null,
    workspaceName: null
  })
  /** 窗口身份是否已从主进程拉取完成（路由守卫据此区分「初始加载」与「确认的工作区窗口」）。 */
  const initialized = ref(false)

  mainClient.window.initWindow().then((windowState) => {
    Object.assign(state, windowState)
    initialized.value = true
  })

  return {
    state,
    initialized
  }
})
