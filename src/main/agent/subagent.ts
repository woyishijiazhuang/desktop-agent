import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
  ThinkingLevel
} from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import { db } from '../database'
import { resolveAssistantCost } from './model-config'
import { evaluateReadonlyBash, createBeforeToolCallHook } from './permission'
import { createLogger } from '../utils/log'

const log = createLogger('subagent')

/**
 * 子代理系统（对标 Claude Code 的 Agent/Task 工具）：
 * 主 Agent 通过 task 工具委派独立上下文的子 Agent 执行子任务。
 * 子 Agent 复用主会话的模型/流式函数/API Key（宿主注册自 AgentManager.createAgent），
 * 独立 systemPrompt / tools / transcript，不污染主上下文。
 *
 * 两种子代理类型：
 * - plan：只读规划子代理。工具集限只读（含只读 bash），输出结构化实施计划。
 * - general：通用子代理。完整工具集 + 与主会话相同的权限钩子（危险工具仍弹确认）。
 *
 * 生命周期绑定宿主 Agent：createAgent 注册、evictAgentLocked 注销（防悬挂引用）。
 */

/** 子代理宿主配置（主 Agent 的能力快照，供子代理复用）。 */
export interface SubagentHost {
  sessionId: string
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  streamFn: StreamFn
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  /** plan 子代理的只读工具集（由 AgentManager 用 buildTools 过滤后注入）。 */
  planTools: AgentTool[]
  /** general 子代理的完整工具集（与主 Agent 一致）。 */
  generalTools: AgentTool[]
}

const hosts = new Map<string, SubagentHost>()

/** 注册宿主（createAgent 时调用；重复注册覆盖旧配置）。 */
export function registerSubagentHost(host: SubagentHost): void {
  hosts.set(host.sessionId, host)
}

/** 注销宿主（evictAgentLocked 时调用，防悬挂引用）。 */
export function unregisterSubagentHost(sessionId: string): void {
  hosts.delete(sessionId)
}

/**
 * plan 子代理的只读工具白名单（仅允许不落盘、不修改状态的工具）：
 * AgentManager 据此从 buildTools 结果过滤出 planTools 注入宿主。
 */
export const PLAN_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'search_knowledge',
  'list_memories',
  'read_skill',
  'find_skill',
  'bash'
])

const PLAN_SUBAGENT_SYSTEM_PROMPT = `你是主 Agent 委派的「规划」子代理，任务是为用户需求产出一份可执行的分步实施计划。

严格约束（只读模式）：
- 禁止修改、创建、删除任何文件；禁止执行任何破坏性命令（rm -rf、git push --force、sudo 等）。
- 只允许调用只读工具：读取/搜索文件、抓取网页、执行只读 shell 命令（ls / cat / grep / git status / git diff / git log 等）。

工作流程：
1. 理解需求：明确目标、约束与验收标准。
2. 探索代码库：定位相关文件、理解现有结构与依赖。
3. 设计方案：评估可行路径，标注关键取舍。
4. 输出分步计划：每步含涉及的关键文件/命令与预期产出。

输出格式：Markdown 分步计划，末尾附「关键实施文件」（3-5 个最需要改动的文件路径）。`

const GENERAL_SUBAGENT_SYSTEM_PROMPT = `你是主 Agent 委派的子代理，任务由委派信息给出。你可以使用全部可用工具（文件读写、命令执行等）来完成任务。你无法与用户直接对话，不要询问用户；遇到阻塞时基于已有信息做出合理决策。完成后输出简洁的最终报告：结论、改动清单、遗留问题。`

/** 只读钩子：plan 子代理的 bash 仅放行只读简单命令，其余一律拦截。 */
async function planReadonlyHook(
  ctx: BeforeToolCallContext
): Promise<BeforeToolCallResult | undefined> {
  if (ctx.toolCall.name !== 'bash') return undefined
  const command = (ctx.args as { command?: string }).command?.trim() ?? ''
  if (evaluateReadonlyBash(command)) return undefined
  return {
    block: true,
    reason: '只读子代理仅允许执行只读命令（如 ls / cat / git status / git diff / git log）'
  }
}

export interface RunSubagentParams {
  sessionId: string
  type: 'plan' | 'general'
  prompt: string
  description?: string
}

export interface RunSubagentResult {
  /** 子代理最终输出文本（给主 Agent 的工具结果）。 */
  content: string
  details: {
    type: 'plan' | 'general'
    description?: string
    turns: number
    durationMs: number
    error?: string
  }
}

/**
 * 运行一个子代理并等待其完成。期间经 onUpdate 推送累计输出文本快照
 * （替换语义，供 UI 的 task 工具卡片展示进度）。
 */
export async function runSubagent(
  params: RunSubagentParams,
  signal?: AbortSignal,
  onUpdate?: (text: string) => void
): Promise<RunSubagentResult> {
  const host = hosts.get(params.sessionId)
  if (!host) {
    throw new Error('当前会话的 Agent 宿主不存在，无法启动子代理（会话可能已切换/过期）')
  }
  const start = Date.now()
  const tools = params.type === 'plan' ? host.planTools : host.generalTools
  const systemPrompt =
    params.type === 'plan' ? PLAN_SUBAGENT_SYSTEM_PROMPT : GENERAL_SUBAGENT_SYSTEM_PROMPT
  const initialMessages: AgentMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: params.description
            ? `任务说明：${params.description}\n\n任务内容：\n${params.prompt}`
            : params.prompt
        }
      ],
      timestamp: Date.now()
    }
  ]
  const subagent = new Agent({
    initialState: {
      systemPrompt,
      model: host.model,
      thinkingLevel: host.thinkingLevel,
      tools,
      messages: initialMessages
    },
    streamFn: host.streamFn,
    getApiKey: host.getApiKey,
    toolExecution: 'sequential',
    // plan 子代理只读钩子；general 子代理复用主会话权限确认（危险工具仍弹用户确认）
    beforeToolCall:
      params.type === 'plan' ? planReadonlyHook : createBeforeToolCallHook(params.sessionId),
    // 独立 session 标识：provider 侧缓存键与主会话区分
    sessionId: `${params.sessionId}:sub:${params.type}:${randomUUID().slice(0, 8)}`
  })

  let turns = 0
  let outputBuffer = ''
  let failed = false
  const unsub = subagent.subscribe((event) => {
    // 流式进度：累计 assistant 文本推给主 Agent 的工具卡片（替换语义）
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const text = extractMessageText(event.message.content)
      if (text) {
        outputBuffer = outputBuffer ? `${outputBuffer}\n\n${text}` : text
        onUpdate?.(outputBuffer)
      }
    }
    if (event.type === 'turn_end') turns += 1
    // 子代理的 LLM 调用同样计入会话用量（kind='chat'，与主流程同口径）
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const a = event.message as AssistantMessage
      try {
        db.recordUsage({
          sessionId: params.sessionId,
          kind: 'chat',
          provider: a.provider,
          model: a.model,
          promptTokens: a.usage.input,
          completionTokens: a.usage.output,
          cost: resolveAssistantCost(a.provider, a.usage, Date.now(), a.usage.cost.total),
          timestamp: Date.now()
        })
      } catch (err) {
        log.error('子代理用量记录失败', { sessionId: params.sessionId, error: err })
      }
    }
  })

  const onAbort = (): void => {
    if (subagent.signal) subagent.abort()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    await subagent.prompt(initialMessages)
    await subagent.waitForIdle()
  } catch (err) {
    failed = true
    log.error('子代理运行失败', { sessionId: params.sessionId, type: params.type, error: err })
  } finally {
    unsub()
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  const durationMs = Date.now() - start
  const error = subagent.state.errorMessage
  const content =
    outputBuffer.trim() ||
    (error ? `（子代理未产出有效输出）\n${error}` : '（子代理未产出有效输出）')
  log.info('子代理运行完成', {
    sessionId: params.sessionId,
    type: params.type,
    turns,
    durationMs,
    failed
  })
  return {
    content,
    details: {
      type: params.type,
      description: params.description,
      turns,
      durationMs,
      error: error || (failed ? '子代理运行失败' : undefined)
    }
  }
}

/** 从消息 content 中提取纯文本（text block 拼接；供流式进度与结果汇总）。 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: unknown } => !!b && typeof b === 'object')
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim()
}
