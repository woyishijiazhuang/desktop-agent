import { IpcService } from 'electron-ipc-service/renderer'
import type { UpdateState } from '@main/service/update-service'
import { useUpdateStore } from '../store/useUpdateStore'

/**
 * 自动更新状态接收服务：main 进程通过 rendererClient.updateEvents.onStatus 推送状态快照。
 * 状态机本体在主进程（update-service.ts），这里只负责把快照落入 useUpdateStore。
 */
export class UpdateEventsService extends IpcService {
  static override readonly namespace = 'updateEvents'

  onStatus(state: UpdateState): void {
    useUpdateStore().applyState(state)
  }
}
