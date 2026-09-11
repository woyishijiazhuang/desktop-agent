// ==================== 模型配置模块门面 ====================
// 按职责拆分为 crypto（key 加解密）/ preset-catalog（预置目录）/
// register（pi-ai 注册）/ mappers（脱敏与参数映射）/ test（连通性测试）/
// pricing（分时段成本计算），本文件仅聚合导出，作为主进程模型域统一入口。

// 类型重新导出，供 types.ts / renderer 经 IPC 引用
import type { ApiFormat, ModelConfigSource, ModelPricing, ModelPeakPeriod } from '../../database'
export type { ApiFormat, ModelConfigSource, ModelPricing, ModelPeakPeriod }

export { getDecryptedApiKey, setConfigApiKey, clearConfigApiKey } from './crypto'

export type { PresetProviderInfo, PresetModelInfo, PresetModelCost } from './preset-catalog'
export { listPresetProviders, listPresetModels, fetchPresetModelsOnline } from './preset-catalog'

export type { ModelConfigSummary, CreateModelConfigInput, UpdateModelConfigInput } from './mappers'
export { toSummary, toCreateParams, toUpdateParams } from './mappers'

export {
  buildModel,
  registerModelConfig,
  registerAllModelConfigs,
  ensureAllModelConfigsRegistered,
  unregisterModelConfig
} from './register'

export { testModelConfig } from './test'

export { computeModelCost, isInPeakPeriod, resolveAssistantCost } from './pricing'
