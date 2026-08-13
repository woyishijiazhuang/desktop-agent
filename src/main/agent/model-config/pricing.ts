import type { Usage } from '@earendil-works/pi-ai'
import { db } from '../../database'
import type { ModelPricing, ModelPeakPeriod } from '../../database'

/**
 * 成本计算：按消息时间戳命中高峰时段后，用「基准价 × 倍率」计算单次调用成本。
 * 价格单位 ¥/M tokens → 结果 ¥（人民币）。所有 token 项（input/output/cacheRead/cacheWrite）
 * 与 pi-ai calculateCost 的口径一致。
 */
export function computeModelCost(
  pricing: ModelPricing,
  usage: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  timestampMs: number
): number {
  const rates = effectiveRates(pricing, timestampMs)
  const input = usage.input ?? 0
  const output = usage.output ?? 0
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  return (
    (rates.input * input +
      rates.output * output +
      rates.cacheRead * cacheRead +
      rates.cacheWrite * cacheWrite) /
    1e6
  )
}

/** 判断时间戳是否落在高峰时段（支持跨午夜 start > end）。 */
export function isInPeakPeriod(period: ModelPeakPeriod, timestampMs: number): boolean {
  const { startMinutes, endMinutes } = period
  if (startMinutes === endMinutes) return false
  const d = new Date(timestampMs)
  const now = d.getHours() * 60 + d.getMinutes()
  if (startMinutes < endMinutes) return now >= startMinutes && now < endMinutes
  // 跨午夜：如 22:00-02:00
  return now >= startMinutes || now < endMinutes
}

function effectiveRates(pricing: ModelPricing, timestampMs: number): ModelPricing {
  for (const period of pricing.peakPeriods) {
    if (!isInPeakPeriod(period, timestampMs)) continue
    const multiplier = period.multiplier > 0 ? period.multiplier : 1
    return {
      ...pricing,
      input: pricing.input * multiplier,
      output: pricing.output * multiplier,
      cacheRead: pricing.cacheRead * multiplier,
      cacheWrite: pricing.cacheWrite * multiplier
    }
  }
  return pricing
}

/**
 * 落库成本解析：config 配置了自定义定价时按定价（含分时段）计算；
 * 否则回退 pi-ai 按 catalog 算出的 cost.total。
 * providerId 为 model_configs.id（消息的 provider 列即 config id）。
 */
export function resolveAssistantCost(
  providerId: string,
  usage: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  timestampMs: number,
  fallback: number
): number {
  const config = db.getModelConfig(providerId)
  if (config?.pricing) return computeModelCost(config.pricing, usage, timestampMs)
  return fallback
}
