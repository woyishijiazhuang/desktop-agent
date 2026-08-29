import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { db } from '../database'
import { SETTING_AGENT_WORKDIR } from './types'

/**
 * 解析 Agent 工作目录：settings 已配置 > 用户数据目录下的 work 子目录。
 * 默认值统一落在用户数据目录（开发/生产一致）：
 * - 开发时不会在源码目录（process.cwd()）生成文件；
 * - 打包安装后不会修改安装目录（应用常被安装到只读/受控位置）。
 * 返回前确保目录存在（自动创建），避免 bash 默认 cwd 指向不存在的目录。
 * Agent 系统提示的「工作目录」行与 bash 工具默认 cwd 均以该值兜底。
 */
export function resolveAgentWorkdir(): string {
  const configured = db.getSetting<string>(SETTING_AGENT_WORKDIR)
  const dir = configured || join(app.getPath('userData'), 'work')
  mkdirSync(dir, { recursive: true })
  return dir
}
