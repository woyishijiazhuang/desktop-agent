import type { BuiltinMcpPreset } from './types'

/**
 * 内置 MCP 预设目录（随包出厂，代码维护）。
 *
 * 与内置 skill（resources/builtin-skills，启动补种成实体）不同，MCP server 需要外部运行时，
 * 因此预设只作为「模板目录」：默认不占用任何配置、不自动启用；用户在设置页选择预设后，
 * 弹窗按模板预填，确认/补参（如 GitHub Token）再保存为一条正式 server 配置。
 *
 * 预设可通过版本升级平滑增改；用户删除自己添加的副本不影响目录本身。
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

/** 内置预设全量列表（顺序即设置页展示顺序）。 */
export function getBuiltinMcpPresets(): BuiltinMcpPreset[] {
  return [playwrightPreset(), context7Preset(), githubPreset()]
}
