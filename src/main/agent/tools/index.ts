import type { AgentTool } from '@earendil-works/pi-agent-core'
import { readFileTool } from './read-file'
import { listFilesTool } from './list-files'
import { writeFileTool } from './write-file'
import { editFileTool } from './edit-file'
import { bashTool } from './bash'
import { webSearchTool } from './web-search'
import { findSkillTool } from './find-skill'
import { installSkillTool } from './install-skill'
import { readSkillTool } from './read-skill'
import { listMemoriesTool, addMemoryTool, updateMemoryTool, deleteMemoryTool } from './memory'
import { searchKnowledgeTool } from './knowledge'
import { notifyTool } from './notify'
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
 */
const TOOL_REGISTRY: { tool: AgentTool; defaultEnabled: boolean }[] = [
  { tool: readFileTool, defaultEnabled: true },
  { tool: listFilesTool, defaultEnabled: true },
  { tool: writeFileTool, defaultEnabled: true },
  { tool: editFileTool, defaultEnabled: true },
  { tool: bashTool, defaultEnabled: true },
  { tool: webSearchTool, defaultEnabled: false },
  { tool: findSkillTool, defaultEnabled: true },
  { tool: installSkillTool, defaultEnabled: true },
  { tool: readSkillTool, defaultEnabled: true },
  { tool: listMemoriesTool, defaultEnabled: true },
  { tool: addMemoryTool, defaultEnabled: true },
  { tool: updateMemoryTool, defaultEnabled: true },
  { tool: deleteMemoryTool, defaultEnabled: true },
  { tool: searchKnowledgeTool, defaultEnabled: true },
  { tool: notifyTool, defaultEnabled: true }
]

/** 技能域工具：受「技能」总开关（skillsEnabled）控制。 */
const SKILL_TOOLS = new Set(['find_skill', 'install_skill', 'read_skill'])
/** 记忆域工具：受「记忆」总开关（memoryEnabled）控制。 */
const MEMORY_TOOLS = new Set(['list_memories', 'add_memory', 'update_memory', 'delete_memory'])
/** 知识库域工具：受「知识库」总开关（kbEnabled）控制。 */
const KB_TOOLS = new Set(['search_knowledge'])

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
    name: entry.tool.name,
    label: entry.tool.label,
    description: entry.tool.description,
    enabled: overrides[entry.tool.name] ?? entry.defaultEnabled
  }))
}

/**
 * 汇总启用的工具，注入 Agent initialState.tools。
 * 被关闭的工具不会注入，Agent 也就无法调用。
 * 危险工具（write_file / bash）仍由各自 executionMode='sequential' +
 * beforeToolCall 钩子做权限确认，开关只控制是否可用。
 * 功能域总开关（技能/记忆）关闭时，对应域工具一律不注入（即使单项开关为 true）。
 */
export function buildTools(): AgentTool[] {
  const overrides = readOverrides()
  const skillsEnabled = db.getSetting<boolean>(SETTING_SKILLS_ENABLED) !== false
  const memoryEnabled = db.getSetting<boolean>(SETTING_MEMORY_ENABLED) !== false
  const kbEnabled = db.getSetting<boolean>(SETTING_KB_ENABLED) !== false
  return TOOL_REGISTRY.filter((entry) => {
    if (!skillsEnabled && SKILL_TOOLS.has(entry.tool.name)) return false
    if (!memoryEnabled && MEMORY_TOOLS.has(entry.tool.name)) return false
    if (!kbEnabled && KB_TOOLS.has(entry.tool.name)) return false
    return overrides[entry.tool.name] ?? entry.defaultEnabled
  }).map((entry) => entry.tool)
}
