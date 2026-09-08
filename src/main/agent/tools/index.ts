import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readFileTool, createReadFileTool } from './read-file'
import { listFilesTool } from './list-files'
import { createGlobTool } from './glob'
import { createGrepTool } from './grep'
import { writeFileTool } from './write-file'
import { editFileTool } from './edit-file'
import { createBashTools } from './bash'
import { webSearchTool } from './web-search'
import { webFetchTool } from './web-fetch'
import { createDownloadTool } from './download'
import { findSkillTool } from './find-skill'
import { installSkillTool } from './install-skill'
import { readSkillTool } from './read-skill'
import { listMemoriesTool, addMemoryTool, updateMemoryTool, deleteMemoryTool } from './memory'
import { searchKnowledgeTool } from './knowledge'
import { notifyTool } from './notify'
import { createPlanModeTools } from './plan-mode'
import { createAskUserTool } from './ask-user'
import { createTaskTool } from './task'
import { mcpToolsTool, mcpCallTool } from './mcp'
import { db } from '../../database'
import { getSessionFsPolicy, isPathWithinAny } from '../sandbox'
import {
  SETTING_ENABLED_TOOLS,
  SETTING_MEMORY_ENABLED,
  SETTING_SKILLS_ENABLED,
  SETTING_KB_ENABLED
} from '../types'
import type { ToolInfo } from '../types'

/**
 * 工具注册表：全部可用工具及其默认启用状态。
 * 新增工具在此登记即可被开关 UI 识别。
 * web_search 依赖 Tavily API Key（需在设置中配置），默认关闭。
 * find_skill / install_skill / read_skill 依赖公开 API（字节 Find Skill / 腾讯 SkillHub，无需 Key），默认开启。
 * 需要绑定会话的工具（read_file 按模型图片能力、bash 家族按 Agent 会话）走 build 工厂；
 * 其余无状态单例直接复用。
 */
interface ToolRegistryEntry {
  name: string
  label: string
  description: string
  defaultEnabled: boolean
  build: (opts: { sessionId: string; supportsImages?: boolean }) => AgentTool[]
}

/** 无状态单例工具 → 注册表条目（build 直接返回单例）。 */
function single(tool: AgentTool, defaultEnabled = true): ToolRegistryEntry {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    defaultEnabled,
    build: () => [tool]
  }
}

/** bash 家族元数据（bash / bash_output / kill_shell / bash_input），build 时按 Agent 会话重建。 */
const [bashMeta, bashOutputMeta, killShellMeta, bashInputMeta] = createBashTools('')

/** Plan Mode 家族元数据（enter_plan_mode / exit_plan_mode / report_step），build 时按 Agent 会话重建。 */
const [enterPlanMeta, exitPlanMeta, reportStepMeta] = createPlanModeTools('')

const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    name: readFileTool.name,
    label: readFileTool.label,
    description: readFileTool.description,
    defaultEnabled: true,
    build: ({ supportsImages }) => [createReadFileTool(supportsImages ?? false)]
  },
  single(listFilesTool),
  // glob / grep / download 按 Agent 会话绑定工作目录（默认搜索根/落盘目录），故用工厂
  {
    name: 'glob',
    label: '匹配文件',
    description: '按 glob 模式查找文件，返回匹配的文件路径（按修改时间从新到旧排序）。',
    defaultEnabled: true,
    build: ({ sessionId }) => [createGlobTool(sessionId)]
  },
  {
    name: 'grep',
    label: '搜索内容',
    description: '按正则表达式搜索文件内容，返回匹配的文件/行。',
    defaultEnabled: true,
    build: ({ sessionId }) => [createGrepTool(sessionId)]
  },
  {
    name: 'download',
    label: '下载文件',
    description: '从 URL 下载文件到本地磁盘（默认保存到工作目录）。',
    defaultEnabled: true,
    build: ({ sessionId }) => [createDownloadTool(sessionId)]
  },
  single(writeFileTool),
  single(editFileTool),
  {
    name: bashMeta.name,
    label: bashMeta.label,
    description: bashMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) => createBashTools(sessionId).filter((t) => t.name === 'bash')
  },
  {
    name: bashOutputMeta.name,
    label: bashOutputMeta.label,
    description: bashOutputMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) => createBashTools(sessionId).filter((t) => t.name === 'bash_output')
  },
  {
    name: killShellMeta.name,
    label: killShellMeta.label,
    description: killShellMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) => createBashTools(sessionId).filter((t) => t.name === 'kill_shell')
  },
  {
    name: bashInputMeta.name,
    label: bashInputMeta.label,
    description: bashInputMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) => createBashTools(sessionId).filter((t) => t.name === 'bash_input')
  },
  {
    name: enterPlanMeta.name,
    label: enterPlanMeta.label,
    description: enterPlanMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) =>
      createPlanModeTools(sessionId).filter((t) => t.name === 'enter_plan_mode')
  },
  {
    name: exitPlanMeta.name,
    label: exitPlanMeta.label,
    description: exitPlanMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) =>
      createPlanModeTools(sessionId).filter((t) => t.name === 'exit_plan_mode')
  },
  {
    name: reportStepMeta.name,
    label: reportStepMeta.label,
    description: reportStepMeta.description,
    defaultEnabled: true,
    build: ({ sessionId }) => createPlanModeTools(sessionId).filter((t) => t.name === 'report_step')
  },
  {
    name: 'ask_user',
    label: '询问用户',
    description: '向用户提问以澄清需求或确认关键决策（结构化选项，规划期常用）。',
    defaultEnabled: true,
    build: ({ sessionId }) => [createAskUserTool(sessionId)]
  },
  {
    name: 'task',
    label: '委派子任务',
    description: '委派独立上下文的子代理执行子任务（plan 只读规划 / general 通用执行）。',
    defaultEnabled: true,
    build: ({ sessionId }) => [createTaskTool(sessionId)]
  },
  // MCP 发现层/通用调用：元工具常驻，MCP server 工具按需经其发现与调用（见 tools/mcp.ts）
  single(mcpToolsTool),
  single(mcpCallTool),
  single(webSearchTool, false),
  single(webFetchTool),
  single(findSkillTool),
  single(installSkillTool),
  single(readSkillTool),
  single(listMemoriesTool),
  single(addMemoryTool),
  single(updateMemoryTool),
  single(deleteMemoryTool),
  single(searchKnowledgeTool),
  single(notifyTool)
]

/** 技能域工具：受「技能」总开关（skillsEnabled）控制。 */
const SKILL_TOOLS = new Set(['find_skill', 'install_skill', 'read_skill'])
/** 记忆域工具：受「记忆」总开关（memoryEnabled）控制。 */
const MEMORY_TOOLS = new Set(['list_memories', 'add_memory', 'update_memory', 'delete_memory'])
/** 知识库域工具：受「知识库」总开关（kbEnabled）控制。 */
const KB_TOOLS = new Set(['search_knowledge'])
/** bash 辅助工具：随 bash 一起启停（单独关闭 bash 时一并移除）。 */
const BASH_AUX_TOOLS = new Set(['bash_output', 'kill_shell', 'bash_input'])

/** 文件域写工具：沙箱开启时目标路径必须在「工作区 + 可写目录 + 临时目录」内。 */
const FS_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'download'])
/** 文件域读工具：沙箱开启时命中「禁止读取」目录即拒绝。 */
const FS_READ_TOOLS = new Set(['read_file'])

/** 读取持久化的工具启用覆盖（toolName → 是否启用）。 */
function readOverrides(): Record<string, boolean> {
  return db.getSetting<Record<string, boolean>>(SETTING_ENABLED_TOOLS) ?? {}
}

/**
 * 列出全部工具及其当前启用状态（合并默认值与持久化覆盖）。
 * 供 renderer 工具开关 UI 展示。
 */
export function listTools(): ToolInfo[] {
  const overrides = readOverrides()
  return TOOL_REGISTRY.map((entry) => ({
    name: entry.name,
    label: entry.label,
    description: entry.description,
    enabled: overrides[entry.name] ?? entry.defaultEnabled
  }))
}

/**
 * 汇总注入 Agent 的工具。
 *
 * 缓存稳定性设计（2026-09）：
 * 工具定义是请求前缀的一部分，改动它（增删/顺序）会让服务端前缀缓存整段失效，且伴随驱逐会话。
 * 因此这里遵循「工具数组尽量恒定 + 启停用执行层掩码」：
 * - **注入集合固定**：取「默认启用 或 用户曾显式开启」的并集，几乎不随开关变化
 *   （唯一例外：默认关闭的工具如 web_search，首次开启会加入集合——低频显式操作，可接受一次重建）。
 * - **启停即时生效、不驱逐**：每个工具包一层执行门控 wrapGate，调用时实时读
 *   enabledTools 覆盖与域总开关（技能/记忆/知识库/bash），被关则返回「已停用」提示。
 * 关闭工具仍占少量 schema 位，换来：开关永不改变上下文、永不中断会话。
 */
export interface BuildToolsOptions {
  /** 当前模型是否支持图片输入（model.input 含 'image'），决定 read_file 读图片时的行为。 */
  supportsImages?: boolean
  /** 当前 Agent 会话 id：bash 家族工具绑定持久化 shell / 后台会话用。 */
  sessionId: string
  /** 排除的工具名集合：子代理注入时剔除宿主专用工具（plan 模式 / ask_user / task 等）。 */
  exclude?: Iterable<string>
}

/** 工具此刻是否可用（开关覆盖 + 域总开关 + bash 联动，调用时实时求值）。 */
function isToolCurrentlyEnabled(name: string): boolean {
  const overrides = readOverrides()
  if (overrides[name] === false) return false
  const skillsEnabled = db.getSetting<boolean>(SETTING_SKILLS_ENABLED) !== false
  if (!skillsEnabled && SKILL_TOOLS.has(name)) return false
  const memoryEnabled = db.getSetting<boolean>(SETTING_MEMORY_ENABLED) !== false
  if (!memoryEnabled && MEMORY_TOOLS.has(name)) return false
  const kbEnabled = db.getSetting<boolean>(SETTING_KB_ENABLED) !== false
  if (!kbEnabled && KB_TOOLS.has(name)) return false
  const bashEnabled = overrides['bash'] ?? true
  if (!bashEnabled && (name === 'bash' || BASH_AUX_TOOLS.has(name))) return false
  return true
}

/** 给单个工具套执行门控：被关时直接返回「已停用」提示，不执行内部逻辑。 */
function wrapGate(tool: AgentTool): AgentTool {
  const { name, label } = tool
  const origExecute = tool.execute
  const execute = (async (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown
  ) => {
    if (!isToolCurrentlyEnabled(name)) {
      return {
        content: [
          {
            type: 'text',
            text: `工具「${label ?? name}」当前已停用（设置中已关闭）。如需使用，请先在「设置 → 工具」中开启；开关即时生效，无需中断当前对话。`
          }
        ],
        details: {}
      }
    }
    return (origExecute as (...args: unknown[]) => Promise<unknown>).call(
      tool,
      toolCallId,
      params,
      signal,
      onUpdate
    )
  }) as unknown as typeof tool.execute
  return { ...tool, execute }
}

/**
 * 文件域沙箱策略门：沙箱开启时，写工具（write_file/edit_file/download）的目标路径须在
 * 「工作区 + 可写目录 + 临时目录」内，读工具（read_file）不得命中「禁止读取」目录。
 * 与 bash 沙箱共用同一边界（见 sandbox.ts getSessionFsPolicy），关闭时不做任何拦截。
 */
function wrapSandboxFsPolicy(tool: AgentTool, sessionId: string): AgentTool {
  const { name } = tool
  if (!FS_WRITE_TOOLS.has(name) && !FS_READ_TOOLS.has(name)) return tool
  const origExecute = tool.execute
  const execute = (async (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown
  ) => {
    const path = (params as { path?: string } | null | undefined)?.path
    if (path) {
      const policy = await getSessionFsPolicy(sessionId)
      if (policy) {
        if (FS_WRITE_TOOLS.has(name)) {
          const allowed =
            isPathWithinAny(path, policy.allowWriteRoots) &&
            !isPathWithinAny(path, policy.denyReadRoots)
          if (!allowed) {
            throw new Error(
              `沙箱已开启：写入路径「${path}」不在可写范围内（工作区 / 可写目录 / 系统临时目录）。如需写入，请到「设置 → 沙箱 → 可写目录」添加后重试，或临时关闭沙箱。`
            )
          }
        } else if (isPathWithinAny(path, policy.denyReadRoots)) {
          throw new Error(
            `沙箱已开启：路径「${path}」位于「禁止读取」目录内，拒绝读取。如需访问，请到「设置 → 沙箱 → 禁止读取的目录」调整。`
          )
        }
      }
    }
    return (origExecute as (...args: unknown[]) => Promise<unknown>).call(
      tool,
      toolCallId,
      params,
      signal,
      onUpdate
    )
  }) as unknown as typeof tool.execute
  return { ...tool, execute }
}

export function buildTools(opts: BuildToolsOptions = { sessionId: '' }): AgentTool[] {
  const overrides = readOverrides()
  const exclude = new Set(opts.exclude ?? [])
  const result: AgentTool[] = []
  for (const entry of TOOL_REGISTRY) {
    if (exclude.has(entry.name)) continue
    // 注入判定：默认启用或用户曾显式开启；一旦开启过即长期留在集合内（保持工具数组稳定）
    const everOn = entry.defaultEnabled || overrides[entry.name] === true
    if (!everOn) continue
    result.push(...entry.build(opts).map((t) => wrapGate(wrapSandboxFsPolicy(t, opts.sessionId))))
  }
  return result
}
