import { defineStore } from 'pinia'
import { ref } from 'vue'
import { mainClient } from '../utils/main-client'
import type { FileChangeItem, RevertResult, UndoResult } from '@main/infra/file-history'

/**
 * 消息级「回退到此处」的目标：把 logId 及其后的改动整体退回，
 * files/changes 供确认框说明影响面（文件数 / 记录条数）。
 */
export interface RevertTarget {
  logId: number
  files: number
  changes: number
}

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

  /**
   * 该会话仍可回退（status='applied'）的变更，按 logId 升序（= 时间顺序）。
   * 供消息级「回退到此处」换算目标：取 createdAt 不早于消息时间戳的最早一条的 logId，
   * 即包含 task 子代理按宿主会话记录、未出现在工具卡片上的写入。
   */
  function listApplied(sessionId: string): FileChangeItem[] {
    const m = bySession.value.get(sessionId)
    if (!m) return []
    return [...m.values()].filter((i) => i.status === 'applied').sort((a, b) => a.logId - b.logId)
  }

  /**
   * 按消息时间戳换算「回退到此处」的目标：返回 null 表示该消息之后没有可回退的改动。
   */
  function resolveRevertTarget(
    sessionId: string | null | undefined,
    messageTimestamp: number | undefined
  ): RevertTarget | null {
    if (!sessionId || !messageTimestamp) return null
    const affected = listApplied(sessionId).filter((i) => i.createdAt >= messageTimestamp)
    if (affected.length === 0) return null
    return {
      logId: affected[0].logId,
      files: new Set(affected.map((i) => i.path)).size,
      changes: affected.length
    }
  }

  /**
   * 该条改动之后、同一文件上仍可回退（applied）的改动条数。
   * >0 表示撤销会连带把该文件整体回退到这条之前（后端 undo 的级联行为），供确认框说明影响面。
   */
  function countLaterApplied(sessionId: string, item: FileChangeItem): number {
    const m = bySession.value.get(sessionId)
    if (!m) return 0
    let n = 0
    for (const i of m.values()) {
      if (i.status === 'applied' && i.path === item.path && i.logId > item.logId) n++
    }
    return n
  }

  /** 撤销单条改动（工具卡片按钮）：结果经 onFileChanges 推送回填状态。 */
  function undo(logId: number, sessionId: string): Promise<UndoResult> {
    return mainClient.fileHistory.undo(logId, sessionId)
  }

  /** 回退到某条记录之前（消息级入口）：该条及其后的本会话文件改动一并退回。 */
  function revertTo(sessionId: string, logId: number): Promise<RevertResult> {
    return mainClient.fileHistory.revertTo(sessionId, logId)
  }

  /** 撤销本会话全部文件改动（会话菜单入口）。 */
  function undoSession(sessionId: string): Promise<RevertResult> {
    return mainClient.fileHistory.undoSession(sessionId)
  }

  return {
    bySession,
    applyChanges,
    ensureSessionLoaded,
    getItem,
    countLaterApplied,
    resolveRevertTarget,
    undo,
    revertTo,
    undoSession
  }
})
