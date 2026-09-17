import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { FileChangeItem, RevertResult, UndoResult } from '@main/infra/file-history'

/**
 * 文件变更历史状态（按会话）：write_file / edit_file 工具卡片「撤销」按钮的状态源。
 * 会话消息区挂载时经 listSessionChanges 拉一次全量（跨重启状态准确），
 * 之后 onFileChanges 推送增量合并（新记录登记 / 撤销后状态翻转）。
 */
export const useFileHistoryStore = defineStore('fileHistory', () => {
  /** sessionId → (toolCallId → 变更项)。 */
  const bySession = ref(new Map<string, Map<string, FileChangeItem>>())
  /** 已拉取过全量的会话（推送先到时也直接合并，不阻塞）。 */
  const loaded = new Set<string>()

  /** 合并变更项（推送与全量共用；同 toolCallId 后到覆盖）。 */
  function applyChanges(sessionId: string, items: FileChangeItem[]): void {
    if (!sessionId || items.length === 0) return
    let m = bySession.value.get(sessionId)
    if (!m) {
      m = new Map()
      bySession.value.set(sessionId, m)
    }
    for (const item of items) {
      if (item.toolCallId) m.set(item.toolCallId, item)
    }
  }

  /** 会话消息区挂载/切换时调用：拉一次该会话的变更全量（每会话仅一次，失败允许重试）。 */
  async function ensureSessionLoaded(sessionId: string): Promise<void> {
    if (!sessionId || loaded.has(sessionId)) return
    loaded.add(sessionId)
    try {
      applyChanges(sessionId, await mainClient.fileHistory.listSessionChanges(sessionId))
    } catch {
      loaded.delete(sessionId)
    }
  }

  /** 工具卡片查询：该 toolCall 的变更项（无记录 = 未落盘/未记录，无撤销按钮）。 */
  function getItem(
    sessionId: string | null | undefined,
    toolCallId: string
  ): FileChangeItem | undefined {
    if (!sessionId) return undefined
    return bySession.value.get(sessionId)?.get(toolCallId)
  }

  /** 撤销单条改动（工具卡片按钮）：结果经 onFileChanges 推送回填状态。 */
  function undo(logId: number, sessionId: string): Promise<UndoResult> {
    return mainClient.fileHistory.undo(logId, sessionId)
  }

  /** 撤销本会话全部文件改动（会话菜单入口）。 */
  function undoSession(sessionId: string): Promise<RevertResult> {
    return mainClient.fileHistory.undoSession(sessionId)
  }

  return { bySession, applyChanges, ensureSessionLoaded, getItem, undo, undoSession }
})
