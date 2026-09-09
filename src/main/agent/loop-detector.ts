import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { createLogger } from '../utils/log'

const log = createLogger('loop-detector')

// ─── 配置常量 ────────────────────────────────────────────
/** 流式检测：每多少个新字符触发一次重复检查 */
const STRIDE = 50

/** 字符级检测：思考块末尾连续相同字符数阈值 */
const THINKING_CHAR_WINDOW = 80
/** 字符级检测：可见输出末尾连续相同字符数阈值 */
const OUTPUT_CHAR_WINDOW = 100
/** 字符级检测：最大回溯窗口（避免过长文本的 O(n²)） */
const MAX_WINDOW = 4000

/** 语义级检测：段落指纹长度 */
const FINGERPRINT_LEN = 60
/** 语义级检测：同一指纹出现多少次判定为循环 */
const SEMANTIC_THRESHOLD = 3

/** 跨轮次检测：工具调用序列循环检测的回溯窗口 */
const TOOL_CALL_WINDOW = 6

/** 跨轮次检测：连续相同工具调用次数阈值 */
const SAME_TOOL_REPEAT_THRESHOLD = 3

/** 跨轮次检测：连续 stopReason=length 的阈值 */
const LENGTH_STOP_THRESHOLD = 3

// ─── 类型 ────────────────────────────────────────────────

export type LoopDetectedKind =
  | 'thinking_char_loop'
  | 'thinking_semantic_loop'
  | 'output_char_loop'
  | 'output_semantic_loop'
  | 'tool_call_loop'
  | 'same_tool_repeat'
  | 'length_stop_loop'

export interface LoopDetectorResult {
  detected: boolean
  kind?: LoopDetectedKind
  message?: string
}

// ─── 工具 ────────────────────────────────────────────────

/** 归一化段落指纹（去掉行首序号差异，如 "23." → "N."） */
function fingerprintParagraph(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  // 统一行首数字编号为 N.
  const normalized = trimmed.replace(/^\d+\.\s*/m, 'N. ')
  return normalized.slice(0, FINGERPRINT_LEN)
}

/** 检测文本末尾是否存在长度为 >= windowSize 的连续重复片段 */
function detectEndRepeat(text: string, windowSize: number): { found: boolean; cleanPrefix?: string } {
  if (text.length < windowSize * 2) return { found: false }
  const tail = text.slice(-windowSize)
  const prev = text.slice(-windowSize * 2, -windowSize)
  if (tail === prev) {
    // 向前找干净的前缀（去掉重复部分）
    let cleanEnd = text.length - windowSize
    while (cleanEnd >= windowSize) {
      const a = text.slice(cleanEnd - windowSize, cleanEnd)
      const b = text.slice(cleanEnd, cleanEnd + windowSize)
      if (a !== b) break
      cleanEnd -= windowSize
    }
    return { found: true, cleanPrefix: text.slice(0, cleanEnd) }
  }
  return { found: false }
}

/** 检测文本中同一段落是否出现 >= threshold 次（代码块内排除） */
function detectSemanticRepeat(text: string, threshold: number): { found: boolean; paragraph?: string } {
  // 移除代码块
  const stripped = text.replace(/```[\s\S]*?```/g, '')
  const paragraphs = stripped.split(/\n\s*\n/).filter(p => p.trim().length > FINGERPRINT_LEN)
  const seen = new Map<string, number>()
  for (const p of paragraphs) {
    const fp = fingerprintParagraph(p)
    if (!fp) continue
    const count = (seen.get(fp) ?? 0) + 1
    seen.set(fp, count)
    if (count >= threshold) {
      return { found: true, paragraph: fp }
    }
  }
  return { found: false }
}

/** 从 turn_end 的消息中提取工具调用名称序列 */
function extractToolNames(message: AssistantMessage): string[] {
  return message.content
    .filter((c): c is ToolCall => c.type === 'toolCall')
    .map(tc => tc.name)
}

// ─── LoopDetector 类 ─────────────────────────────────────

/**
 * Agent 循环检测器。
 *
 * 三层防护：
 * - Layer 1: 流式输出检测（单次生成内部的重复）
 * - Layer 2: 工具调用序列检测（跨轮次的重复）
 * - Layer 3: stopReason=length 连续检测（兜底）
 *
 * 生命周期：每次 run 创建一个实例，run 结束后丢弃。
 * 在 agent-manager.ts 的 bridgeEvents 中调用 feedEvent() 驱动检测。
 */
export class LoopDetector {
  // ── 流式检测状态 ──
  private thinkingBuffer = ''
  private outputBuffer = ''
  private lastCheckedLen = 0
  private lastCheckedOutputLen = 0

  // ── 跨轮次检测状态 ──
  private toolCallHistory: string[][] = []
  private recentToolNames: string[] = []
  private lengthStopCount = 0

  // ── 通用状态 ──
  private abortFn?: () => void
  private aborted = false

  /** 注入 abort 函数（创建 agent 后立即设置） */
  setAbortFn(fn: () => void): void {
    this.abortFn = fn
  }

  /** 本次 run 是否已触发过循环检测 */
  get wasTriggered(): boolean {
    return this.aborted
  }

  /**
   * 主入口：喂入 agent 事件，返回检测结果。
   * 调用方应在 bridgeEvents 中对每个事件调用此方法。
   */
  feedEvent(event: AgentEvent): LoopDetectorResult {
    switch (event.type) {
      case 'message_update':
        return this.handleMessageUpdate(event)
      case 'message_end':
        return this.handleMessageEnd(event.message)
      case 'turn_end':
        return this.handleTurnEnd(event.message)
      case 'agent_start':
        this.reset()
        return { detected: false }
      default:
        return { detected: false }
    }
  }

  /** 每次 run 结束时调用，清理所有状态 */
  reset(): void {
    this.thinkingBuffer = ''
    this.outputBuffer = ''
    this.lastCheckedLen = 0
    this.lastCheckedOutputLen = 0
    this.toolCallHistory = []
    this.recentToolNames = []
    this.lengthStopCount = 0
    this.aborted = false
  }

  // ── Layer 1: 流式检测 ──────────────────────────────────

  private handleMessageUpdate(event: Extract<AgentEvent, { type: 'message_update' }>): LoopDetectorResult {
    if (this.aborted) return { detected: false }
    const { assistantMessageEvent } = event
    if (assistantMessageEvent.type === 'done' || assistantMessageEvent.type === 'error') return { detected: false }

    // 从 partial message 中提取 thinking 和 text 的累积内容
    const partial = assistantMessageEvent.partial
    if (!partial) return { detected: false }

    const thinkingContent = partial.content.find(c => c.type === 'thinking')
    const textContent = partial.content.find(c => c.type === 'text')

    // ── Thinking block 检测 ──
    if (thinkingContent && thinkingContent.type === 'thinking') {
      const text = thinkingContent.thinking
      if (text.length - this.lastCheckedLen >= STRIDE) {
        this.thinkingBuffer = text.slice(-MAX_WINDOW)
        this.lastCheckedLen = text.length

        // 字符级检测
        const charCheck = detectEndRepeat(this.thinkingBuffer, THINKING_CHAR_WINDOW)
        if (charCheck.found) {
          log.warn('Thinking block 字符级循环检测触发')
          return this.trigger({
            detected: true,
            kind: 'thinking_char_loop',
            message: `Thinking 中检测到连续重复（≥${THINKING_CHAR_WINDOW}字符），已中止生成。`
          })
        }

        // 语义级检测
        const semCheck = detectSemanticRepeat(this.thinkingBuffer, SEMANTIC_THRESHOLD)
        if (semCheck.found) {
          log.warn('Thinking block 语义级循环检测触发', { paragraph: semCheck.paragraph?.slice(0, 40) })
          return this.trigger({
            detected: true,
            kind: 'thinking_semantic_loop',
            message: `Thinking 中检测到段落重复（${SEMANTIC_THRESHOLD}次），已中止生成。`
          })
        }
      }
    }

    // ── Output text 检测 ──
    if (textContent && textContent.type === 'text') {
      const text = textContent.text
      if (text.length - this.lastCheckedOutputLen >= STRIDE) {
        this.outputBuffer = text.slice(-MAX_WINDOW)
        this.lastCheckedOutputLen = text.length

        // 字符级检测
        const charCheck = detectEndRepeat(this.outputBuffer, OUTPUT_CHAR_WINDOW)
        if (charCheck.found) {
          log.warn('Output 字符级循环检测触发')
          return this.trigger({
            detected: true,
            kind: 'output_char_loop',
            message: `输出中检测到连续重复（≥${OUTPUT_CHAR_WINDOW}字符），已中止生成。`
          })
        }

        // 语义级检测
        const semCheck = detectSemanticRepeat(this.outputBuffer, SEMANTIC_THRESHOLD)
        if (semCheck.found) {
          log.warn('Output 语义级循环检测触发', { paragraph: semCheck.paragraph?.slice(0, 40) })
          return this.trigger({
            detected: true,
            kind: 'output_semantic_loop',
            message: `输出中检测到段落重复（${SEMANTIC_THRESHOLD}次），已中止生成。`
          })
        }
      }
    }

    return { detected: false }
  }

  // ── Layer 2: message_end 时的 stopReason 检测 ──────────

  private handleMessageEnd(message: AssistantMessage): LoopDetectorResult {
    if (this.aborted || !message) return { detected: false }

    // stopReason=length 检测：连续多次触发说明模型在循环中撞上限
    if (message.stopReason === 'length') {
      this.lengthStopCount++
      if (this.lengthStopCount >= LENGTH_STOP_THRESHOLD) {
        log.warn('连续多次 stopReason=length，检测到输出循环', { count: this.lengthStopCount })
        return this.trigger({
          detected: true,
          kind: 'length_stop_loop',
          message: `连续 ${this.lengthStopCount} 次输出被截断（撞上 max_tokens），疑似输出循环，已中止。`
        })
      }
    } else {
      this.lengthStopCount = 0
    }

    return { detected: false }
  }

  // ── Layer 2: turn_end 时的工具调用序列检测 ────────────

  private handleTurnEnd(message: AssistantMessage): LoopDetectorResult {
    if (this.aborted || !message) return { detected: false }

    const toolNames = extractToolNames(message)

    if (toolNames.length > 0) {
      // 记录本轮工具调用
      this.toolCallHistory.push(toolNames)

      // ── 同一工具频率异常检测（滑动窗口）──
      this.recentToolNames.push(...toolNames)
      if (this.recentToolNames.length > SAME_TOOL_REPEAT_THRESHOLD * 2) {
        this.recentToolNames = this.recentToolNames.slice(-SAME_TOOL_REPEAT_THRESHOLD * 2)
      }
      if (this.recentToolNames.length >= SAME_TOOL_REPEAT_THRESHOLD) {
        const freq = new Map<string, number>()
        for (const t of this.recentToolNames) {
          freq.set(t, (freq.get(t) ?? 0) + 1)
        }
        for (const [tool, count] of freq) {
          // 严格连续：全为同一工具
          if (count >= SAME_TOOL_REPEAT_THRESHOLD) {
            const tail = this.recentToolNames.slice(-SAME_TOOL_REPEAT_THRESHOLD)
            if (tail.every(t => t === tool)) {
              log.warn('工具连续重复调用检测', { tool, count: tail.length })
              return this.trigger({
                detected: true,
                kind: 'same_tool_repeat',
                message: `工具 "${tool}" 已连续调用 ${tail.length} 次，疑似死循环，已中止。`
              })
            }
            // 频率异常：同一工具占比超过 75%（容忍少量其他工具穿插）
            if (count >= Math.ceil(this.recentToolNames.length * 0.75)) {
              log.warn('工具频率异常检测', { tool, count, windowSize: this.recentToolNames.length })
              return this.trigger({
                detected: true,
                kind: 'same_tool_repeat',
                message: `工具 "${tool}" 在最近 ${this.recentToolNames.length} 次调用中出现 ${count} 次，疑似死循环，已中止。`
              })
            }
          }
        }
      }

      // ── 工具调用序列背靠背重复检测 ──
      if (this.toolCallHistory.length >= 2) {
        const recent = this.toolCallHistory.slice(-TOOL_CALL_WINDOW)
        // 检查是否存在背靠背的相同序列
        for (let len = 1; len <= Math.floor(recent.length / 2); len++) {
          const last = recent.slice(-len)
          const prev = recent.slice(-len * 2, -len)
          if (last.length === prev.length && last.length > 0 &&
            JSON.stringify(last) === JSON.stringify(prev)) {
            log.warn('工具调用序列循环检测', { sequenceLength: len, toolNames: last[0] })
            return this.trigger({
              detected: true,
              kind: 'tool_call_loop',
              message: `工具调用序列 [${last.map(s => s.join('→')).join(', ')}] 重复出现，疑似循环，已中止。`
            })
          }
        }
      }

      // 限制历史长度
      if (this.toolCallHistory.length > TOOL_CALL_WINDOW * 2) {
        this.toolCallHistory = this.toolCallHistory.slice(-TOOL_CALL_WINDOW * 2)
      }
    }

    return { detected: false }
  }

  // ── 触发中止 ───────────────────────────────────────────

  private trigger(result: LoopDetectorResult): LoopDetectorResult {
    this.aborted = true
    if (this.abortFn) {
      try {
        this.abortFn()
      } catch (err) {
        log.error('循环检测 abort 失败', { error: err })
      }
    }
    return result
  }
}
