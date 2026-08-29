import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { AskUserRequest } from '@main/agent/types'

/**
 * 澄清问题队列：Agent 调用 ask_user 后，main 经 AgentEventService.onAskUserRequest
 * 推送到此处；AskUserBar 展示问题与选项，用户作答后回传
 * mainClient.agent.respondAskUser 解除 agent 挂起。
 * 按会话最多一个待回答问题（一次只问一件事），agent_end 时清理。
 */
export const useAskUserStore = defineStore('askUser', () => {
  const pendingBySession = ref<Record<string, AskUserRequest>>({})

  function enqueue(req: AskUserRequest): void {
    pendingBySession.value[req.sessionId] = req
  }

  /** 某会话当前待回答的问题（无则 null）。 */
  function forSession(sessionId: string | null): AskUserRequest | null {
    if (!sessionId) return null
    return pendingBySession.value[sessionId] ?? null
  }

  /**
   * 回传答案并移除待回答问题。
   * value：单选/自由输入为字符串，多选为字符串数组；用户跳过时为 null。
   */
  function respond(sessionId: string, value: string | string[] | null): void {
    const req = pendingBySession.value[sessionId]
    if (!req) return
    delete pendingBySession.value[sessionId]
    void mainClient.agent.respondAskUser(req.requestId, value)
  }

  /** 会话结束（agent_end）时清理残留的待回答问题。 */
  function clearSession(sessionId: string): void {
    delete pendingBySession.value[sessionId]
  }

  return { pendingBySession, enqueue, forSession, respond, clearSession }
})
