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
  /** 每页会话数（无限滚动分页）。 */
  const PAGE_SIZE = 30

  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  /** 是否已完成首次初始化（首次启动 auto-select / 进临时态后置 true）。 */
  const hasInitialized = ref(false)

  // 分页状态
  const hasMore = ref(false)
  const loadingMore = ref(false)
  /** 当前已加载的非置顶会话中最旧一条的游标 (lastActiveAt, id)，用作下一页请求参数。 */
  const oldestCursor = ref<{ lastActiveAt: number; id: string } | null>(null)
  /** 搜索关键词（空 = 非搜索模式）。 */
  const searchQuery = ref('')
  /** 搜索结果（后端 SQL LIKE 查询，分页模式下前端只有部分数据，须走后端）。 */
  const searchResults = ref<Session[]>([])

  /** 首次加载：查询最近 PAGE_SIZE 条会话（含全部置顶项）。 */
  async function load(): Promise<void> {
    const result = await mainClient.db.listSessionsPaged({ limit: PAGE_SIZE })
    sessions.value = result.sessions
    hasMore.value = result.hasMore
    updateOldestCursor()
  }

  /** 滚动到底部时加载下一页（游标分页，loadingMore 防重入）。 */
  async function loadMore(): Promise<void> {
    if (loadingMore.value || !hasMore.value || !oldestCursor.value) return
    loadingMore.value = true
    try {
      const result = await mainClient.db.listSessionsPaged({
        limit: PAGE_SIZE,
        cursor: oldestCursor.value.lastActiveAt,
        cursorId: oldestCursor.value.id
      })
      sessions.value = [...sessions.value, ...result.sessions]
      hasMore.value = result.hasMore
      updateOldestCursor()
    } finally {
      loadingMore.value = false
    }
  }

  /** 标题搜索（空关键词清空搜索结果）。 */
  async function searchSessions(query: string): Promise<void> {
    searchQuery.value = query
    if (!query.trim()) {
      searchResults.value = []
      return
    }
    searchResults.value = await mainClient.db.searchSessions(query.trim())
  }

  /**
   * 更新分页游标：取当前已加载的非置顶会话中最旧一条
   *（lastActiveAt 最小，同值取 id 最小，与后端 (last_active_at, id) 倒序排序一致）。
   */
  function updateOldestCursor(): void {
    let oldest: Session | null = null
    for (const s of sessions.value) {
      if (s.pinned) continue
      if (
        !oldest ||
        s.lastActiveAt < oldest.lastActiveAt ||
        (s.lastActiveAt === oldest.lastActiveAt && s.id < oldest.id)
      ) {
        oldest = s
      }
    }
    oldestCursor.value = oldest ? { lastActiveAt: oldest.lastActiveAt, id: oldest.id } : null
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
    // touch 更新了 last_active_at，游标可能变化
    updateOldestCursor()
  }

  /** 置顶 / 取消置顶会话（不 touch，置顶由 pinned 字段驱动排序）。 */
  async function setPinned(id: string, pinned: boolean): Promise<void> {
    const updated = await mainClient.db.updateSession(id, { pinned })
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
    // 置顶项移出非置顶区间（或反向移入），游标随之变化
    updateOldestCursor()
  }

  /** 归档 / 取消归档会话（不 touch，归档会话移入「已归档」分组）。 */
  async function setArchived(id: string, archived: boolean): Promise<void> {
    const updated = await mainClient.db.updateSession(id, { archived })
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
    updateOldestCursor()
  }

  /** 删除会话。若删除的是当前会话，自动切换到下一个；无下一个则进入临时空对话。 */
  async function deleteSession(id: string): Promise<void> {
    await mainClient.db.deleteSession(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    updateOldestCursor()
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
    updateOldestCursor()
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
    updateOldestCursor()
  }

  return {
    sessions,
    currentSessionId,
    hasInitialized,
    hasMore,
    loadingMore,
    searchQuery,
    searchResults,
    load,
    loadMore,
    createSession,
    startNewChat,
    select,
    renameSession,
    setPinned,
    setArchived,
    deleteSession,
    refreshSession,
    upsertSession,
    searchSessions
  }
})
