import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { mcpManager } from '../mcp'

/**
 * MCP 发现层与通用调用元工具（常驻注入，不随 server 启停变化）。
 *
 * 背景：MCP server 工具不再逐工具注入（见 mcp/index.ts 顶部说明）。Agent 需要浏览器/外部
 * 能力时，先 mcp_tools 找到目标 server 与工具（可无参看目录 / keywords 搜索 / server 展开），
 * 必要时再取该工具的参数 Schema，最后 mcp_call 执行。执行时主进程实时校验服务器与工具的
 * 当前可用性——对话中停用/删除服务器会得到明确错误，不会中断会话。
 */

const toolsParams = Type.Object({
  server: Type.Optional(
    Type.String({
      description:
        'MCP 服务器名称或 id（mcp_tools 目录输出中给出）。传入后返回该服务器全部可用工具；与 tool 同传时返回该工具的完整参数说明。'
    })
  ),
  tool: Type.Optional(
    Type.String({
      description:
        '目标工具名。仅在同时传入 server 时生效：返回该工具的完整参数 JSON Schema，mcp_call 构造参数前必看。'
    })
  ),
  keywords: Type.Optional(
    Type.String({
      description:
        '按需求搜索 MCP 工具（匹配服务器名 / 工具名 / 用途说明）。不传且未指定 server 时，返回已启用服务器的分类目录（按使用热度排序）。'
    })
  )
})

/** MCP 工具目录/搜索/详情。 */
export const mcpToolsTool: AgentTool<typeof toolsParams, { text: string }> = {
  name: 'mcp_tools',
  label: 'MCP 工具目录',
  description:
    '发现并浏览 MCP 服务器提供的工具（本应用的 MCP 工具不会预注入，使用前必须先经本工具找到目标工具并查看参数）：' +
    '不传参数 → 已启用服务器目录（按常用度排序，先介绍服务器，Agent 自行判断是否深入）；' +
    '传 keywords → 按需求搜索匹配的工具；传 server → 查看该服务器全部可用工具；' +
    'server+tool 同传 → 查看单个工具的完整参数说明。找到目标后用 mcp_call 调用。',
  parameters: toolsParams,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const text = await mcpManager.describeMcp({
      server: p.server,
      tool: p.tool,
      keywords: p.keywords
    })
    return { content: [{ type: 'text', text }], details: { text } }
  }
}

const callParams = Type.Object({
  server: Type.String({
    description: 'MCP 服务器名称或 id（mcp_tools 目录输出中给出）。'
  }),
  tool: Type.String({
    description: '要调用的 MCP 工具名。调用前应先用 mcp_tools(server=…, tool=…) 查看其参数说明。'
  }),
  args: Type.Optional(
    Type.Any({
      description:
        '传给 MCP 工具的 JSON 对象参数。请严格按 mcp_tools 返回的参数 Schema 构造（必填字段不可省略）。'
    })
  )
})

/** 通用 MCP 工具调用（实时校验 server/工具可用，含对话中停用兜底）。 */
export const mcpCallTool: AgentTool<
  typeof callParams,
  { server: string; tool: string; ok: boolean }
> = {
  name: 'mcp_call',
  label: '调用 MCP 工具',
  description:
    '调用指定 MCP 服务器上的工具（工具需先用 mcp_tools 找到并确认）。主进程会实时校验：服务器已停用/已删除、工具不存在或连接失败时，返回明确错误（不会中断会话），可据提示修正或改用 mcp_tools 重新查看当前可用工具。',
  parameters: callParams,
  executionMode: 'sequential',
  async execute(_toolCallId, p) {
    const result = await mcpManager.invokeTool({ server: p.server, tool: p.tool, args: p.args })
    if (!result.ok) {
      return {
        content: [{ type: 'text', text: result.text }],
        details: { server: p.server, tool: p.tool, ok: false }
      }
    }
    return { content: result.content, details: { server: p.server, tool: p.tool, ok: true } }
  }
}
