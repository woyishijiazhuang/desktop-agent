/**
 * 将 token 数格式化为人类可读的上下文窗口大小，与厂商标注一致。
 *
 * pi-ai 内置 catalog 的 contextWindow 混用两种约定：
 * - 2 的幂次（131072=128·1024、1048576=1024²）→ 厂商按 1024 换算标注为 128K / 1M
 * - 整千值（128000、200000、1000000）→ 厂商按 1000 换算标注为 128K / 200K / 1M
 * 直接 value/1000 会让 131072 显示成 131K、1048576 显示成 1049K，与常见标注不符。
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    // 1.05M 以下统一显示 1M（与厂商 marketing 一致，如 gpt-4.1 的 1047576 / gemini 的 1048576）
    return m < 1.1 ? '1M' : `${Math.round(m * 10) / 10}M`
  }
  // 2 的幂次按 1024 换算（131072→128K、65536→64K、262144→256K、8192→8K）
  if (tokens > 0 && Number.isInteger(Math.log2(tokens))) {
    return `${tokens / 1024}K`
  }
  // 其余按 1000 换算取整（128000→128K、200000→200K、400000→400K）
  return `${Math.round(tokens / 1000)}K`
}

/**
 * 用量统计的精确 token 数：千分位分隔（1234567 → "1,234,567"）。
 * 与 formatContextWindow（厂商营销口径、粗粒度）不同，统计面板需要精确值。
 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

/** 用量统计的紧凑 token 数（图表坐标轴用）：1.2K / 3.4M。 */
export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimZero((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1_000) return `${trimZero((tokens / 1_000).toFixed(1))}K`
  return String(Math.round(tokens))
}

/** 成本：按量级自适应小数位并去掉尾随 0（0.000123 → "¥0.000123"）。 */
export function formatCost(cost: number): string {
  if (cost === 0) return '¥0'
  const abs = Math.abs(cost)
  let fixed: string
  if (abs >= 100) fixed = cost.toFixed(2)
  else if (abs >= 0.01) fixed = cost.toFixed(4)
  else fixed = cost.toFixed(6)
  return `¥${trimZero(fixed)}`
}

/** 去掉数字字符串的尾随 0（及多余小数点）。 */
function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}
