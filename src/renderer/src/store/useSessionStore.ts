import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Session, CreateSessionParams } from '@main/service/db-service'
import { mainClient } from '../utils/main-client'
import { useChatStore } from './useChatStore'
import { useSettingsStore } from './useSettingsStore'

/**
 * 会话列表与当前会话管理。
 * - 新建/切换/删除/重命名会话
 * - 切换会话时联动 useChatStore 加载该会话的消息
 *
 * 「新建对话」采用临时空对话（ephemeral）语义：currentSessionId=null 时不写库，
 * 仅当用户在临时态发送首条消息时才由 useChatStore.send 创建 DB 会话行。
 * hasInitialized 标志区分「首次启动需初始化」与「ChatView remount 保持原状」，
 * 避免导航 /settings↔/chat 往返时把用户主动进入的临时态破坏掉。
 */
export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  /** 是否已完成首次初始化（首次启动 auto-select / 进临时态后置 true）。 */
  const hasInitialized = ref(false)

  async function load(): Promise<void> {
    sessions.value = await mainClient.db.listSessions()
  }

  /** 创建新会话（写库）并加入列表头部。可携带 model 等初始字段。 */
  async function createSession(params?: CreateSessionParams): Promise<Session> {
    const session = await mainClient.db.createSession(params)
    sessions.value.unshift(session)
    return session
  }

  /**
   * 进入临时空对话：currentSessionId 置空、清空聊天状态，不写库。
   * 首条消息发送时由 useChatStore.send 落库。
   * 新建会话跟随「上次会话」的思考级别：进入前把当前/最近活跃会话容器的
   * 思考级别写为「上次使用」（enterEphemeral 据此继承），
   * 覆盖「仅手动下拉才更新 lastUsed」的盲区（历史会话/DB 加载的级别也能继承）。
   */
  async function startNewChat(): Promise<void> {
    const chat = useChatStore()
    const prevId = currentSessionId.value
    const prev = prevId ? chat.sessionState(prevId) : null
    if (prev) {
      await useSettingsStore().setLastUsedThinkingLevel(prev.thinkingLevel)
    }
    currentSessionId.value = null
    await chat.enterEphemeral()
  }

  /**
   * 切换到某会话并加载其消息。
   * 选择会话不 touch last_active_at（避免点击即把会话顶到列表首位、干扰连续点击）；
   * 排序仅由对话活动（发消息，main 侧 touchSession）驱动。
   */
  async function select(id: string): Promise<void> {
    currentSessionId.value = id
    await useChatStore().loadSession(id)
  }

  /** 重命名会话标题（用户主动操作，touch 置顶列表）。 */
  async function renameSession(id: string, title: string): Promise<void> {
    const updated = await mainClient.db.updateSession(id, { title, touch: true })
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  /** 置顶 / 取消置顶会话（不 touch，置顶由 pinned 字段驱动排序）。 */
  async function setPinned(id: string, pinned: boolean): Promise<void> {
    const updated = await mainClient.db.updateSession(id, { pinned })
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  /** 归档 / 取消归档会话（不 touch，归档会话移入「已归档」分组）。 */
  async function setArchived(id: string, archived: boolean): Promise<void> {
    const updated = await mainClient.db.updateSession(id, { archived })
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  /** 删除会话。若删除的是当前会话，自动切换到下一个；无下一个则进入临时空对话。 */
  async function deleteSession(id: string): Promise<void> {
    await mainClient.db.deleteSession(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    // 清理该会话的聊天状态容器（防内存泄漏）
    useChatStore().removeSessionState(id)
    if (currentSessionId.value === id) {
      currentSessionId.value = null
      const next = sessions.value[0]
      if (next) {
        await select(next.id)
      } else {
        await startNewChat()
      }
    }
  }

  /** 刷新单个会话的元数据（标题等更新后）。 */
  async function refreshSession(id: string): Promise<void> {
    const updated = await mainClient.db.getSession(id)
    if (!updated) return
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  /**
   * 插入或更新单个会话（main 推送 Session 更新时调用，如标题自动生成后）。
   * 已存在则替换，不存在则插入到列表头部。
   */
  async function upsertSession(session: Session): Promise<void> {
    const idx = sessions.value.findIndex((s) => s.id === session.id)
    if (idx >= 0) {
      sessions.value[idx] = session
    } else {
      sessions.value.unshift(session)
    }
  }

  return {
    sessions,
    currentSessionId,
    hasInitialized,
    load,
    createSession,
    startNewChat,
    select,
    renameSession,
    setPinned,
    setArchived,
    deleteSession,
    refreshSession,
    upsertSession
  }
})
