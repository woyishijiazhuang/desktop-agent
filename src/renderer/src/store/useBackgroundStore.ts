import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { BackgroundSessionInfo } from '@main/agent/tools/bash-session'

/**
 * 后台命令面板状态（全局、与当前会话无关）。
 * main 在后台会话 启动/退出/终止 时推送全量快照（agentEvent.onBackgroundSessions）；
 * 面板挂载时再主动 listBackground 拉一次兜底（避免推送早于订阅丢失）。
 */
export const useBackgroundStore = defineStore('background', () => {
  const sessions = ref<BackgroundSessionInfo[]>([])
  const loaded = ref(false)

  function setSessions(list: BackgroundSessionInfo[]): void {
    sessions.value = list
    loaded.value = true
  }

  /** 主动拉取全量快照（面板挂载时调用）。 */
  async function refresh(): Promise<void> {
    sessions.value = await mainClient.bash.listBackground()
    loaded.value = true
  }

  /** 终止后台会话（进程组 SIGTERM→SIGKILL）；退出回调会推送新快照翻转状态。 */
  async function kill(id: string): Promise<void> {
    await mainClient.bash.killBackground(id)
  }

  /** 移除已退出的后台任务（面板「×」按钮）；移除成功会推送新快照。 */
  async function remove(id: string): Promise<void> {
    await mainClient.bash.removeBackground(id)
  }

  /** 读取会话输出（面板「查看输出」用；tail=false 全量，不改动 agent 增量游标）。 */
  function readOutput(
    id: string
  ): Promise<{ text: string; exited: boolean; exitCode: number | null }> {
    return mainClient.bash.readBackgroundOutput(id)
  }

  return { sessions, loaded, setSessions, refresh, kill, remove, readOutput }
})
