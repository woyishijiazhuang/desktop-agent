import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { installSkill } from '../skills-store'
import { getFindSkillSource } from './find-skill'
import { FIND_SKILL_SOURCE_LABELS, type FindSkillSource } from '../types'
import { createLogger } from '../../utils/log'

const log = createLogger('tool:install_skill')

const params = Type.Object({
  reason: Type.String({
    description:
      '用一句话（不超过 30 字）说明本次安装的目的（例如"用户需要批量处理 PDF，安装 PDF 解析技能"）。请务必填写。'
  }),
  source: Type.Optional(
    Type.Union(
      [
        Type.Literal('byte', { description: '字节 Find Skill' }),
        Type.Literal('tencent', { description: '腾讯 SkillHub' })
      ],
      { description: '技能来源平台；不传时使用设置中当前选中的数据源' }
    )
  ),
  slug: Type.String({
    description:
      '技能标识（find_skill 搜索结果中的 slug，如 volcengine/las/byted-las-pdf-parse-doubao 或 academic-figures）'
  })
})

/**
 * 技能安装工具：把指定技能下载到用户数据目录的 skills 文件夹（{userData}/skills/），
 * 供 Agent 后续通过 read_skill 读取使用（技能信息不注入系统提示，由 Agent 动态发现）。
 * 安装后立即生效，无需驱逐 Agent、不影响正在进行的对话。若技能包含脚本文件则一并安装
 * （腾讯 zip 完整解压，字节仅 SKILL.md 文本）。唯一副作用是写入本地技能目录。
 */
export const installSkillTool: AgentTool<
  typeof params,
  { source: FindSkillSource; slug: string; id: string; fileCount: number }
> = {
  name: 'install_skill',
  label: '技能安装',
  description:
    '将 find_skill 搜索到的技能下载并安装到本地技能目录，之后可用 read_skill 读取使用。需传入来源平台与技能 slug。',
  parameters: params,
  executionMode: 'parallel',
  async execute(_toolCallId, p) {
    const source = (p.source as FindSkillSource | undefined) ?? getFindSkillSource()
    log.info('安装技能', { slug: p.slug, source })
    const entry = await installSkill({ source, slug: p.slug })
    const text = [
      `✅ 技能已安装：${entry.name}（来源：${FIND_SKILL_SOURCE_LABELS[source]}）`,
      `   用途：${entry.description || '（无描述）'}`,
      entry.version ? `   版本：${entry.version}` : '',
      `   文件数：${entry.fileCount}`,
      entry.hasExtraFiles
        ? '   提示：该技能包含 SKILL.md 之外的脚本/资源文件，已随包安装；若需了解文件结构可用 read_skill 查看。'
        : '',
      `   现在可用 read_skill 读取使用（skill 参数传「${entry.id}」；不传参数可查看全部已安装技能清单）。`
    ]
      .filter(Boolean)
      .join('\n')
    return {
      content: [{ type: 'text', text }],
      details: { source, slug: p.slug, id: entry.id, fileCount: entry.fileCount }
    }
  }
}
