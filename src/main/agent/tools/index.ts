import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readFileTool, createReadFileTool } from './read-file'
import { listFilesTool } from './list-files'
import { globTool } from './glob'
import { grepTool } from './grep'
import { writeFileTool } from './write-file'
import { editFileTool } from './edit-file'
import { createBashTools } from './bash'
import { webSearchTool } from './web-search'
import { webFetchTool } from './web-fetch'
import { downloadTool } from './download'
import { findSkillTool } from './find-skill'
import { installSkillTool } from './install-skill'
import { readSkillTool } from './read-skill'
import { listMemoriesTool, addMemoryTool, updateMemoryTool, deleteMemoryTool } from './memory'
import { searchKnowledgeTool } from './knowledge'
import { notifyTool } from './notify'
import { createPlanModeTools } from './plan-mode'
import { db } from '../../database'
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

/** Plan Mode 家族元数据（enter_plan_mode / exit_plan_mode），build 时按 Agent 会话重建。 */
const [enterPlanMeta, exitPlanMeta] = createPlanModeTools('')

const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    name: readFileTool.name,
    label: readFileTool.label,
    description: readFileTool.description,
    defaultEnabled: true,
    build: ({ supportsImages }) => [createReadFileTool(supportsImages ?? false)]
  },
  single(listFilesTool),
  single(globTool),
  single(grepTool),
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
  single(webSearchTool, false),
  single(webFetchTool),
  single(downloadTool),
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
 * 汇总启用的工具，注入 Agent initialState.tools。
 * 被关闭的工具不会注入，Agent 也就无法调用。
 * 危险工具（write_file / bash）仍由各自 executionMode='sequential' +
 * beforeToolCall 钩子做权限确认，开关只控制是否可用。
 * 功能域总开关（技能/记忆）关闭时，对应域工具一律不注入（即使单项开关为 true）。
 */
export interface BuildToolsOptions {
  /** 当前模型是否支持图片输入（model.input 含 'image'），决定 read_file 读图片时的行为。 */
  supportsImages?: boolean
  /** 当前 Agent 会话 id：bash 家族工具绑定持久化 shell / 后台会话用。 */
  sessionId: string
}

export function buildTools(opts: BuildToolsOptions = { sessionId: '' }): AgentTool[] {
  const overrides = readOverrides()
  const skillsEnabled = db.getSetting<boolean>(SETTING_SKILLS_ENABLED) !== false
  const memoryEnabled = db.getSetting<boolean>(SETTING_MEMORY_ENABLED) !== false
  const kbEnabled = db.getSetting<boolean>(SETTING_KB_ENABLED) !== false
  const bashEnabled = overrides['bash'] ?? true
  const result: AgentTool[] = []
  for (const entry of TOOL_REGISTRY) {
    const enabled = overrides[entry.name] ?? entry.defaultEnabled
    if (!enabled) continue
    if (!skillsEnabled && SKILL_TOOLS.has(entry.name)) continue
    if (!memoryEnabled && MEMORY_TOOLS.has(entry.name)) continue
    if (!kbEnabled && KB_TOOLS.has(entry.name)) continue
    // bash 辅助工具随 bash 启停：bash 被关闭时即便单独开启也一并移除
    if (BASH_AUX_TOOLS.has(entry.name) && !bashEnabled) continue
    result.push(...entry.build(opts))
  }
  return result
}
