import { IpcService } from 'electron-ipc-service'
import {
  gcFileHistoryBlobs,
  listSessionFileChanges,
  undoFileChange,
  undoSessionFileChanges
} from '../infra/file-history'
import type { FileChangeItem, RevertResult, UndoResult } from '../infra/file-history'
import { createLogger } from '../utils/log'

const log = createLogger('service:fileHistory')

/**
 * 文件撤销服务：write_file / edit_file 变更历史的查询与用户触发的撤销。
 * 撤销不暴露为模型可调用工具（避免模型自撤销浪费上下文），仅经本 IPC 由 UI 触发；
 * 快照存储与安全闸（乐观锁 / superseded / 沙箱边界）见 infra/file-history。
 * 构造时触发一次 blob GC：回收会话物理删除（FK 级联清行）遗留的孤儿快照。
 */
export class FileHistoryService extends IpcService {
  static override readonly namespace = 'fileHistory'

  constructor() {
    super()
    void gcFileHistoryBlobs().catch((err) =>
      log.warn('启动快照 GC 失败', { error: err instanceof Error ? err.message : String(err) })
    )
  }

  /** 会话全部文件变更：工具卡片按 toolCallId 建立映射（含状态与不可撤销原因）。 */
  listSessionChanges(sessionId: string): FileChangeItem[] {
    return listSessionFileChanges(sessionId)
  }

  /** 撤销单条改动（乐观锁 + superseded 校验；新建类撤销 = 校验后删除文件）。 */
  undo(logId: number, sessionId: string): Promise<UndoResult> {
    return undoFileChange(logId, sessionId)
  }

  /** 撤销本会话全部已应用改动（逐文件校验，外部修改过的文件跳过并在 failures 报告）。 */
  undoSession(sessionId: string): Promise<RevertResult> {
    return undoSessionFileChanges(sessionId)
  }
}
