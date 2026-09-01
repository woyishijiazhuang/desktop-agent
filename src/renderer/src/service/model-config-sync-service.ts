import { IpcService } from 'electron-ipc-service/renderer'
import { useModelConfigsStore } from '../store/useModelConfigsStore'

/**
 * 模型配置变更同步服务：main 进程在 modelConfig 增删改后经
 * rendererClient.modelConfigSync.changed 广播到全部窗口，各窗口据此重载配置列表。
 * 多窗口下配置全局共享、实时同步（如首次启动在设置窗口添加模型后，聊天窗口
 * 立即刷新 hasModel 并切出「需要添加模型」引导）。
 */
export class ModelConfigSyncService extends IpcService {
  static override readonly namespace = 'modelConfigSync'

  /** 模型配置已变更：重载本窗口的配置列表（幂等）。 */
  changed(): void {
    void useModelConfigsStore().load()
  }
}
