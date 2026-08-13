// ==================== 模型配置模块门面 ====================
// 按职责拆分为 crypto（key 加解密）/ preset-catalog（预置目录）/
// register（pi-ai 注册）/ mappers（脱敏与参数映射）/ test（连通性测试），
// 本文件仅聚合导出，保持既有 import 路径（如 '../model-config'）不变。

// 类型重新导出，供 types.ts / renderer 经 IPC 引用
import type { ApiFormat, ModelConfigSource, ModelPricing, ModelPeakPeriod } from '../database'
export type { ApiFormat, ModelConfigSource, ModelPricing, ModelPeakPeriod }

export { getDecryptedApiKey, setConfigApiKey, clearConfigApiKey } from './model-config/crypto'

export type {
  PresetProviderInfo,
  PresetModelInfo,
  PresetModelCost
} from './model-config/preset-catalog'
export {
  listPresetProviders,
  listPresetModels,
  fetchPresetModelsOnline
} from './model-config/preset-catalog'

export type {
  ModelConfigSummary,
  CreateModelConfigInput,
  UpdateModelConfigInput
} from './model-config/mappers'
export { toSummary, toCreateParams, toUpdateParams } from './model-config/mappers'

export {
  buildModel,
  registerModelConfig,
  registerAllModelConfigs,
  ensureAllModelConfigsRegistered,
  unregisterModelConfig
} from './model-config/register'

export { testModelConfig } from './model-config/test'
