import { app, shell } from 'electron'
import { join, relative, extname, dirname, sep } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { createLogger } from '../utils/log'
import type { FindSkillSource, InstalledSkill } from './types'

const log = createLogger('skills')

/** 技能根目录（{userData}/skills/），惰性计算（app ready 后才能访问 userData）。 */
function getSkillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

/** manifest 文件路径（记录全部已安装技能，与目录一一对应）。 */
function getManifestPath(): string {
  return join(getSkillsDir(), 'manifest.json')
}

// ---- 平台端点 ----
/** 字节 Find Skill：技能详情（含完整 SKILL.md 文本）。 */
const BYTE_SKILL_URL = 'https://skills.volces.com/v1/skills'
/** 腾讯 SkillHub：技能 zip 下载（302 重定向到 COS，返回标准技能包）。 */
const TENCENT_DOWNLOAD_URL = 'https://api.skillhub.cn/api/v1/download'

/** 腾讯 zip 包解压上限（平台规范：≤10MB / ≤300 个文件）。 */
const MAX_ZIP_BYTES = 10 * 1024 * 1024
const MAX_ZIP_FILES = 300
/** read_skill 工具单文件读取上限（防止大文件撑爆上下文）。 */
const MAX_READ_BYTES = 512 * 1024

/** manifest 结构（version 保留给未来迁移）。 */
interface Manifest {
  version: number
  skills: InstalledSkill[]
}

// ---- manifest 读写 ----

/** 串行化 manifest 与目录变更（安装/卸载/启停都是低频操作，避免并发读写竞争）。 */
let manifestLock: Promise<void> = Promise.resolve()

function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = manifestLock
  let release!: () => void
  manifestLock = new Promise<void>((r) => (release = r))
  return prev.then(fn).finally(release)
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(getManifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Manifest
    if (parsed && Array.isArray(parsed.skills)) return parsed
  } catch {
    // 文件不存在或损坏：视为空 manifest
  }
  return { version: 1, skills: [] }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(getSkillsDir(), { recursive: true })
  await writeFile(getManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
}

// ---- 公开管理接口（IPC / 工具共用） ----

/** 已安装技能列表（manifest 为准）。 */
export function listInstalledSkills(): InstalledSkill[] {
  // 同步读：createAgent / 工具执行路径不能引入额外 await 负担
  try {
    const raw = readFileSync(getManifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Manifest
    return Array.isArray(parsed.skills) ? parsed.skills : []
  } catch {
    return []
  }
}

/**
 * 安装技能：下载到 {userData}/skills/{id}/ 并写入 manifest。
 * - byte：GET /v1/skills/{slug} → 取 SkillMarkdown（完整 SKILL.md 文本）落盘；
 *   若平台标注含 SKILL.md 之外的文件，仅安装说明文件（hasExtraFiles=true）。
 * - tencent：GET /api/v1/download?slug= → zip 解压（校验 SKILL.md 在根目录、防路径穿越）。
 * 同名技能（同 id）再次安装视为更新覆盖，保留启用状态。
 */
export async function installSkill(input: {
  source: FindSkillSource
  slug: string
}): Promise<InstalledSkill> {
  return withManifestLock(async () => {
    const manifest = await readManifest()
    const dir = getSkillsDir()
    await mkdir(dir, { recursive: true })

    const downloaded =
      input.source === 'byte'
        ? await downloadFromByte(input.slug)
        : await downloadFromTencent(input.slug)

    const id = downloaded.id
    const targetDir = join(dir, id)
    // 覆盖更新：先清空旧目录，避免残留过期文件
    await rm(targetDir, { recursive: true, force: true })
    await mkdir(targetDir, { recursive: true })
    for (const f of downloaded.files) {
      const abs = join(targetDir, f.path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, f.content)
    }
    const fileCount = downloaded.files.length

    const prev = manifest.skills.find((s) => s.id === id)
    const entry: InstalledSkill = {
      id,
      name: downloaded.name,
      description: downloaded.description,
      source: input.source,
      slug: input.slug,
      version: downloaded.version,
      downloads: downloaded.downloads,
      homepage: downloaded.homepage,
      installedAt: prev?.installedAt ?? Date.now(),
      enabled: prev?.enabled ?? true,
      fileCount,
      hasExtraFiles: fileCount > 1
    }
    const idx = manifest.skills.findIndex((s) => s.id === id)
    if (idx >= 0) manifest.skills[idx] = entry
    else manifest.skills.push(entry)
    await writeManifest(manifest)
    log.info('技能安装完成', { id, source: input.source, slug: input.slug, fileCount })
    return entry
  })
}

/** 启停技能：停用后 Agent 无法发现（read_skill 清单）也无法读取，聊天框不可选择。 */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<InstalledSkill> {
  return withManifestLock(async () => {
    const manifest = await readManifest()
    const entry = manifest.skills.find((s) => s.id === id)
    if (!entry) throw new Error(`技能不存在：${id}`)
    entry.enabled = enabled
    await writeManifest(manifest)
    log.info('技能启停已更新', { id, enabled })
    return entry
  })
}

/** 卸载技能：删除技能目录并从 manifest 移除。 */
export async function uninstallSkill(id: string): Promise<void> {
  return withManifestLock(async () => {
    const manifest = await readManifest()
    const idx = manifest.skills.findIndex((s) => s.id === id)
    if (idx < 0) return
    manifest.skills.splice(idx, 1)
    await rm(join(getSkillsDir(), id), { recursive: true, force: true })
    await writeManifest(manifest)
    log.info('技能已卸载', { id })
  })
}

/** 打开技能根目录（系统文件管理器）。 */
export async function openSkillsDir(): Promise<void> {
  const dir = getSkillsDir()
  await mkdir(dir, { recursive: true })
  await shell.openPath(dir)
}

// ---- read_skill 工具支持 ----

/** 技能目录内的文件清单（相对路径），用于向 Agent 暴露技能包结构。 */
export async function listSkillFiles(id: string): Promise<string[]> {
  const root = join(getSkillsDir(), id)
  const result: string[] = []
  await collectFiles(root, root, result)
  return result
}

async function collectFiles(root: string, current: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = join(current, e.name)
    const rel = relative(root, abs).split(sep).join('/')
    if (e.isDirectory()) {
      await collectFiles(root, abs, out)
    } else {
      out.push(rel)
    }
  }
}

/**
 * 读取技能目录内指定文件（白名单：仅限本技能目录，拒绝目录穿越）。
 * 文本文件返回内容；超限/非文本（含 NUL 字节）抛错提示，避免污染模型上下文。
 */
export async function readSkillFile(id: string, relPath: string): Promise<string> {
  const root = join(getSkillsDir(), id)
  const norm = relPath.replace(/\\/g, '/')
  const abs = join(root, norm)
  const rel = relative(root, abs)
  // 拒绝目录穿越（.. 前缀）与访问技能目录本身
  if (rel.startsWith('..') || rel === '') {
    throw new Error('不允许读取技能目录之外的文件')
  }
  const s = await stat(abs)
  if (!s.isFile()) throw new Error(`不是文件：${relPath}`)
  if (s.size > MAX_READ_BYTES) {
    throw new Error(
      `文件过大（${(s.size / 1024).toFixed(0)}KB），仅支持读取 ${MAX_READ_BYTES / 1024}KB 以内`
    )
  }
  const buf = await readFile(abs)
  if (buf.includes(0)) throw new Error(`「${relPath}」是二进制文件，无法直接读取`)
  return buf.toString('utf-8')
}

// ---- 下载实现 ----

/** 安装源解析后的统一文件描述。 */
interface SkillFile {
  path: string
  content: Buffer
}

interface DownloadedSkill {
  id: string
  name: string
  description: string
  version: string
  downloads: number
  homepage?: string
  files: SkillFile[]
}

/** slug → 技能目录名（取末段，规范化文件系统安全字符）。find_skill 结果据此匹配本地已安装技能。 */
export function slugToId(slug: string): string {
  const last = slug.split('/').filter(Boolean).pop() ?? 'skill'
  return last.replace(/[^a-zA-Z0-9._-]/g, '-')
}

/** 解析 SKILL.md 的 YAML frontmatter 中的指定字段。 */
function parseFrontmatter(content: string): {
  name?: string
  version?: string
  description?: string
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const body = m[1]
  const pick = (key: string): string | undefined => {
    const line = body.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
    if (!line || line.index === undefined) return undefined
    let v = line[1].trim()
    // YAML 多行标量（> 折叠 / | 字面量）：把后续缩进行合并为单行
    if (v === '>' || v === '|') {
      const rest = body.slice(line.index + line[0].length).split('\n')
      const lines: string[] = []
      for (const l of rest) {
        const t = l.trim()
        if (!t) continue // 跳过空行
        if (/^\s+/.test(l)) lines.push(t)
        else break
      }
      v = lines.join(' ')
    }
    return v.replace(/^['"]|['"]$/g, '').trim()
  }
  return { name: pick('name'), version: pick('version'), description: pick('description') }
}

/** 字节 Find Skill 响应中的技能对象（只取用到的字段）。 */
interface ByteSkillDetail {
  Skill?: {
    Name?: string
    Description?: string
    Slug?: string
    SkillMarkdown?: string
    DownloadCount?: number
    Metadata?: { DisplayDescription?: string; Files?: string[] }
  }
}

/** 判断字节技能是否含 SKILL.md 之外的可执行/脚本类文件（无法仅凭 SKILL.md 安装）。 */
function byteHasScriptFiles(files: string[] | undefined): boolean {
  const DOC_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.license'])
  return (files ?? []).some((f) => {
    const n = f.toLowerCase().replace(/\\/g, '/')
    if (n === 'skill.md' || n === 'license' || n === 'readme' || n === 'readme.md') return false
    return !DOC_EXTS.has(extname(n))
  })
}

/** 从字节 Find Skill 下载：取 SkillMarkdown 写入 SKILL.md。 */
async function downloadFromByte(slug: string): Promise<DownloadedSkill> {
  const url = `${BYTE_SKILL_URL}/${slug.split('/').map(encodeURIComponent).join('/')}`
  const res = await fetch(url)
  const body = (await res.json().catch(() => null)) as ByteSkillDetail | null
  const skill = body?.Skill
  if (!res.ok || !skill || typeof skill.SkillMarkdown !== 'string' || !skill.SkillMarkdown.trim()) {
    throw new Error(`Find Skill 下载失败：HTTP ${res.status}`)
  }
  const fm = parseFrontmatter(skill.SkillMarkdown)
  const id = slugToId(slug)
  const files: SkillFile[] = [
    { path: 'SKILL.md', content: Buffer.from(skill.SkillMarkdown, 'utf-8') }
  ]
  const hasScripts = byteHasScriptFiles(skill.Metadata?.Files)
  return {
    id,
    name: fm.name || skill.Name || id,
    description: skill.Metadata?.DisplayDescription || fm.description || skill.Description || '',
    version: fm.version ?? '',
    downloads: skill.DownloadCount ?? 0,
    homepage: skill.Slug ? `https://findskill.com/${skill.Slug}` : undefined,
    // 仅安装 SKILL.md；存在脚本文件时标记 hasExtraFiles（调用方据此提示脚本未随包安装）
    files: hasScripts
      ? [
          ...files,
          {
            path: '.notes',
            content: Buffer.from(
              `本技能在字节 Find Skill 上还包含 ${(skill.Metadata?.Files ?? []).filter((f) => !f.toLowerCase().endsWith('.md')).length} 个脚本/资源文件（${(skill.Metadata?.Files ?? []).join('、')}），本次仅安装了 SKILL.md 说明文件，脚本需在技能详情页另行获取。`,
              'utf-8'
            )
          }
        ]
      : files
  }
}

/** 从腾讯 SkillHub 下载：GET /download 拿 zip（fetch 自动跟随 302 到 COS）并安全解压。 */
async function downloadFromTencent(slug: string): Promise<DownloadedSkill> {
  const url = `${TENCENT_DOWNLOAD_URL}?slug=${encodeURIComponent(slug)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SkillHub 下载失败：HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('zip')) {
    const text = (await res.text()).slice(0, 200)
    throw new Error(`SkillHub 下载失败：响应不是 zip（${text}）`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const files = extractZipSafe(buf)
  const skillMd = files.find((f) => f.path === 'SKILL.md')
  if (!skillMd) throw new Error('技能包缺少 SKILL.md（根目录）')
  const fm = parseFrontmatter(skillMd.content.toString('utf-8'))
  // version：优先 SKILL.md frontmatter；缺失时回退 zip 内 _meta.json（平台侧版本号）
  let version = fm.version ?? ''
  const meta = files.find((f) => f.path === '_meta.json')
  if (!version && meta) {
    try {
      const m = JSON.parse(meta.content.toString('utf-8')) as { version?: string | number }
      if (typeof m.version === 'string' || typeof m.version === 'number')
        version = String(m.version)
    } catch {
      // _meta.json 解析失败不影响安装
    }
  }
  return {
    id: slugToId(slug),
    name: fm.name || slugToId(slug),
    description: fm.description || '',
    version,
    downloads: 0,
    homepage: `https://skillhub.cn/skills/${encodeURIComponent(slug)}`,
    files
  }
}

/**
 * 安全解压技能 zip：
 * - 大小 / 文件数上限（平台规范 10MB / 300 文件）
 * - 拒绝路径穿越（..、绝对路径、盘符）与符号链接
 */
function extractZipSafe(buf: Buffer): SkillFile[] {
  if (buf.length > MAX_ZIP_BYTES)
    throw new Error(`技能包超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限`)
  let zip: AdmZip
  try {
    zip = new AdmZip(buf)
  } catch {
    throw new Error('技能包解析失败：不是有效的 zip')
  }
  const files: SkillFile[] = []
  const seen = new Set<string>()
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    // 规范化路径：统一 /、去前导 ./
    const raw = entry.entryName.replace(/\\/g, '/').replace(/^\.\//, '')
    // 拒绝路径穿越（路径段 ..）、绝对路径与盘符
    if (raw.split('/').includes('..') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
      throw new Error(`技能包包含非法路径：${raw}`)
    }
    if (seen.has(raw)) continue
    seen.add(raw)
    files.push({ path: raw, content: entry.getData() })
    if (files.length > MAX_ZIP_FILES) throw new Error(`技能包文件数超过 ${MAX_ZIP_FILES} 上限`)
  }
  if (files.length === 0) throw new Error('技能包为空')
  return files
}
