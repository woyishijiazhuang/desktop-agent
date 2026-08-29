import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { runSubagent } from '../subagent'
import type { RunSubagentResult } from '../subagent'

const taskParams = Type.Object({
  subagentType: Type.Union([Type.Literal('plan'), Type.Literal('general')], {
    description:
      '子代理类型：plan = 只读规划（探索代码库并产出实施计划）；general = 通用执行（完整工具集，可读写/执行命令）'
  }),
  prompt: Type.String({
    description:
      '委派给子代理的任务描述：目标、约束、期望输出。子代理有独立上下文，无法看到本会话对话，需自包含描述'
  }),
  description: Type.Optional(
    Type.String({
      description: '任务一句话说明（可选）：展示在 UI 卡片上，方便用户快速理解子代理在做什么'
    })
  )
})

export interface TaskDetails {
  type: 'plan' | 'general'
  description?: string
  turns: number
  durationMs: number
  error?: string
}

/**
 * 子代理委派工具（对标 Claude Code 的 Agent/Task 工具）：
 * 把独立子任务委派给隔离上下文的子 Agent，完成后返回其最终输出。
 * - plan：只读规划子代理，产出分步实施计划（配合 enter/exit_plan_mode 使用）
 * - general：通用子代理，可执行文件操作与命令（危险操作沿用主会话权限确认）
 * 按 Agent 会话绑定（子代理宿主注册于 AgentManager），故用工厂。
 */
export function createTaskTool(sessionId: string): AgentTool<typeof taskParams, TaskDetails> {
  return {
    name: 'task',
    label: '委派子任务',
    description:
      '将独立子任务委派给子代理执行（subagentType=plan 为只读规划、general 为通用执行），完成后返回子代理的输出。适合并行探索/隔离复杂子任务，避免占用主上下文。plan 子代理常与计划模式配合：进入计划模式后委派 plan 子代理产出实施计划，再 exit_plan_mode 提交审批。',
    parameters: taskParams,
    executionMode: 'sequential',
    async execute(_toolCallId, p, signal, onUpdate) {
      const result: RunSubagentResult = await runSubagent(
        { sessionId, type: p.subagentType, prompt: p.prompt, description: p.description },
        signal,
        (text) =>
          onUpdate?.({
            content: [{ type: 'text', text }],
            details: { type: p.subagentType, description: p.description, turns: 0, durationMs: 0 }
          })
      )
      return {
        content: [
          {
            type: 'text',
            text:
              `子代理（${p.subagentType === 'plan' ? '规划' : '通用'}）已完成，${result.details.turns} 轮。输出如下：\n\n${result.content}` +
              (result.details.error ? `\n\n[注意] ${result.details.error}` : '')
          }
        ],
        details: result.details
      }
    }
  }
}
