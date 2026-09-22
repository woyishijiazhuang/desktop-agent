import type { BeforeToolCallResult } from '@earendil-works/pi-agent-core'

/**
 * 工具调用的「结局」分类（区别于真实的执行失败）。
 *
 * 背景：pi-agent-core 中 beforeToolCall 的 block 与 execute 抛错在模型侧是**同一种形状** ——
 * 一个 isError:true 的纯文本 toolResult（见 dist/agent-loop.js 的 createErrorToolResult）。
 * 模型会把 isError 解读为「这次没成功，改一下再试」，于是对「用户已明确拒绝」的动作
 * 反复重试。因此这里把这些**策略性结局**用稳定前缀写进文本，让模型能区分
 * 「别再试了」与「可以修一下再试」。
 *
 * 关键约束：toolResult 的 details 不会随报文进入 provider，模型只能看到 content 文本 ——
 * 分类信息**必须由文本承载**，这也是本模块存在的理由。
 *
 * 注意：`tool_error`（execute 真抛错）故意不在此枚举中 —— 它是「没有结局」的默认情况，
 * 由 pi-agent-core 原样透传，模型可正常自纠重试。
 */
export const TOOL_OUTCOME_KINDS = [
  'user_denied',
  'approval_timeout',
  'aborted',
  'plan_mode',
  'sandbox_denied',
  'tool_disabled',
  'subagent_readonly'
] as const

export type ToolOutcomeKind = (typeof TOOL_OUTCOME_KINDS)[number]

export interface ToolOutcome {
  kind: ToolOutcomeKind
  /** 具体事实 + 可操作指令（不含分类前缀）。 */
  detail: string
  /** 是否请求提前结束本轮：仅「用户中断」置 true（用户已要求停止，不该再让模型说话）。 */
  terminate?: boolean
}

/** 分类前缀（稳定可枚举，禁止在别处手写散落）。 */
const OUTCOME_LABELS: Record<ToolOutcomeKind, string> = {
  user_denied: '权限：用户手动拒绝 · 请勿重试',
  approval_timeout: '权限：确认超时 · 已按拒绝处理 · 请勿重试',
  aborted: '已中断 · 请立即停止',
  plan_mode: '计划模式拦截',
  sandbox_denied: '沙箱：越界被拒',
  tool_disabled: '工具已停用',
  subagent_readonly: '只读子代理限制'
}

/** 结局 → 面向模型的文本（分类标记 + 事实 + 指令 三段式）。 */
export function toolOutcomeText(outcome: ToolOutcome): string {
  return `[${OUTCOME_LABELS[outcome.kind]}] ${outcome.detail}`
}

/** 结局 → beforeToolCall 的 block 结果（aborted 会置 terminate 以提前结束本轮）。 */
export function blockFromOutcome(outcome: ToolOutcome): BeforeToolCallResult {
  const result: BeforeToolCallResult = { block: true, reason: toolOutcomeText(outcome) }
  // 语义提醒：pi-agent-core 仅在同一批**全部** terminate 时才提前结束（见其 README）。
  if (outcome.terminate) result.terminate = true
  return result
}

/** 常用结局的构造器（统一措辞，避免各处散落导致口径漂移）。 */
export const toolOutcomes = {
  /** 用户点「拒绝」。 */
  userDenied: (what: string): ToolOutcome => ({
    kind: 'user_denied',
    detail:
      `用户手动拒绝了${what}。请勿重试该操作或其等价写法（换参数、换路径、拆成多条都视为重试）；` +
      `如需继续，请说明理由征求用户重新批准，或改用不需要该权限的方案。`
  }),
  /** 确认条超时未响应。 */
  approvalTimeout: (what: string): ToolOutcome => ({
    kind: 'approval_timeout',
    detail: `用户未在时限内确认${what}，已按拒绝处理。请勿直接重试。`
  }),
  /** 用户中断本轮（唯一置 terminate 的结局）。 */
  aborted: (what: string): ToolOutcome => ({
    kind: 'aborted',
    detail: `用户中断了本轮任务（${what} 未执行），请立即停止后续动作并等待用户指示。`,
    terminate: true
  }),
  /** 计划模式拦截。 */
  planMode: (): ToolOutcome => ({
    kind: 'plan_mode',
    detail: '当前处于计划模式：请先调用 exit_plan_mode 提交计划并获得用户批准后再执行操作。'
  }),
  /**
   * 沙箱越界被拒（提权未开启 / 被拒绝 / 关闭总开关时使用）。
   * hint 由调用方给出「接下来能做什么」，保证与提权开关状态口径一致。
   */
  sandboxDenied: (paths: string[], hint: string): ToolOutcome => ({
    kind: 'sandbox_denied',
    detail:
      `写入路径「${paths.join('、')}」不在沙箱可写范围内。**这不是命令执行失败**，` +
      `不要通过改写命令、换路径或拆成多条来绕过。${hint}`
  }),
  /** 工具被用户关闭 / 域总开关关闭（wrapGate 使用，需以 error 结果返回）。 */
  toolDisabled: (toolName: string): ToolOutcome => ({
    kind: 'tool_disabled',
    detail: `工具「${toolName}」当前已被用户停用，本次未执行任何内部逻辑。请改用其他方式完成，或告知用户去开启该工具。`
  }),
  /** 只读子代理的能力边界。 */
  subagentReadonly: (): ToolOutcome => ({
    kind: 'subagent_readonly',
    detail: '只读子代理仅允许执行只读命令（如 ls / cat / git status / git diff / git log）。'
  })
}
