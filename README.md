# 桌面助手

本地优先的 AI 对话助手桌面应用，基于 Electron + Vue 3 + TypeScript 构建。

支持多家模型服务商与自定义 OpenAI / Anthropic 兼容端点，内置文件读写、命令执行、网页搜索、技能市场、MCP 扩展等工具能力；会话数据与 API Key 均保存在本机，不依赖云端账号。

## 功能特性

**对话**
- 流式 Markdown 渲染（代码高亮、代码块复制、ECharts 图表块）
- 思考过程展示、工具调用卡片（参数 / 结果 / 状态实时更新）
- 中止 / 重试 / 重新生成 / 编辑回填、临时空对话（首条消息才落库）
- 图片 / 文件 / 截图 / 文档（PDF、Word、Excel 等自动解析）输入
- 会话侧栏：搜索（标题 + 全文）、置顶 / 归档 / 日期分组、重命名、导出 Markdown / JSON
- 会话压缩（LLM 摘要 + 乐观锁，压缩点可视化分界）、自动压缩、每会话独立模型与思考级别

**模型**
- 预置 11 家服务商目录（DeepSeek / OpenAI / Anthropic / Groq 等）+ 自定义兼容端点
- 上下文窗口 / 输出上限 / 多模态 / 推理能力字段、在线拉取服务商模型列表、连通性测试
- API Key 经系统安全存储（safeStorage）加密，明文永不进入渲染进程
- 用量统计（token / 成本，7 天 / 30 天 / 全部，按天趋势与模型分布）

**工具与扩展**
- 内置工具：read_file / list_files / write_file / edit_file / bash / web_search（Tavily）
- 危险工具（write_file / edit_file / bash）执行前权限确认，支持「本次会话 / 总是允许」白名单
- MCP（Model Context Protocol）：stdio + streamable HTTP 双传输，配置变更自动重连
- 技能市场：字节 Find Skill / 腾讯 SkillHub 搜索与安装本地技能
- 长期记忆：跨会话保留用户偏好与事实（总量上限 20 条 / 3000 字），会话创建时随系统提示词全量注入、会话内固定以命中前缀缓存
- bash 持久白名单、工具级启用开关

**桌面**
- 自定义标题栏（BaseWindow + 双 WebContentsView，弹窗不遮挡标题栏）、托盘、应用菜单
- 深浅色 + 跟随系统主题、窗口置顶、开机自启、关闭到托盘
- 本地文件日志（electron-log）+ 崩溃收集（crashReporter），设置页可查看 / 清空

## 技术栈

| 依赖 | 作用 |
|---|---|
| Electron 43 + electron-vite | 跨平台桌面壳与构建 |
| Vue 3 + Pinia + Vue Router | 渲染进程框架 |
| Naive UI | 组件库（深浅双主题） |
| `@earendil-works/pi-ai` / `pi-agent-core` | 模型抽象与 Agent 编排 |
| `node:sqlite`（Node 内置） | 本地 SQLite 数据库（WAL 模式） |
| `electron-ipc-service` | 类型安全双向 IPC |
| `@modelcontextprotocol/sdk` | MCP 客户端（stdio / HTTP） |
| `markstream-vue` | 流式 Markdown 渲染与代码高亮 |
| `echarts` | 用量统计图表 |

## 项目结构

```
src/
├── main/                        # 主进程
│   ├── index.ts                 # 入口（窗口 / 托盘 / 菜单 / 崩溃收集）
│   ├── agent/                   # Agent 子系统
│   │   ├── agent-manager.ts     # 每会话 Agent 实例（LRU 8）生命周期管理
│   │   ├── agent-service.ts     # 对话控制 / 压缩 / 事件桥接 IPC
│   │   ├── model-config/        # 模型配置（加密 / 预置目录 / 注册 / 定价 / 测试）
│   │   ├── mcp/                 # MCP 客户端与配置管理
│   │   ├── skills-store.ts      # 技能存储与安装
│   │   ├── tools/               # 内置工具实现
│   │   └── attachment.ts        # 附件（图片落盘 / file 引用）
│   ├── database/                # SQLite（schema / sessions / messages / memory / usage / mcp / fts）
│   └── service/                 # IPC 服务（app / db / window）+ 窗口 / 托盘 / 菜单
├── preload/                     # Preload（IPC 桥）
└── renderer/
    ├── src/                     # Vue 应用（views / components / store / service）
    └── header/                  # 自定义标题栏（独立 WebContentsView，纯 TS）
```

详细架构说明见 [docs/backend.md](docs/backend.md)（主进程）与 [docs/frontend.md](docs/frontend.md)（渲染进程）。

## 开发

要求 Node.js >= 22（使用内置 `node:sqlite`）与 pnpm。

```bash
# 安装依赖（postinstall 自动修正开发态 macOS 应用名并安装 Electron 原生依赖）
pnpm install

# 启动开发模式（热更新）
pnpm dev
```

### 常用脚本

| 脚本 | 说明 |
|---|---|
| `pnpm dev` | 开发模式 |
| `pnpm typecheck` | TypeScript 类型检查（主进程 + 渲染进程） |
| `pnpm lint` | ESLint 检查 |
| `pnpm format` | Prettier 格式化 |
| `pnpm build` | 类型检查 + 构建产物到 `out/` |
| `pnpm build:win` / `build:mac` / `build:linux` | 打包对应平台安装包 |

### 构建

```bash
# Windows（NSIS 安装包）
pnpm build:win

# macOS（dmg）
pnpm build:mac

# Linux（AppImage + deb）
pnpm build:linux
```

打包配置见 [electron-builder.yml](electron-builder.yml)（productName「桌面助手」、appId `com.desktop-agent.app`）。

## 数据与隐私

- 会话 / 消息 / 模型配置 / 用量等存储于 `userData/data.db`（SQLite，WAL 模式）
- API Key 经 Electron `safeStorage` 加密后落库（macOS 钥匙串 / Windows DPAPI / Linux keyring）
- 图片附件落盘 `userData/attachments/{sessionId}/`，数据库仅存 `file:` 引用
- 日志与崩溃转储位于 `userData/logs/` 与 `userData/Crashpad/`，均不上报，可在设置页查看 / 清空
