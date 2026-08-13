import { reactive } from 'vue'
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
    isNativeTitleBar: false
  })

  mainClient.window.initWindow().then((windowState) => {
    Object.assign(state, windowState)
  })

  return {
    state
  }
})
