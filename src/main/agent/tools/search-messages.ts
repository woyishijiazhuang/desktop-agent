import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { db } from '../../database'
import { createLogger } from '../../utils/log'
import { extractMessageText } from '@shared/message-text'

const log = createLogger('tool:search-messages')

const MAX_LIMIT = 30
const MAX_WINDOW_SIDE = 10
/** 单条消息正文展示上限，超出截断。 */
const MAX_MSG_CHARS = 4000
/** 读取模式窗口总展示字符上限，超出截断。 */
const MAX_READ_CHARS = 15_000

const searchParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        '搜索关键词，用于在历史会话消息中查找相关内容。读取模式（提供了 message_id）下请勿填写。'
    })
  ),
  session_id: Type.Optional(
    Type.String({
      description: '可选：把搜索范围限定在该会话（session id）内。不传则搜索所有未删除会话。'
    })
  ),
  limit: Type.Optional(Type.Number({ description: '搜索模式返回结果条数，默认 10，最大 30。' })),
  message_id: Type.Optional(
    Type.Number({
      description:
        '可选：精确读取某条消息。值为搜索模式结果行里形如 (id=数字) 的消息 id。提供了该参数即进入读取模式：返回这条消息的全文，并默认带上其前后各 3 条相邻消息作为上下文。'
    })
  ),
  before: Type.Optional(
    Type.Number({
      description:
        '读取模式下，目标消息之前（不含）额外返回的条数，默认 3，最大 10；填 0 表示不取前文。'
    })
  ),
  after: Type.Optional(
    Type.Number({
      description:
        '读取模式下，目标消息之后（不含）额外返回的条数，默认 3，最大 10；填 0 表示不取后文。'
    })
  )
})

type Params = {
  query?: string
  session_id?: string
  limit?: number
  message_id?: number
  before?: number
  after?: number
}

/** 工具结构化返回（日志/前端渲染用）。读取模式额外携带锚点与窗口信息。 */
export interface SearchMessagesDetails {
  hits: number
  mode: 'search' | 'read'
  sessionId?: string
  messageId?: number
  sessionTitle?: string
  anchorOrdinal?: number
  total?: number
  before?: number
  after?: number
}

type ToolResult = AgentToolResult<SearchMessagesDetails>

const ROLE_LABELS: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  toolResult: '工具结果',
  system: '系统'
}

/** 消息正文 → 纯文本（取全部 text block；toolResult 内容通常即文本块）。 */
function messageBody(content: unknown): string {
  return extractMessageText(content)
}

/** 单条消息的展示片段：角色 + 时间 + （工具名）。 */
function roleHead(role: string, timestamp: number, toolName?: string | null): string {
  const roleLabel = ROLE_LABELS[role] ?? role
  const time = new Date(timestamp).toLocaleString('zh-CN')
  const tool = toolName ? ` · 工具 ${toolName}` : ''
  return `${roleLabel}${tool} · ${time}`
}

/** 截断超长正文，追加省略标记。 */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[内容过长已截断]` : text
}

/**
 * 历史消息检索工具：两种模式
 * 1. 搜索模式（默认，给 query）：全文检索历史会话消息（用户/助手正文、思考、工具调用等），
 *    返回带 message_id 锚点的命中列表（每条只有一小段命中上下文）。
 * 2. 读取模式（给 message_id，源自搜索结果锚点）：精确返回该条消息的全文，
 *    并默认附带其会话内前后各 3 条相邻消息，便于结合上下文理解「当时到底聊了什么 / 结论是什么」。
 * 搜索只覆盖未删除的会话。
 */
export const searchMessagesTool: AgentTool<typeof searchParams, SearchMessagesDetails> = {
  name: 'search_messages',
  label: '搜索/读取历史消息',
  description:
    '在当前工作区的会话历史中搜索关键词，或按消息 id 读取某条消息的全文及其前后上下文。\n' +
    '两种用法：\n' +
    '① 搜索：传 query（可加 session_id 限定单会话）→ 返回命中消息的摘要与 message_id 锚点；\n' +
    '② 读取：把搜索结果的 (id=数字) 锚点作为 message_id 传入 → 精确返回该条全文，并默认带前 3 后 3 条上下文（可用 before/after 调整，0 则只取目标条）。\n' +
    '搜索的摘要较短，回答涉及历史具体表述、决策理由或需要还原一段对话时，请继续用 ② 读取完整内容。不搜索已删除的会话。',
  parameters: searchParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    // 模式判定：message_id 存在 → 读取；否则 → 搜索
    if (p.message_id !== undefined) {
      if (p.query !== undefined && p.query.trim() !== '') {
        throw new Error(
          'search_messages 的 query 与 message_id 只需传其一：要按关键词搜索请只传 query，要读取某条消息请只传 message_id（值为搜索结果里 (id=数字) 的锚点）。'
        )
      }
      return executeRead(p)
    }
    return executeSearch(p)
  }
}

/** 读取模式：按 message_id 取目标消息全文 + 前后相邻上下文（默认各 3，单侧上限 10）。 */
function executeRead(p: Params): Promise<ToolResult> {
  const messageId = Math.floor(p.message_id!)
  if (!Number.isFinite(messageId) || messageId <= 0) {
    throw new Error(`message_id 非法：${p.message_id}。请从搜索结果的 (id=数字) 锚点取值。`)
  }
  const before = clampSide(p.before, 3)
  const after = clampSide(p.after, 3)

  const window = db.getMessageWindow(messageId, { before, after })
  if (!window) {
    return Promise.resolve({
      content: [
        {
          type: 'text',
          text: `（未找到 message_id=${messageId} 的消息：可能已被删除，或所属会话已删除/不存在。请先用 query 搜索定位现存的消息。）`
        }
      ],
      details: { hits: 0, mode: 'read', messageId }
    })
  }

  const lines: string[] = []
  lines.push(
    `[历史消息读取 · 会话「${window.sessionTitle}」 · 共 ${window.total} 条 · 目标为第 ${window.anchorOrdinal} 条 (id=${messageId})]`
  )
  lines.push(
    `返回 ${window.messages.length} 条（前 ${Math.min(before, window.anchorOrdinal - 1)} 后 ${Math.min(after, window.total - window.anchorOrdinal)} 实际可用）`
  )
  let used = 0
  let truncated = false
  for (const item of window.messages) {
    const { message } = item
    const marker = message.id === messageId ? ' >>[目标]' : ''
    const head = `第 ${item.ordinal}/${window.total} 条 · ${roleHead(message.role, message.timestamp, message.toolName)} · (id=${message.id})`
    const body = cap(messageBody(message.content), MAX_MSG_CHARS) || '（该条无文本内容）'
    const block = `\n── ${head}${marker} ──\n${body}`
    if (used + block.length > MAX_READ_CHARS) {
      truncated = true
      break
    }
    lines.push(block)
    used += block.length
  }
  if (truncated) {
    lines.push('\n…[窗口内容过长已截断：可缩小 before/after，或用 search 定位更精确的消息]')
  }

  const text = lines.join('')
  log.debug('读取历史消息', { messageId, before, after, returned: window.messages.length })
  return Promise.resolve({
    content: [{ type: 'text', text }],
    details: {
      hits: window.messages.length,
      mode: 'read',
      messageId,
      sessionId: window.sessionId,
      sessionTitle: window.sessionTitle,
      anchorOrdinal: window.anchorOrdinal,
      total: window.total,
      before,
      after
    }
  })
}

/** 搜索模式：FTS 关键词搜索（可按会话限定），命中携带 (id=数字) 锚点供读取模式复用。 */
function executeSearch(p: Params): Promise<ToolResult> {
  const query = p.query?.trim()
  if (!query) {
    throw new Error(
      'search_messages 需要 query（关键词搜索）或 message_id（读取某条消息）。两者均未提供。'
    )
  }
  const limit = Math.max(1, Math.min(Math.floor(p.limit ?? 10), MAX_LIMIT))
  const hits = db.searchMessages(query, { limit, sessionId: p.session_id })

  if (hits.length === 0) {
    const scopeNote = p.session_id ? `（在会话 ${p.session_id} 内）` : ''
    return Promise.resolve({
      content: [
        {
          type: 'text',
          text: `（未找到相关历史消息${scopeNote}。可尝试更换更短的关键词或放宽表达后再搜。）`
        }
      ],
      details: { hits: 0, mode: 'search', sessionId: p.session_id }
    })
  }

  const lines = hits.map((h, i) => {
    const roleLabel = ROLE_LABELS[h.role] ?? h.role
    const time = new Date(h.timestamp).toLocaleString('zh-CN')
    return `${i + 1}. [${h.sessionTitle}] ${roleLabel} · ${time} (id=${h.messageId})\n${h.snippet}`
  })

  const text =
    `[历史消息搜索结果 · 共 ${hits.length} 条] 需要看某条的完整内容或前后对话时，把其 (id=数字) 作为 message_id 再次调用本工具。\n` +
    lines.join('\n\n')
  log.debug('搜索历史消息', { query, sessionId: p.session_id, hits: hits.length })
  return Promise.resolve({
    content: [{ type: 'text', text }],
    details: { hits: hits.length, mode: 'search', sessionId: p.session_id }
  })
}

/** 窗口单侧条数：默认值 + 0..10 夹取。 */
function clampSide(v: number | undefined, def: number): number {
  const n = Math.floor(v ?? def)
  return Math.max(0, Math.min(n, MAX_WINDOW_SIDE))
}
