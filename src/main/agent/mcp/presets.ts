import type { BuiltinMcpPreset } from './types'
import { db } from '../../database'
import { createLogger } from '../../utils/log'

const log = createLogger('mcp')

/**
 * 内置 MCP 预设（随包出厂，代码维护）。seedBuiltinMcpServers 把每个预设播种为一条
 * **默认关闭（enabled=false）** 的正式 server 配置（builtin=1），用户直接编辑参数、
 * 启停，无需再经过「预设目录 + 弹窗预填添加」流程；列表用「内置」标签区分来源。
 *
 * 播种规则：
 * - 内置行使用稳定 id（builtin-{preset.id}），每预设至多一条，天然避免重复添加；
 * - 播种幂等「缺行即补」：内置配置不允许删除（UI/IPC 均已拦截），若因异常或旧版本
 *   导致行缺失，下次启动会自动补回；新版本新增的预设也会自动补种；
 * - 预设定义变更不覆盖既有行（保留用户对参数的改动，与内置技能行为一致）。
 */

/** 常见发行版上已装的系统浏览器通道（Playwright channel）：Windows 必有 Edge，macOS/Linux 通常有 Chrome。 */
function systemChromeChannel(): 'chrome' | 'msedge' {
  return process.platform === 'win32' ? 'msedge' : 'chrome'
}

/**
 * Playwright MCP：浏览器自动化（导航/点击/填表/截图/断言）。
 * 关键点：--browser 用系统已装 Chrome/Edge（channel），只下载 JS 包、不下载浏览器二进制；
 * --headless 后台运行、--isolated 不落盘会话。可在弹窗中按需调整。
 */
function playwrightPreset(): BuiltinMcpPreset {
  const browser = systemChromeChannel()
  return {
    id: 'playwright',
    name: 'Playwright（浏览器自动化）',
    description:
      '微软官方 MCP：让 Agent 真实操作网页（打开页面、点击、填写表单、截图、跑断言）。可胜任网页测试、抓取与「帮我操作某个网页」类任务。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--browser', browser, '--headless', '--isolated'],
    env: {},
    url: '',
    note:
      `需要本机 Node.js（npx 随 Node 提供）。首次连接会联网拉取 @playwright/mcp 包（约几 MB），` +
      `但自动复用本机已装的${browser === 'msedge' ? ' Edge' : ' Chrome'}，无需下载浏览器。` +
      `已按无头（--headless）后台运行；如需可见窗口可去掉该参数，或用 --browser 切换 msedge/chrome。`
  }
}

/**
 * zavora-ai/computer-use-mcp：跨平台桌面 GUI 操控（截屏/鼠标/键盘/窗口/无障碍/进程）。
 * 原生（Rust N-API）后端随 npm 包按平台分发，macOS/Windows/Linux（含 arm64/x64）通吃，
 * 与 Playwright（网页）互补，用于直接操作本机桌面应用；stdio 即跑，无需额外系统依赖。
 */
function computerUsePreset(): BuiltinMcpPreset {
  return {
    id: 'computer-use',
    name: '电脑操控（桌面 GUI）',
    description:
      '跨平台（macOS/Windows/Linux）桌面自动化 MCP：截屏、鼠标移动/点击/拖拽、键盘输入与组合键、窗口与应用管理、无障碍元素定位、进程与剪贴板等。让 Agent 像人一样操作本机桌面应用。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@zavora-ai/computer-use-mcp@latest'],
    env: {},
    url: '',
    note:
      '需要本机 Node.js ≥ 20（npx 随 Node 提供）。npm 包内置本平台（mac/win/linux × arm/x64）原生二进制，首次连接联网拉取。' +
      '权限：macOS 需在「系统设置→隐私与安全性」给宿主 App 授予屏幕录制与辅助功能（run_script 操控其他 App 时可能还需「自动化」）；' +
      'Windows 需与被控应用同级运行（UI Automation/SendInput）；Linux 截屏/输入依赖 X11/Wayland 环境与已装后端，失败时可运行其内置 doctor 命令获取修复建议。' +
      '坐标/截图类操作依赖模型的视觉理解能力，建议搭配支持图像的模型使用。'
  }
}

/**
 * Context7：实时拉取主流库的最新文档（防模型用过期 API 知识）。
 * 可匿名使用（限额较低），注册后填 CONTEXT7_API_KEY 可提升限额。
 */
function context7Preset(): BuiltinMcpPreset {
  return {
    id: 'context7',
    name: 'Context7（最新库文档）',
    description:
      '实时检索 6000+ 主流库（React/Next.js/Vue/Prisma 等）的最新官方文档，把版本匹配的 API 与代码示例注入上下文，减少幻觉与过期知识。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    env: {},
    url: '',
    note:
      '需要 Node.js ≥ 20（npx 随 Node 提供）。可匿名使用（速率限额较低）；建议到 context7.com/dashboard 免费注册后，' +
      '在弹窗「环境变量」填入 CONTEXT7_API_KEY=你的Key 以提升限额。'
  }
}

/** GitHub 官方 server：issues/PR/代码搜索与评审。官方本地发行版走 Docker 容器。 */
function githubPreset(): BuiltinMcpPreset {
  return {
    id: 'github',
    name: 'GitHub（官方）',
    description:
      'GitHub 官方 MCP：读取 issues/PR/CI、搜索代码、创建评审等。适合代码协作与开源项目工作流。',
    transport: 'stdio',
    command: 'docker',
    args: [
      'run',
      '-i',
      '--rm',
      '-e',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'ghcr.io/github/github-mcp-server'
    ],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    url: '',
    note:
      '官方本地版依赖 Docker（启动前请先安装并运行 Docker）。Token 在 GitHub Settings → Developer settings → ' +
      'Personal access tokens 生成（推荐 fine-grained：issues/PR/contents 读权限即可）。' +
      '若不便使用 Docker，可改用官方远程端点（https://api.githubcopilot.com/mcp，HTTP 方式）。'
  }
}

/** 内置预设全量列表（播种顺序即服务器列表展示顺序）。 */
export function getBuiltinMcpPresets(): BuiltinMcpPreset[] {
  return [playwrightPreset(), computerUsePreset(), context7Preset(), githubPreset()]
}

/** 内置行稳定 id 前缀：id = builtin-{preset.id}（每预设至多一条，升级不重插）。 */
const BUILTIN_ID_PREFIX = 'builtin-'

/**
 * 启动补种内置 MCP 配置（应用启动、连接已启用 server 前调用，幂等）。
 * 逐个检查内置预设对应的行是否存在，缺失即补（默认关闭）；已存在的行（含用户改过的参数）
 * 不做任何改动。
 */
export function seedBuiltinMcpServers(): void {
  for (const p of getBuiltinMcpPresets()) {
    const id = `${BUILTIN_ID_PREFIX}${p.id}`
    if (db.getMcpServer(id)) continue
    db.createMcpServer({
      id,
      name: p.name,
      transport: p.transport,
      command: p.command,
      args: p.args,
      env: p.env,
      url: p.url,
      enabled: false,
      builtin: true
    })
    log.info('补种内置 MCP 服务器（默认关闭）', { presetId: p.id, id })
  }
}
