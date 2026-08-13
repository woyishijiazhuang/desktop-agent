import { app } from 'electron'
import { db } from '../database'
import { SETTING_AGENT_WORKDIR } from './types'

/**
 * 解析 Agent 工作目录：settings 已配置 > 环境默认值。
 * - 开发环境（未打包）：process.cwd() = electron-vite 启动的项目根，便于调试
 *   （打包后 process.cwd() 是启动者目录/根目录，不可用）。
 * - 生产环境（已打包）：用户主目录 app.getPath('home')，可写且符合用户预期。
 * Agent 系统提示的「工作目录」行与 bash 工具默认 cwd 均以该值兜底。
 */
export function resolveAgentWorkdir(): string {
  const configured = db.getSetting<string>(SETTING_AGENT_WORKDIR)
  if (configured) return configured
  if (!app.isPackaged) {
    const dev = typeof process !== 'undefined' ? process.cwd() : ''
    if (dev) return dev
  }
  return app.getPath('home')
}
