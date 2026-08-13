import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
  Usage,
  TextContent,
  ImageContent
} from '@earendil-works/pi-ai'
import type { Message as DbMessage, CreateMessageParams, MessageMetadata } from '../database'
import {
  saveImageAttachment,
  isLocalFileRef,
  toFileRef,
  fileRefToKey,
  readAttachmentBase64
} from './attachment'

// ==================== AgentMessage → DB 行参数（落库） ====================

/**
 * 将 AgentMessage 转换为 DB createMessage 的参数。
 * - user：content 存原始（string 或 block 数组）
 * - assistant：content 存 block 数组；finishReason 落独立列；api/provider/usage 快照存 metadata
 * - toolResult：content 存 block 数组；toolCallId/toolName 落独立列；isError/usage/details 存 metadata
 * - custom：整条消息序列化存 content，metadata 标记 custom
 * 注：token 用量/成本不写消息列，由调用方记入 usage_logs（token 统计的唯一数据源）。
 */
export function toCreateMessageParams(sessionId: string, msg: AgentMessage): CreateMessageParams {
  switch (msg.role) {
    case 'user': {
      const u = msg as UserMessage
      return {
        sessionId,
        role: 'user',
        content: u.content
      }
    }
    case 'assistant': {
      const a = msg as AssistantMessage
      const metadata: MessageMetadata = {
        api: a.api,
        provider: a.provider,
        usage: a.usage
      }
      return {
        sessionId,
        role: 'assistant',
        content: a.content,
        model: a.model,
        provider: a.provider,
        finishReason: a.stopReason,
        metadata
      }
    }
    case 'toolResult': {
      const t = msg as ToolResultMessage
      const metadata: MessageMetadata = {
        isError: t.isError,
        usage: t.usage ?? null,
        details: t.details ?? null
      }
      return {
        sessionId,
        role: 'toolResult',
        content: t.content,
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        metadata
      }
    }
    default: {
      // custom 消息：整条序列化存 content
      return {
        sessionId,
        role: (msg as { role: string }).role,
        content: msg,
        metadata: { custom: true }
      }
    }
  }
}

// ==================== DB 行 → AgentMessage（rehydrate） ====================

/** 从 DB 行恢复 AgentMessage，用于构造 Agent initialState.messages。 */
export function fromMessageRow(row: DbMessage): AgentMessage {
  switch (row.role) {
    case 'user':
      return {
        role: 'user',
        content: row.content as UserMessage['content'],
        timestamp: row.timestamp
      } as UserMessage

    case 'assistant': {
      const meta = (row.metadata ?? {}) as {
        api: string
        provider: string
        usage: Usage
      }
      return {
        role: 'assistant',
        content: row.content as AssistantMessage['content'],
        api: meta.api as AssistantMessage['api'],
        // provider 列优先（新库必填），metadata 冗余存一份作校验回退
        provider: (row.provider ?? meta.provider) as AssistantMessage['provider'],
        model: row.model ?? '',
        usage: meta.usage,
        stopReason: (row.finishReason ?? 'stop') as AssistantMessage['stopReason'],
        timestamp: row.timestamp
      } as AssistantMessage
    }

    case 'toolResult': {
      const meta = (row.metadata ?? {}) as {
        isError?: boolean
        usage?: Usage
        details?: unknown
      }
      return {
        role: 'toolResult',
        toolCallId: row.toolCallId ?? '',
        toolName: row.toolName ?? '',
        content: row.content as ToolResultMessage['content'],
        details: meta.details,
        usage: meta.usage,
        isError: meta.isError ?? false,
        timestamp: row.timestamp
      } as ToolResultMessage
    }

    default:
      // custom 消息：content 存的是完整对象
      return row.content as AgentMessage
  }
}

// ==================== 图片附件落盘 / 还原 ====================

/**
 * 落库前持久化 user 消息中的图片：base64 → 本地附件文件，data 替换为 file 引用。
 * 仅处理 user 消息（assistant/toolResult 无 image block）；非 user 或无图片时原样返回。
 * 落库的 content 因此只含轻量引用，图片本体在磁盘上。
 */
export async function persistMessageImages(
  sessionId: string,
  msg: AgentMessage
): Promise<AgentMessage> {
  if (msg.role !== 'user') return msg
  const content = (msg as UserMessage).content
  if (!Array.isArray(content)) return msg
  const blocks: (TextContent | ImageContent)[] = []
  let changed = false
  for (const block of content) {
    if (block.type === 'image' && typeof block.data === 'string' && !isLocalFileRef(block.data)) {
      const key = await saveImageAttachment(sessionId, block.mimeType, block.data)
      blocks.push({ type: 'image', data: toFileRef(key), mimeType: block.mimeType })
      changed = true
    } else {
      blocks.push(block)
    }
  }
  if (!changed) return msg
  return { ...msg, content: blocks }
}

/** 把消息 content 中的本地附件引用（file:）读盘还原为 base64（agent 输入态）。 */
async function resolveLocalImages(msg: AgentMessage): Promise<AgentMessage> {
  const content = (msg as { content: unknown }).content
  if (!Array.isArray(content)) return msg
  let changed = false
  const blocks = await Promise.all(
    content.map(async (b) => {
      const block = b as { type?: string; data?: unknown; mimeType?: string }
      if (block.type === 'image' && typeof block.data === 'string' && isLocalFileRef(block.data)) {
        changed = true
        const data = await readAttachmentBase64(fileRefToKey(block.data))
        return { ...block, data }
      }
      return b
    })
  )
  if (!changed) return msg
  return { ...msg, content: blocks } as AgentMessage
}

/**
 * 将 DB 消息行数组转换为 AgentMessage[]，用于 Agent 初始化。
 * 图片附件引用会异步读盘还原为 base64（模型输入需要真实图像数据）。
 * compressSummary 暂不处理（Phase 3 用 transformContext 注入），此处保留参数。
 */
export async function rowsToAgentMessages(
  rows: DbMessage[],
  _compressSummary: string | null
): Promise<AgentMessage[]> {
  // Phase 3 用 _compressSummary 经 transformContext 注入压缩摘要
  void _compressSummary
  const result: AgentMessage[] = []
  for (const row of rows) {
    result.push(await resolveLocalImages(fromMessageRow(row)))
  }
  return result
}
