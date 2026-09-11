import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  SandboxManager,
  checkWindowsSandboxStatusAsync,
  installWindowsSandboxAsync,
  resolveSrtWin,
  verifyWindowsWfpEgress,
  type SandboxRuntimeConfig
} from '@anthropic-ai/sandbox-runtime'
import { db } from '../database'
import { createLogger } from '../utils/log'
import { resolveSessionWorkdir } from './workdir'
import type { BashSandboxWrapper } from './bash-session'
import {
  DEFAULT_SANDBOX_ENABLED,
  SANDBOX_DEFAULT_NETWORK_ALLOWLIST,
  SETTING_SANDBOX_DENY_READ_ROOTS,
  SETTING_SANDBOX_ENABLED,
  SETTING_SANDBOX_NETWORK_ALLOWLIST,
  SETTING_SANDBOX_WRITABLE_ROOTS
} from './types'

const log = createLogger('sandbox')

/**
 * bash 沙箱集成（Anthropic sandbox-runtime 封装）。
 *
 * 策略对应 docs/bash-sandbox-research.md 5.5/5.6：
 * - 文件系统：默认全局可读（denyRead 做减法）；允许写 = 各平台系统临时目录（自动）
 *   + 命令所在工作区目录 + 用户追加的 writableRoots
 * - 网络：走 srt 域名白名单代理（默认内置常用站点，见 SANDBOX_DEFAULT_NETWORK_ALLOWLIST，
 *   用户可在设置页增删）；本地回环绑定放行（开发服务器可被访问）
 * - 会话级工作区是动态的：每次包装时以「该次 spawn 的 cwd」作为可写根，工作区切换后
 *   新启动的 shell 自动跟随
 * - fail-closed：沙箱开启但初始化/包装失败 → 抛错拒绝执行，绝不静默裸跑
 *
 * 生效边界：沙箱在「spawn 时刻」一次性施加于整个 shell 进程（含其后所有命令与子进程），
 * 已在运行的会话不追溯，重启会话（或改配置后新开会话）后生效。
 */

export interface SandboxSettings {
  enabled: boolean
  /** 用户追加的可写根（绝对路径；工作区目录自动包含，无需登记）。 */
  writableRoots: string[]
  /** 禁止读取的目录（绝对路径；默认全局可读，此处做减法）。 */
  denyReadRoots: string[]
  /** 网络域名白名单（空数组 = 全部拒网）。 */
  networkAllowlist: string[]
}

/** 读取当前沙箱配置（settings 表，无记录时用默认值）。 */
export function readSandboxSettings(): SandboxSettings {
  return {
    enabled: db.getSetting<boolean>(SETTING_SANDBOX_ENABLED) ?? DEFAULT_SANDBOX_ENABLED,
    writableRoots: db.getSetting<string[]>(SETTING_SANDBOX_WRITABLE_ROOTS) ?? [],
    denyReadRoots: db.getSetting<string[]>(SETTING_SANDBOX_DENY_READ_ROOTS) ?? [],
    networkAllowlist:
      db.getSetting<string[]>(SETTING_SANDBOX_NETWORK_ALLOWLIST) ??
      SANDBOX_DEFAULT_NETWORK_ALLOWLIST
  }
}

/** 设置读取器（createSandboxWrapper 的依赖注入点：默认读库，测试可注入替身）。 */
export type SandboxSettingsReader = () => SandboxSettings | Promise<SandboxSettings>

// ==================== 文件域策略（文件工具与 bash 沙箱共用同一可写/禁读边界） ====================

/** 会话文件策略：沙箱开启时返回边界，关闭返回 null（工具保持原行为）。 */
export interface SandboxFsPolicy {
  /** 允许写根：会话工作区 + 用户可写目录 + 平台临时目录。 */
  allowWriteRoots: string[]
  /** 禁止读取的目录（denyReadRoots）。 */
  denyReadRoots: string[]
}

/** 路径是否位于某个根之下（含根本身）。词法比较 + resolve 归一，规避 .. 逃逸。 */
export function isPathWithin(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  if (t === r) return true
  const rel = relative(r, t)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** target 命中 roots 任一即 true。 */
export function isPathWithinAny(target: string, roots: string[]): boolean {
  return roots.some((r) => isPathWithin(target, r))
}

/** 沙箱语义下路径是否允许写入：命中可写根且不在禁读根内。false 即执行层（及 OS 沙箱）会拒绝。 */
export function isSandboxWriteAllowed(policy: SandboxFsPolicy, path: string): boolean {
  return isPathWithinAny(path, policy.allowWriteRoots) && !isPathWithinAny(path, policy.denyReadRoots)
}

/** 沙箱拒绝写入时给 Agent/用户的统一引导文案（审批预检与执行层共用同一口径）。 */
export function sandboxWriteDeniedMessage(path: string): string {
  return `沙箱已开启：写入路径「${path}」不在可写范围内（工作区 / 可写目录 / 系统临时目录）。如需写入，请到「设置 → 沙箱 → 可写目录」添加后重试，或临时关闭沙箱。`
}

/**
 * 当前会话的文件域策略（沙箱开启才返回非 null）。
 * 语义与 bash 沙箱一致：可写 = 工作区（会话动态）+ 用户可写目录 + 系统临时目录；
 * 禁读 = 用户 denyReadRoots。
 */
export async function getSessionFsPolicy(sessionId: string): Promise<SandboxFsPolicy | null> {
  const settings = await readSandboxSettings()
  if (!settings.enabled) return null
  const workdir = resolveSessionWorkdir(sessionId)
  return {
    allowWriteRoots: uniquePaths([
      ...platformTempPaths(),
      ...(workdir ? [workdir] : []),
      ...settings.writableRoots
    ]),
    denyReadRoots: uniquePaths(settings.denyReadRoots)
  }
}

/**
 * 会话「可写边界」（write/edit 审批自动放行判定用）。
 * 语义与沙箱共用同一可写根（工作区 + 用户可写目录 + 系统临时目录），
 * 但**与沙箱开关无关**：关闭沙箱时审批仍以同一边界把「工作区内写入」自动放行，
 * 避免文件操作每次都弹确认（对齐主流 Coding Agent）。
 */
export async function getSessionWriteBoundary(sessionId: string): Promise<{
  allowWriteRoots: string[]
  denyReadRoots: string[]
}> {
  const settings = await readSandboxSettings()
  const workdir = resolveSessionWorkdir(sessionId)
  return {
    allowWriteRoots: uniquePaths([
      ...platformTempPaths(),
      ...(workdir ? [workdir] : []),
      ...settings.writableRoots
    ]),
    denyReadRoots: uniquePaths(settings.denyReadRoots)
  }
}

/** 平台沙箱可用性状态（设置页「平台状态」卡片展示用）。 */
export interface SandboxPlatformStatus {
  /** 当前系统平台。 */
  platform: 'darwin' | 'linux' | 'win32' | 'other'
  /** 本平台沙箱后端。 */
  backend: 'seatbelt' | 'bubblewrap' | 'appcontainer' | 'unsupported'
  /** 后端是否就绪（macOS 恒 true；Linux 需 bwrap；Windows 需供给完成）。 */
  usable: boolean
  /** 缺失的外部依赖（如 Linux 缺 bubblewrap），用于引导安装。 */
  missingDeps: string[]
  /** 沙箱开关当前是否开启。 */
  enabled: boolean
  /** Windows 专用：供给状态。 */
  windows?: { provisioned: boolean; error?: string }
}

/** 平台状态探测（无需初始化 srt，纯探测 + 可选系统调用）。 */
export async function getSandboxPlatformStatus(): Promise<SandboxPlatformStatus> {
  const settings = await readSandboxSettings()
  const base = { enabled: settings.enabled }
  if (process.platform === 'darwin') {
    return {
      ...base,
      platform: 'darwin',
      backend: 'seatbelt',
      usable: true,
      missingDeps: []
    }
  }
  if (process.platform === 'linux') {
    const has = spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0
    return {
      ...base,
      platform: 'linux',
      backend: 'bubblewrap',
      usable: has,
      missingDeps: has ? [] : ['bubblewrap']
    }
  }
  if (process.platform === 'win32') {
    let provisioned = false
    let error: string | undefined
    try {
      const st = await checkWindowsSandboxStatusAsync({ srtWin: getSrtWinSpawn() })
      // 供给完成 = srt-sandbox 账户存在 + WFP 出站栅栏生效。
      // WFP 枚举受管理员门控：非提权时 wfp.state 为 cannot-read，需用 verifyWindowsWfpEgress 行为验证。
      const user = st?.user
      const wfp = st?.wfp
      if (user?.provisioned && wfp?.state === 'installed') {
        provisioned = true
      } else if (user?.provisioned && wfp?.state === 'cannot-read') {
        // 非提权无法枚举 BFE，退而做行为验证（spawn srt-win runner 测试出站是否被 WFP 拦截）
        try {
          await verifyWindowsWfpEgress({ srtWin: getSrtWinSpawn() })
          provisioned = true
        } catch {
          provisioned = false
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    return {
      ...base,
      platform: 'win32',
      backend: 'appcontainer',
      usable: provisioned,
      missingDeps: provisioned ? [] : ['srt-sandbox 供给'],
      windows: { provisioned, error }
    }
  }
  return { ...base, platform: 'other', backend: 'unsupported', usable: false, missingDeps: [] }
}

/** 触发 Windows 沙箱供给（创建 srt-sandbox 账户 + 安装 WFP 规则，弹一次 UAC）。 */
export async function provisionWindowsSandbox(): Promise<{
  ok: boolean
  message?: string
  error?: string
}> {
  if (process.platform !== 'win32') {
    return { ok: false, error: '仅 Windows 需要沙箱供给' }
  }
  try {
    const result = await installWindowsSandboxAsync({ srtWin: getSrtWinSpawn() })
    return {
      ok: true,
      message: typeof result === 'string' ? result : JSON.stringify(result)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('Windows 沙箱供给失败', { error: msg })
    return { ok: false, error: msg }
  }
}

/** 去重且丢弃空项（路径列表用）。 */
function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.trim()).filter((p) => p.length > 0))]
}

/**
 * 各平台标准临时目录（默认可写，命令写临时文件不再被拦）：
 * - os.tmpdir()：macOS=/var/folders/…/T（TMPDIR）、Linux=/tmp、Windows=%TEMP%
 * - 同时收录显式的 TMPDIR/TMP/TEMP 与 POSIX 别名 /tmp（/private/tmp 等由内核同一 realpath 覆盖）
 */
function platformTempPaths(): string[] {
  const envTemps = [process.env.TMPDIR, process.env.TMP, process.env.TEMP].filter(
    (p): p is string => !!p
  )
  const paths = [tmpdir(), ...envTemps]
  if (process.platform !== 'win32') paths.push('/tmp')
  return uniquePaths(paths)
}

let managerInitialized = false
let activeAllowlistKey: string | null = null
let initPromise: Promise<void> | null = null

/**
 * Windows srt-win.exe 定位（dev/pro 统一入口；srt 库对 srt-win 无隐式查找，
 * resolveSrtWin 缺 path 会直接抛错，必须由调用方显式传入）：
 * 1. 打包环境：electron-builder extraResources → resources/srt-win/{arch}/srt-win.exe；
 * 2. dev/preview（非打包）：sandbox-runtime 依赖自带 vendored 二进制
 *    node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/{arch}/srt-win.exe。
 */
function resolveSrtWinExe(): string | undefined {
  const packaged = packagedSrtWinPath()
  if (packaged) return packaged
  // 打包后不再回退 node_modules：asar 内同名文件 existsSync 为 true 但无法被 spawn，
  // electron-builder 已用 extraResources 把 helper 外置到 resources。
  if (app.isPackaged) return undefined
  const arch = helperArch()
  if (!arch) return undefined
  const p = join(devVendorHelpersRoot(), 'srt-win', arch, 'srt-win.exe')
  return existsSync(p) ? p : undefined
}

/** 打包环境下 Windows 的 srt-win.exe 路径（resources/srt-win/{x64|arm64}/srt-win.exe）。 */
function packagedSrtWinPath(): string | undefined {
  if (process.platform !== 'win32' || !process.resourcesPath) return undefined
  const p = join(process.resourcesPath, 'srt-win', process.arch, 'srt-win.exe')
  return existsSync(p) ? p : undefined
}

/**
 * Linux apply-seccomp 定位（dev/pro 统一入口）：
 * 1. 打包环境：resources/seccomp/{x64|arm64}/apply-seccomp；
 * 2. dev/preview：sandbox-runtime 依赖自带 vendored 二进制，与打包资源同源同构。
 * 注：srt 库虽内置多路径兜底，但主进程 bundle 后其 import.meta 指向 out/main，兜底
 * 失效（打包侧已外置 resources）；统一显式下发可避免 dev/pro 行为漂移
 * （缺 apply-seccomp 仅降级不限 unix socket，不报错）。
 */
function resolveSeccompApplyPath(): string | undefined {
  const packaged = packagedSeccompPath()
  if (packaged) return packaged
  if (app.isPackaged) return undefined
  const arch = helperArch()
  if (!arch) return undefined
  const p = join(devVendorHelpersRoot(), 'seccomp', arch, 'apply-seccomp')
  return existsSync(p) ? p : undefined
}

/** 打包环境下 Linux 的 apply-seccomp（resources/seccomp/{x64|arm64}/apply-seccomp）。 */
function packagedSeccompPath(): string | undefined {
  if (process.platform !== 'linux' || !process.resourcesPath) return undefined
  const arch = helperArch()
  if (!arch) return undefined
  const p = join(process.resourcesPath, 'seccomp', arch, 'apply-seccomp')
  return existsSync(p) ? p : undefined
}

/** vendored helper 仅提供 x64/arm64 双架构目录。 */
function helperArch(): string | undefined {
  return process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
}

/** dev/preview 主进程产物在 <项目根>/out/main（electron-vite 默认），向上两级取项目根 node_modules。 */
function devVendorHelpersRoot(): string {
  return join(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'vendor')
}

/** 组装 srt 运行期配置：文件系统默认最严（allowWrite 空），可写根在每次 wrap 以 custom 下发；
 *  网络 allowlist 为「宿主侧共享代理」的全局态，改动需 updateConfig（见 5.6 发现 2）。 */
function buildRuntimeConfig(settings: SandboxSettings): SandboxRuntimeConfig {
  const config: SandboxRuntimeConfig = {
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
    network: {
      allowedDomains: settings.networkAllowlist,
      deniedDomains: [],
      // 放行本地回环绑定：agent 起的开发服务器（如 vite dev）需要被用户/浏览器访问
      allowLocalBinding: true
    }
  }
  const srtWin = resolveSrtWinExe()
  if (srtWin) {
    config.windows = { srtWin: { path: srtWin } }
  }
  const seccomp = resolveSeccompApplyPath()
  if (seccomp) {
    config.seccomp = { applyPath: seccomp }
  }
  return config
}

/**
 * 获取 srt-win spawn 配置（dev/pro 统一按 resolveSrtWinExe 定位；两处均缺失时返回
 * undefined，由调用方把「未配置/缺失」透出给用户）。
 * 供 status/install 等无需 SandboxManager 的入口使用。
 */
function getSrtWinSpawn(): { exe: string; prependArgs: readonly string[] } | undefined {
  const p = resolveSrtWinExe()
  return p ? resolveSrtWin({ path: p }) : undefined
}

/** 幂等初始化 srt（含按需 updateConfig 同步网络白名单）；初始化失败抛错（fail-closed）。 */
async function ensureSandboxManager(settings: SandboxSettings): Promise<void> {
  const allowlistKey = JSON.stringify(settings.networkAllowlist)
  if (!managerInitialized) {
    if (!SandboxManager.isSupportedPlatform()) {
      throw new Error(
        '当前平台不支持沙箱（macOS/Linux 需要系统沙箱能力，Windows 需先完成沙箱安装）'
      )
    }
    if (initPromise) {
      await initPromise
      return
    }
    initPromise = (async () => {
      try {
        await SandboxManager.initialize(buildRuntimeConfig(settings))
        managerInitialized = true
        activeAllowlistKey = allowlistKey
        log.info('沙箱已初始化', { allowlistCount: settings.networkAllowlist.length })
      } finally {
        initPromise = null
      }
    })()
    await initPromise
    return
  }
  if (allowlistKey !== activeAllowlistKey) {
    SandboxManager.updateConfig(buildRuntimeConfig(settings))
    activeAllowlistKey = allowlistKey
    log.info('沙箱网络白名单已更新', { allowlistCount: settings.networkAllowlist.length })
  }
}

/**
 * 构造注册给 bash-session 的沙箱包装器：enabled=false 返回 null（原样 spawn）；
 * enabled=true 时以 OS 沙箱包装进程并返回替换用 argv/env。
 * reader 为设置读取器（默认读库；测试可注入替身）。
 */
export function createSandboxWrapper(
  reader: SandboxSettingsReader = readSandboxSettings
): BashSandboxWrapper {
  return async (req) => {
    const settings = await reader()
    if (!settings.enabled) return null
    await ensureSandboxManager(settings)
    // 默认可写：各平台系统临时目录 + 命令所在工作区（动态）+ 用户追加目录
    const allowWrite = uniquePaths([
      ...platformTempPaths(),
      ...(req.cwd ? [req.cwd] : []),
      ...settings.writableRoots
    ])
    if (allowWrite.length === 0) {
      throw new Error('沙箱开启但无可写目录：请在工作区中发起命令，或在设置-沙箱中添加可写目录')
    }
    const command = req.mode === 'persistent' ? [req.command, ...req.args].join(' ') : req.command
    try {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        undefined,
        {
          filesystem: { allowWrite, denyWrite: [], denyRead: settings.denyReadRoots }
        },
        undefined,
        req.cwd
      )
      log.info('命令已套入沙箱', {
        mode: req.mode,
        cwd: req.cwd,
        allowWrite,
        denyRead: settings.denyReadRoots
      })
      // wrapWithSandboxArgv 返回的 env 即宿主环境；子进程需继承调用方组装好的 env
      //（含自动抓取 shell 环境与手动配置变量）。代理经命令前缀 env 注入，无需额外处理。
      return { argv: wrapped.argv, env: req.env }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('沙箱包装失败（fail-closed，拒绝执行）', { mode: req.mode, error: msg })
      throw new Error(`沙箱执行失败：${msg}（如需恢复可到 设置-沙箱 关闭后重试）`)
    }
  }
}
