import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { listInstalledSkills, listSkillFiles, readSkillFile } from '../skills-store'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:read_skill')

const params = Type.Object({
  reason: Type.Optional(
    Type.String({
      description:
        '用一句话（不超过 30 字）说明本次读取的目的（例如"读取周报技能的使用说明"）。请务必填写。'
    })
  ),
  skill: Type.Optional(
    Type.String({
      description:
        '已安装技能的标识（技能目录名 / id，如 pdf-toolkit-v2；技能名亦可，如 pdf-toolkit）。不传时返回全部已启用技能的清单（名称 + 用途），用于自主发现可用技能。'
    })
  ),
  file: Type.Optional(
    Type.String({
      description:
        '技能目录内的相对路径，默认 SKILL.md。不传时返回技能包的文件清单，方便了解可用资源。'
    })
  )
})

/**
 * 技能读取工具：读取已安装技能的 SKILL.md 说明或包内任意文件；
 * 不传 skill 参数时返回已安装技能清单，供 Agent 自主发现技能。
 * 技能增删不影响系统提示（系统提示只有静态引导语），本工具是技能信息的唯一动态入口。
 * 只读工具，可并行执行。
 */
export const readSkillTool: AgentTool<
  typeof params,
  { skill?: string; file: string; fileCount: number }
> = {
  name: 'read_skill',
  label: '技能读取',
  description:
    '查看已安装技能清单，或读取某个技能（SKILL.md / 包内文件）。执行任务前先调用本工具发现并获取技能使用说明。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    // 不传 skill：返回已启用技能清单（名称 + 用途），供 Agent 判断任务是否命中。
    // 停用的技能不出现在清单中（Agent 无法自主发现），与「停用 = 彻底不可用」语义一致。
    if (!p.skill || !p.skill.trim()) {
      const skills = listInstalledSkills().filter((s) => s.enabled)
      if (skills.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '当前没有可用的技能（未安装，或已安装但全部被停用）。如任务需要，可先用 find_skill 搜索再用 install_skill 安装。'
            }
          ],
          details: { file: '', fileCount: 0 }
        }
      }
      const text = [
        `可用技能（${skills.length} 个，读某个技能时再次调用本工具并传入其名称）：`,
        ...skills.map(
          (s, i) => `${i + 1}. ${s.id}：${s.description || '（无描述）'}`
        )
      ].join('\n')
      return { content: [{ type: 'text', text }], details: { file: '', fileCount: skills.length } }
    }

    const file = (p.file ?? 'SKILL.md').trim()
    log.info('读取技能', { skill: p.skill, file })
    try {
      // 解析目标技能：优先按 id（目录名）精确匹配；否则按技能名匹配——
      // 技能的 id 与 name 可能不一致（如 id=agent-browser-cli、name=agent-browser），
      // Agent 有时会拿 name 当参数，按 name 兜底可避免「未安装」误报。
      const entries = listInstalledSkills()
      const entry = entries.find((s) => s.id === p.skill) ?? entries.find((s) => s.name === p.skill)
      const skillId = entry?.id ?? p.skill
      // 停用技能拒绝读取：显式调用时返回提示而非抛错，让 Agent 理解状态并改用其他技能
      if (entry && !entry.enabled) {
        return {
          content: [
            {
              type: 'text',
              text: `技能「${entry.id}」（${entry.name}）已被停用，无法读取。请在设置中重新启用，或改用其他可用技能。`
            }
          ],
          details: { skill: p.skill, file, fileCount: 0 }
        }
      }
      const files = await listSkillFiles(skillId)
      if (files.length === 0) {
        // 未安装：附上已安装技能 id 清单，帮助 Agent 用正确的 id 重试
        const installed = listInstalledSkills().map((s) => s.id)
        const hint =
          installed.length > 0
            ? `已安装技能 id：${installed.join('、')}`
            : '当前未安装任何技能'
        return {
          content: [
            {
              type: 'text',
              text: `技能「${p.skill}」未安装或目录为空。${hint}。请用正确的技能 id 重试 read_skill，或先用 install_skill 安装。`
            }
          ],
          details: { skill: p.skill, file, fileCount: 0 }
        }
      }
      const isDefault = file === '' || file.toLowerCase() === 'skill.md'
      const target = isDefault ? 'SKILL.md' : file
      // 目标文件不存在：给出一份目录清单，帮助 Agent 找到可用文件
      if (!files.includes(target)) {
        const text = [
          `技能「${p.skill}」目录中没有 ${target}，可用文件（${files.length} 个）：`,
          ...files.map((f, i) => `${i + 1}. ${f}`)
        ].join('\n')
        return {
          content: [{ type: 'text', text }],
          details: { skill: p.skill, file, fileCount: files.length }
        }
      }
      const content = await readSkillFile(skillId, target)
      return {
        content: [{ type: 'text', text: `技能「${p.skill}」文件 ${target}：\n\n${content}` }],
        details: { skill: p.skill, file: target, fileCount: files.length }
      }
    } catch (err) {
      log.error('读取技能失败', {
        skill: p.skill,
        file,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  }
}
