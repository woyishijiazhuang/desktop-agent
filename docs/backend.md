# 后端架构文档（Electron 主进程 + Preload）

> 本文档描述「桌面助手」桌面 AI 应用的后端：Electron 主进程、preload 层的架构设计、目录结构、每个文件的职责，以及 Agent 子系统、数据库、服务层、构建配置的深入说明。

---

## 目录

1. [概览](#1-概览)
2. [进程架构与双向 IPC](#2-进程架构与双向-ipc)
3. [目录结构总览](#3-目录结构总览)
4. [文件详解](#4-文件详解)
   - 4.1 [主进程入口](#41-主进程入口)
   - 4.2 [数据库层](#42-数据库层)
   - 4.3 [Agent 子系统](#43-agent-子系统)
   - 4.4 [工具集（tools）](#44-工具集tools)
   - 4.5 [服务层（service）](#45-服务层service)
   - 4.6 [工具函数（utils）](#46-工具函数utils)
   - 4.7 [Preload 层](#47-preload-层)
5. [Agent 子系统深入](#5-agent-子系统深入)
6. [数据库子系统](#6-数据库子系统)
7. [服务层一览](#7-服务层一览)
8. [构建与配置](#8-构建与配置)
9. [关键设计速查](#9-关键设计速查)

---

## 1. 概览

本应用是一个基于 **Electron + Vue 3 + TypeScript** 的本地优先 AI 聊天代理（Agent）桌面应用。后端指 Electron 主进程与 preload 层，承担以下职责：

- **窗口管理**：`BaseWindow` + 双 `WebContentsView` 架构（自定义标题栏独立视图），窗口生命周期、托盘、应用菜单。
- **Agent 运行时**：基于 `@earendil-works/pi-agent-core` 的对话编排，每会话独立 Agent 实例（LRU 上限 8），支持流式输出、工具调用、权限拦截、会话压缩、自动压缩。
- **模型抽象**：基于 `@earendil-works/pi-ai` 的多服务商模型管理，预置目录 + 自定义 OpenAI/Anthropic 兼容端点，API Key 经 `safeStorage` 加密存储。
- **本地持久化**：基于 Node 内置 `node:sqlite` 的 SQLite 数据库，存储会话、消息、模型配置、设置、MCP 服务器、长期记忆、用量日志。
- **工具执行**：文件读写、目录列举、Shell 执行、网页搜索、技能市场、长期记忆工具（运行于主进程，拥有完整 Node 能力）。
- **MCP 扩展**：基于 `@modelcontextprotocol/sdk` 的 MCP 客户端，支持 stdio 与 streamable HTTP 两种传输。
- **双向 IPC**：基于 `electron-ipc-service` 的类型安全双向通信。

### 技术选型

| 依赖 | 作用 |
|---|---|
| `@earendil-works/pi-agent-core` | Agent 框架：Agent 类、工具协议、事件订阅、steer/followUp/continue/abort |
| `@earendil-works/pi-ai` | 模型/Provider 抽象：Models 集合、Provider、Model\<Api\>、streamSimple、builtinProviders 预置目录 |
| `@modelcontextprotocol/sdk` | MCP 客户端（StdioClientTransport / StreamableHTTPClientTransport） |
| `electron-ipc-service` | 类型安全的双向 IPC 框架，服务以 `IpcService` 子类 + `namespace` 注册 |
| `node:sqlite`（`DatabaseSync`） | 本地 SQLite（WAL 模式），文件 `userData/data.db` |
| Electron `safeStorage` | API Key / Tavily Key 加密存储 |
| `electron-log` | 主进程文件日志 + 渲染进程 console 捕获 |
| `mdize` | docx/pdf/xlsx/pptx/csv → Markdown 文档解析（惰性加载） |
| `@napi-rs/canvas` | 图标生成脚本（scripts/generate-icons.mjs） |

---

## 2. 进程架构与双向 IPC

采用标准 Electron 三进程模型，窗口采用 **BaseWindow + 双 WebContentsView**：

```
┌──────────────────────────────────────────────────────────────┐
│  主进程 (src/main/index.ts)                                   │
│  - 创建 BaseWindow（headerView 32px + contentView 本体）      │
│  - 注册 IPC 服务 (import './service')                         │
│  - 运行 Agent 实例、读写 DB、执行工具、调模型 API             │
│  - ipcMainServices: App/Db/Window/Agent/Mcp/ModelConfig      │
└───────────────▲─────────────────────────────┬────────────────┘
                │ ipcMain.handle               │ rendererClient
                │ (正向: renderer→main)        │ (反向: main→renderer)
┌───────────────┴─────────────────────────────┴────────────────┐
│  Preload (src/preload/index.ts)                              │
│  - initializeIpcPreload() 建立 IPC 桥                        │
│  - contextBridge 暴露 window.electron                        │
└───────────────▲─────────────────────────────────────────────┘
                │ createIpcRendererClient<IpcMainServices>()
┌───────────────┴─────────────────────────────────────────────┐
│  渲染进程: contentView (src/renderer) + headerView (src/renderer/header)│
│  - mainClient: 调主进程服务 (app.*/db.*/window.*/agent.*/mcp.*/modelConfig.*)│
│  - 反向暴露: UiService(ui.*) / AgentEventService(agentEvent.*)│
└─────────────────────────────────────────────────────────────┘
```

### IPC 框架（electron-ipc-service）

采用**基于服务类的声明式 IPC**。每个服务继承 `IpcService`，声明静态 `namespace`，其 public 方法即暴露给另一进程的 IPC 方法，方法名约定为 `namespace.method`。

**主进程服务注册**（[service/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/index.ts)）：

```ts
export const ipcMainServices = initializeIpcMainServices([
  AppService, DbService, WindowService, AgentService, McpService, ModelConfigService
])
```

**关键接线**：`ipcMainServices.mcp.onConfigChanged(() => agent.evictAllSessions())` —— MCP 配置变更后驱逐全部内存 Agent，下一轮创建时重新拉取 MCP 工具集（在 service 层接线，避免 mcp/service 反向依赖 agent-service 造成循环引用）。

**主进程 → 渲染进程反向调用**（[utils/render-client.ts](file:///Users/hupengfei/Documents/my-app/src/main/utils/render-client.ts)）：electron-ipc-service 的 `createIpcMainClient` 依赖 `BrowserWindow.getAllWindows()`，BaseWindow 迁移后不可用，这里用 Proxy 自建同 API 形状实现，每次调用经 `broadcastToAllViews(...)`（遍历本窗口全部 WebContentsView fire-and-forget）广播。

### 窗口架构（window-manager.ts）

`BaseWindow` + 双 WebContentsView：
- **headerView**：顶部 32px 自定义标题栏独立视图，弹窗永远无法遮盖它。
- **contentView**：应用本体（Vue 应用），弹窗被裁剪在自身边界。
- 替代 BrowserWindow 两处静态依赖：`BrowserWindow.fromWebContents()` → `getWindowByWebContents()`（webContentsId→BaseWindow 注册表）；`createIpcMainClient` → `broadcastToAllViews()`。

### 双向 IPC 设计要点

- **正向（renderer → main）**：渲染进程调用 `mainClient.agent.prompt(sessionId, text, ...)` 等，触发主进程 `AgentService` 对应方法。
- **反向（main → renderer）**：主进程 Agent 产生事件后，经 `rendererClient.agentEvent.onEvent(payload)` / `onPermissionRequest(req)` / `onSessionUpdate(session)` 推送；窗口状态变化经 `rendererClient.ui.windowStateChange(state)`；托盘/菜单动作经 `rendererClient.ui.trayAction(action)`。
- **权限交互回路**：主进程 `onPermissionRequest` 推送确认请求 → 渲染进程弹框 → 渲染进程调 `mainClient.agent.respondPermission(requestId, approved, scope)` → 主进程 `resolvePermission` 解除 pending Promise，形成完整闭环。

---

## 3. 目录结构总览

```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 主进程入口（窗口/托盘/菜单/崩溃收集/附件清理）
│   ├── env.d.ts                   # Vite 类型声明（?asset 模块）
│   ├── agent/                     # Agent 子系统
│   │   ├── agent-manager.ts       # Agent 实例生命周期（LRU 8、两阶段锁、事件桥、标题生成）
│   │   ├── agent-service.ts       # AgentService IPC（对话控制/压缩/文档解析/技能/白名单）
│   │   ├── model-config-service.ts# ModelConfigService IPC（模型配置 CRUD/预置目录/测试）
│   │   ├── model-config.ts        # model-config/ 门面（保持旧 import 路径）
│   │   ├── model-config/          # 加解密/脱敏/预置目录/定价/注册/测试
│   │   ├── mcp/                   # MCP 客户端（client/index/service/schema/utils/test/types）
│   │   ├── skills-store.ts        # 技能存储与安装（manifest + 目录管理）
│   │   ├── attachment.ts          # 附件存储（图片落盘/file 引用/孤儿清理）
│   │   ├── convert.ts             # AgentMessage ↔ DB 行互转 + 图片落盘还原
│   │   ├── models.ts              # 运行时 Models 集合单例 + completeText
│   │   ├── permission.ts          # 危险工具权限钩子 + bash 白名单
│   │   ├── types.ts               # 共享类型 + 系统提示构建 + SETTING_* 常量
│   │   └── tools/                 # 内置工具实现（10 个文件）
│   ├── database/                  # SQLite 数据层
│   │   ├── index.ts               # 单例门面 db（按域组装 + 启动清理）
│   │   ├── schema.ts              # 建表/索引/轻量列清理
│   │   ├── sessions.ts            # 会话 CRUD（软删除/回收站/分支/压缩指针）
│   │   ├── messages.ts            # 消息 CRUD + FTS 同步 + 全文搜索
│   │   ├── model-configs.ts       # 模型配置 CRUD（脱敏列表/独立密文列）
│   │   ├── settings.ts            # 设置项（写入白名单校验）
│   │   ├── mcp-servers.ts         # MCP 服务器配置 CRUD
│   │   ├── memory.ts              # 长期记忆 CRUD + 检索注入 + FTS
│   │   ├── usage.ts               # 用量日志 + 统计聚合
│   │   ├── fts.ts                 # 2-gram 分词/索引/查询/摘要片段
│   │   ├── utils.ts               # 事务包装 + 行→对象映射
│   │   └── types/                 # 各域类型定义
│   ├── service/                   # IPC 服务层与窗口管理
│   │   ├── index.ts               # 注册全部主进程 IPC 服务
│   │   ├── app-service.ts         # 应用级服务（版本/外链/开机自启/诊断）
│   │   ├── db-service.ts          # 数据库 CRUD IPC 薄封装
│   │   ├── window-service.ts      # 窗口控制服务（含置顶/标题栏模式）
│   │   ├── window-manager.ts      # BaseWindow + 双视图管理
│   │   ├── tray-service.ts        # 系统托盘
│   │   └── app-menu-service.ts    # 应用菜单 + Dock 右键菜单
│   └── utils/
│       ├── log.ts                 # electron-log 文件日志（createLogger）
│       ├── render-client.ts       # 主进程 → 渲染进程 IPC 客户端（Proxy 广播）
│       ├── message-text.ts        # 消息文本提取
│       └── doc-parser.ts          # 文档解析（mdize 惰性加载）
├── preload/
│   ├── index.ts                   # IPC 桥 + contextBridge
│   └── globals.d.ts               # Window.electron 全局类型
└── ... (renderer 见前端文档)
```

---

## 4. 文件详解

### 4.1 主进程入口

#### [index.ts](file:///Users/hupengfei/Documents/my-app/src/main/index.ts)

**角色**：主进程入口，创建窗口并初始化应用。

**关键逻辑**：
- `app.setName('桌面助手')`（须在 whenReady 之前）：使菜单栏/Dock/任务栏显示品牌名，与 electron-builder productName 一致。
- `crashReporter.start({ uploadToServer: false })`：崩溃本地落盘不上报（dump 位于 `app.getPath('crashDumps')`，设置页可查看）。
- `whenReady` 后：`setAppUserModelId('com.desktop-agent.app')` → macOS Dock 设品牌图标 → `createMainWindow()` + `createTray()` + `createAppMenu()` → 兜底清理孤儿附件（`cleanupOrphanAttachments`）→ 连接已启用 MCP server（`mcp.connectAll()`，失败不影响启动）→ 恢复窗口置顶偏好。
- `before-quit` 调 `markQuitting()` 放行窗口 close（否则「关闭到托盘」设置会拦截真实退出）。

### 4.2 数据库层

#### [database/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/database/index.ts)

**角色**：SQLite 单例门面。模块加载即打开 `userData/data.db`（`DatabaseSync`，外键约束 + 5000ms 超时 + `PRAGMA journal_mode = WAL`），调用 `initSchema()`，启动时 `purgeExpiredDeletedSessions(30)` 物理清理过期回收站数据。

按域组装门面：`db = { ...sessions, ...messages, ...memories, ...modelConfigs, ...mcpServers, ...usage, ...settings, getDbPath(), close() }`，同时 `export * from './types'` 保持旧导入路径。

各域实现见 [第 6 节](#6-数据库子系统)。

### 4.3 Agent 子系统

#### [agent-manager.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/agent-manager.ts)

**角色**：Agent 实例生命周期管理器（每会话 Agent 实例的创建 / LRU 淘汰 / 事件桥 / 标题生成）。

**关键设计**：`Map<sessionId, Agent>` + LRU 数组 + 轮次计数 + 串行化锁。`getOrCreateAgent` 快速路径（缓存命中完全并发）/ 慢路径（`withCreateLock` 串行化 + 双重检查）。`bridgeEvents` 统一处理轮次超限（`maxTurnsPerRun`，默认 40）、空错误载体过滤、message_end 落库 + usage 记录、agent_end 推送完整 transcript。`generateTitle` 仅默认标题「新会话」时用首条用户消息生成，与回复并行；写入前重读标题防覆盖用户手动重命名。系统提示词在会话首次创建 Agent 时组装并固化进 `sessions.resolved_system_prompt` 快照（时间/记忆等一次固定），重建直接复用以命中 LLM 前缀缓存；`endedRuns` 记录已收到 agent_end 的会话（prompt 兜底 catch 避免重复补发覆盖错误态）、`lruPaused` 记录被 LRU 满暂停的会话（agent_end 携带提示文案）。

#### [agent-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/agent-service.ts)

**角色**：AgentService IPC 服务（namespace `agent`），对话控制、压缩、事件桥、模型配置管理入口、技能、权限、文档解析等。

**常量**：`COMPRESS_KEEP_COUNT=6`、`COMPRESS_HEADROOM=0.7`、`SUMMARY_MAX_FRACTION=0.15`、`COMPRESS_OUTPUT_BUDGET=2048`、`COMPRESS_SYSTEM_PROMPT`。

**对话控制 IPC 方法**：

| 方法 | 作用 |
|---|---|
| `prompt(sessionId, text, images?, files?, skills?)` | 发送用户消息：组装 user 消息块（技能 SKILL.md 全文、文件文本、图片 base64），自动压缩预检、落库、并行生成标题、后台跑 Agent（不 await） |
| `abort(sessionId)` | 中止正在生成的 Agent |
| `steer(sessionId, text)` | 向运行中的 Agent 注入用户消息（不落库） |
| `followUp(sessionId, text)` | 追加用户消息（延续对话） |
| `continue_(sessionId)` | 新一轮 run（重置轮次计数后继续） |
| `retry(sessionId)` | 重试：删末尾失败 assistant → 驱逐 → rehydrate → continue |
| `regenerate(sessionId)` | 重新生成末条 assistant 回复 |
| `recallLastUserMessage(sessionId)` | 回收末尾失败的用户消息（回填输入框） |
| `setThinkingLevel(sessionId, level)` | 实时改内存 Agent 思考级别（无需驱逐，下一轮生效） |
| `compressSession(sessionId)` | 手动压缩会话历史（返回 `CompressResult`） |
| `getSessionContextUsage(sessionId)` | 压缩确认弹窗用：上下文占用统计 |
| `readClipboardImage()` | 读取剪贴板截图（PNG base64） |
| `parseDocumentFile(buffer, filename)` | 解析文档（docx/pdf/xlsx/pptx/csv）为 Markdown |
| `listTools()` | 全部工具及启用状态 |
| `getWebSearchConfig()` / `setWebSearchApiKey(key)` / `clearWebSearchApiKey()` / `testWebSearch(key?)` | Tavily Key 配置（safeStorage，明文不跨进程） |
| `getFindSkillConfig()` / `setFindSkillSource(source)` / `testFindSkill(source)` | 技能搜索数据源（字节/腾讯） |
| `listInstalledSkills()` / `setSkillEnabled(id, enabled)` / `uninstallSkill(id)` / `openSkillsDir()` | 技能管理 |
| `respondPermission(requestId, approved, scope)` | 回传权限确认结果（once/session/always） |
| `listBashAllowlist()` / `removeBashAllowlist(command)` | bash 持久白名单 |
| `evictSession(sessionId)` / `evictAllSessions()` | 驱逐单个/全部内存 Agent |
| `getAttachmentDataUrl(fileKey)` | 渲染层读附件为 data URL |

**事件推送**（经 rendererClient）：`agentEvent.onEvent`、`agentEvent.onSessionUpdate`、`agentEvent.onPermissionRequest`。

#### [model-config-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/model-config-service.ts)

**角色**：ModelConfigService IPC 服务（namespace `modelConfig`），模型配置管理。每次变更同步注册/注销运行时 provider。

| 方法 | 作用 |
|---|---|
| `listModelConfigs()` | 全部模型配置（脱敏，含 hasApiKey） |
| `createModelConfig(input, apiKey?)` | 创建配置并注册运行时 provider（apiKey 加密落库） |
| `updateModelConfig(id, patch)` | 更新配置并重新注册（apiKey: string 覆盖 / null 清除 / undefined 不动） |
| `deleteModelConfig(id)` | 删除配置并从运行时注销 |
| `testModelConfig(id)` | 连通性测试（8s 超时，首事件即成功） |
| `listPresetProviders()` | 预置服务商列表 |
| `listPresetModels(providerId)` | 某服务商的预置模型列表 |
| `listPresetModelsOnline(providerId, apiKey)` | 在线拉取服务商 /models（apiKey 仅透传不落库） |

#### [model-config/](file:///Users/hupengfei/Documents/my-app/src/main/agent/model-config/) 目录

- **crypto.ts**：`getDecryptedApiKey` / `setConfigApiKey` / `clearConfigApiKey`（safeStorage 加密存 DB）。
- **mappers.ts**：`ModelConfigSummary`（脱敏，无密文）、`CreateModelConfigInput`、`UpdateModelConfigInput`、`toSummary`/`toCreateParams`/`toUpdateParams`。
- **preset-catalog.ts**：`listPresetProviders` / `listPresetModels`（白名单 api 过滤）、`findBuiltinModel`、`fetchPresetModelsOnline`（在线 GET /models 补充 catalog 滞后）、DeepSeek 峰谷定价预填。
- **pricing.ts**：`computeModelCost` / `isInPeakPeriod` / `resolveAssistantCost`（自定义定价 + 分时段倍率，否则回退 pi-ai catalog）。
- **register.ts**：`buildModel` / `registerModelConfig`（config.id 同时作 provider id，auth 用 `envApiKeyAuth` 占位，真实 key 由 Agent `getApiKey` 回调注入）/ `registerAllModelConfigs` / `unregisterModelConfig`。
- **test.ts**：`testModelConfig`（maxTokens:1 跑一次 streamSimple，8s 超时，不传 reasoning 避免端点 400）。

#### [mcp/](file:///Users/hupengfei/Documents/my-app/src/main/agent/mcp/) 目录

- **client.ts**：`connectMcpServer` / `callMcpTool`，stdio（`StdioClientTransport`）与 streamable HTTP（`StreamableHTTPClientTransport`）双传输，连接/拉工具带超时（`CONNECT_TIMEOUT_MS=8000`、`LIST_TOOLS_TIMEOUT_MS=8000`）。
- **index.ts**：`mcpManager` 单例，维护每 server 连接；`reload` 先断开全部再并行重连；`getTools` 惰性连接并把工具转 AgentTool（工具名加 `{safeName}_` 前缀防冲突）；`getStatus` 供设置页。
- **service.ts**：`McpService`（namespace `mcp`）——`listServers` / `createServer` / `updateServer` / `setEnabled` / `deleteServer` / `getStatus` / `testConnection` / `connectAll`；变更后 reload 连接池 + 触发 `onConfigChanged`。
- **schema.ts**：JSON Schema → TypeBox 转换（`jsonSchemaToType`）。
- **utils.ts**：`withTimeout` / `safeName`（server 名净化做工具前缀）/ `mcpResultToContent`（结果 → pi-ai content blocks）。
- **test.ts**：`testMcpConnection`（试连不落池）。

#### [skills-store.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/skills-store.ts)

**角色**：技能存储与市场安装。技能落盘 `{userData}/skills/{id}/`，manifest.json 记录。`installSkill` 支持字节（SKILL.md 文本）/ 腾讯（zip 安全解压，10MB/300 文件上限、防路径穿越）。`readSkillFile` 白名单防目录穿越、512KB 上限、NUL 字节检测。

#### [attachment.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/attachment.ts)

**角色**：本地附件存储。目录 `{userData}/attachments/{sessionId}/{uuid}.{ext}`；DB 中 image block 的 data 为 `file:{sessionId}/{uuid}.{ext}` 引用；`cleanupOrphanAttachments` 清理回收站软删会话到期/清空后残留的附件目录。

#### [convert.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/convert.ts)

**角色**：AgentMessage ↔ DB 行互转 + 图片附件落盘/还原。`persistMessageImages`（base64→file 引用）、`rowsToAgentMessages`（file 引用→base64 还原）。custom 消息整条序列化；assistant 的 api/provider/usage 快照存 metadata；token 用量统一走 usage_logs。

#### [models.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/models.ts)

**角色**：运行时 Models 集合单例与一次性文本补全。空集合启动，仅注册用户添加的 model_configs（不装 builtin 避免污染选择器）；`completeText` 供标题生成/压缩摘要用。

#### [permission.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/permission.ts)

**角色**：危险工具权限拦截钩子 + bash 白名单。判定顺序：deny（破坏性命令正则）> 只读命令自动放行 > 持久白名单 > 会话放行 > 弹窗确认。`always` 作用域仅 bash 且 denyHit=false 时写入白名单。

#### [types.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/types.ts)

**角色**：共享类型与设置常量。`ThinkingLevel`（off/minimal/low/medium/high/xhigh/max）、`AgentEventPayload`、`PermissionRequest`、`ModelKey` + `formatModelKey`/`parseModelKey`、`ToolInfo`、`buildDefaultSystemPrompt`（角色定位 + 能力指引）、`buildSystemCapabilitySections`（当前环境 + 工作方式 + 回答风格 + echarts 指引）、`maxTurnsReachedMessage`，以及全部 `SETTING_*` / `DEFAULT_*` 常量。

### 4.4 工具集（tools）

**注册表**（[tools/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/index.ts)）：`TOOL_REGISTRY` 登记全部工具及默认启用状态；`buildTools` 按开关过滤注入 Agent（技能域工具受 `skillsEnabled` 总开关、记忆域工具受 `memoryEnabled` 总开关控制）。

| 文件 | 工具名 | 用途 | 执行模式 | 默认启用 |
|---|---|---|---|---|
| read-file.ts | `read_file` | 读文件：纯文本（2000 行/50KB 截断，offset/limit 分段）+ 文档自动解析为 Markdown | parallel | ✅ |
| list-files.ts | `list_files` | 列出目录（递归默认 3 层，上限 5000 条自动截断） | parallel | ✅ |
| write-file.ts | `write_file` | 写文件（覆盖/创建，自动建父目录），危险操作需权限确认 | sequential | ✅ |
| edit-file.ts | `edit_file` | 增量编辑：oldText→newText 精确替换（唯一匹配、逆序应用、保留 BOM/行尾），危险操作需权限确认 | sequential | ✅ |
| bash.ts | `bash` | Shell 执行（默认 30s 超时，输出 50k 截断，abort 时 kill 进程组，SIGTERM 宽限期后升级 SIGKILL），危险操作需权限确认 | sequential | ✅ |
| web-search.ts | `web_search` | Tavily 网页搜索（需配置 API Key） | parallel | ❌ |
| find-skill.ts | `find_skill` | 搜索技能（字节 Find Skill / 腾讯 SkillHub，5 分钟结果缓存） | parallel | ✅ |
| install-skill.ts | `install_skill` | 安装技能到本地技能目录（下载并解压不可信代码，需权限确认） | parallel | ✅ |
| read-skill.ts | `read_skill` | 读取技能 SKILL.md / 包内文件；不传 skill 时返回已安装清单 | parallel | ✅ |
| memory.ts | `list_memories` / `add_memory` / `update_memory` / `delete_memory` | 长期记忆四件套（总量上限 20 条 / 3000 字 / 单条 200 字，超限拒绝写入） | parallel | ✅（受 memoryEnabled） |
| web-search-config.ts | —（非工具） | Tavily API Key 加密存取 | — | — |

### 4.5 服务层（service）

#### [service/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/index.ts)

注册 6 个 IPC 服务并接线 MCP 变更 → 驱逐全部 Agent（见 [第 2 节](#2-进程架构与双向-ipc)）。

#### [service/app-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/app-service.ts)

**namespace `app`**：`getAppVersion`、`openExternal`（仅放行 http/https）、`getAutoLaunch`/`setAutoLaunch`（开机自启）、`getDiagnosticsInfo`（日志/崩溃目录）、`openDiagnosticsDir('logs'|'crashes')`（白名单目录）、`clearLogs`。

#### [service/db-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/db-service.ts)

**namespace `db`**：会话/消息/设置/压缩/上下文/回收站/全文搜索/记忆/用量/导出完整 CRUD 薄封装；`forkSession` 后复制图片附件文件到新会话目录并改写 `file:` 引用；`exportSession(sessionId, format)`（markdown/json，系统保存对话框）。**模型配置与加密 key 不在此暴露**（由 model-config 直接操作 db 单例），避免渲染进程接触加密 key。

#### [service/window-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/window-service.ts)

**namespace `window`**：`initWindow`（幂等绑定窗口事件 + 返回当前状态）、`setBackgroundColor`（与渲染层主题背景对齐，防 resize 闪白）、`triggerWindowAction`（hide/show/close/maximize/minimize/fullscreen/always-on-top/native-title-bar 等 12 种动作）。置顶动作持久化到 settings `window.alwaysOnTop`（启动时由 main 恢复）；native/custom 标题栏切换写 `window.titleBarMode` 后 `setImmediate(recreateMainWindow())`。窗口事件变化经 `rendererClient.ui.windowStateChange` 广播。

#### [service/window-manager.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/window-manager.ts)

**角色**：BaseWindow + 双 WebContentsView 管理（架构见 [第 2 节](#2-进程架构与双向-ipc)）。导出 `HEADER_HEIGHT=32`、`createMainWindow`、`recreateMainWindow`（标题栏模式切换，保留位置尺寸）、`getMainWindow/getHeaderView/getContentView/getWindowByWebContents/broadcastToAllViews/ensureMainWindow/markQuitting`。初始尺寸按主屏工作区等比（宽 ~66%、高 ~72%，960~1800/680~1200 约束，居中）。`win.on('close')` 拦截：`quitting` 为 false 且开启「关闭到托盘」时 preventDefault + hide。两视图都挂 `optimizer.watchWindowShortcuts`。

#### [service/tray-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/tray-service.ts)

`createTray()`：托盘图标单张 @2x 源图运行时派生 @1x（macOS template 图自动着色，其余平台彩色徽章）。菜单：显示/隐藏、新建对话、打开设置、退出。非 macOS 点击图标切换显隐。

#### [service/app-menu-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/app-menu-service.ts)

`createAppMenu()`：替换默认英文菜单（补齐 macOS 标准应用菜单 + 编辑菜单，保证 Cmd+C/V/X 等剪贴板快捷键生效）。结构：macOS 应用菜单（关于/隐藏/退出）+「操作」菜单（显示/隐藏、新建对话、打开设置 → `rendererClient.ui.trayAction`）+「编辑」+「视图」（含「标题栏开发者工具」toggleDevTools 到 headerView）+ macOS「窗口」菜单。同时设置 Dock 右键菜单。

### 4.6 工具函数（utils）

#### [utils/log.ts](file:///Users/hupengfei/Documents/my-app/src/main/utils/log.ts)

electron-log 文件日志。`log.initialize({ spyRendererConsole: true })`（捕获渲染/preload console）+ `errorHandler.startCatching`（未捕获异常落盘）。文件 level 'silly'、单文件 5MB 轮转。导出 `createLogger(scope)`（模块标签）、`getLogFilePath()`、`clearLogFile()`。

#### [utils/render-client.ts](file:///Users/hupengfei/Documents/my-app/src/main/utils/render-client.ts)

主进程 → 渲染进程广播客户端（Proxy 自建，见 [第 2 节](#2-进程架构与双向-ipc)）。

#### [utils/message-text.ts](file:///Users/hupengfei/Documents/my-app/src/main/utils/message-text.ts)

`extractMessageText(content)`：从 string 或 block 数组提取纯文本（拼接全部 text block），供标题生成/压缩摘要/会话导出复用。

#### [utils/doc-parser.ts](file:///Users/hupengfei/Documents/my-app/src/main/utils/doc-parser.ts)

基于 mdize 的文档解析（docx/pdf/xlsx/pptx/csv → Markdown）。导出 `MAX_EXTRACT_CHARS=300_000`、`isDocumentFile`、`extractDocumentText`、`readAndExtractDocument`。**惰性加载**：mdize 顶层急切引入 pdfjs/tesseract 重依赖，故 `getMdize()` 动态 import + promise 缓存避免拖慢启动。

### 4.7 Preload 层

#### [preload/index.ts](file:///Users/hupengfei/Documents/my-app/src/preload/index.ts)

调用 `initializeIpcPreload()`（electron-ipc-service 桥接），随后 contextBridge 暴露 `window.electron`（@electron-toolkit/preload 的 electronAPI）与 `window.api`（空对象）。

#### [preload/globals.d.ts](file:///Users/hupengfei/Documents/my-app/src/preload/globals.d.ts)

声明全局 `Window` 类型 `{ electron: ElectronAPI; api: unknown }`。原为 index.d.ts，因 tsconfig.node.json 收录 src/preload/** 时同名 d.ts 会被 index.ts 遮蔽丢弃，改名后两套 tsconfig 都能生效。

---

## 5. Agent 子系统深入

### 5.1 Agent 实例生命周期与 LRU 缓存

`AgentManager` 维护每会话一个 Agent 实例（`agents: Map<string, Agent>`），辅以 `lru: string[]` 顺序数组。

**获取**（`getOrCreateAgent(sessionId)`）双路径设计：
- **快速路径**（cache 命中）：直接返回并 `touchLru`，**无锁**，多会话并发对话互不阻塞。
- **慢路径**（cache miss）：经 `withCreateLock` promise-chain 串行化。双重检查（等锁期间可能已被创建）；LRU 满（`MAX_AGENTS = 8`）则 `evictOne`；`createAgent` 入缓存。

**淘汰**（`evictOne(excludeId)`）两轮策略：先找最久未用的 idle Agent（`!a.signal`，不打断运行中会话）；均运行则淘汰最久的非排除项。`evictAgentLocked` **先同步从 map/LRU 移除再 await idle**，使并发 `getOrCreateAgent` 快速路径 miss 走慢路径排队，杜绝孤儿 run 与 rehydrate 新实例并存的双 run 写冲突。

**驱逐语义**：`evictAgent`（自动取锁）供手动压缩/设置变更用。运行中 Agent 先 abort 再等收尾（bridgeEvents 仍会推 agent_end）。驱逐后下次访问从 DB rehydrate。

### 5.2 模型配置

- **ModelKey**：`{provider, id}` 二元组，`provider = model_configs.id`，`id = modelId`。`formatModelKey`/`parseModelKey` 做 JSON 序列化/解析，存于 `session.model` 与 `settings.defaultModel`。
- **解析优先级**：会话级 `session.model` > `settings.defaultModel`（上次使用）> 空（不再自动回退首个 config）。`resolveModel` 调 `getModelsInstance().getModel(provider, id)`。辅助任务（标题生成/压缩摘要）的 `resolveAuxModel` 同口径，两者都未命中时返回 undefined。
- **注册**：`config.id` 同时作 pi-ai provider id，auth 用 `envApiKeyAuth` 占位，真实 key 由 Agent `getApiKey` 回调注入 `streamSimple({apiKey})`。
- **API key**：`safeStorage` 加密存 `model_configs.api_key_encrypted` BLOB，单独列读写，渲染进程只接触 `hasApiKey` 布尔。
- **thinkingLevel**：7 级（off/minimal/low/medium/high/xhigh/max），会话级 `session.thinking_level` 覆盖「上次使用」（`settings.defaultThinkingLevel`，新建会话继承最近一次手动选择），`setThinkingLevel` 实时同步内存 Agent 无需驱逐。

### 5.3 工具注册与执行

- **注册表**：`TOOL_REGISTRY` 10 个工具，默认启用除 web_search（需先配置 Tavily Key）；`buildTools()` 过滤启用项注入 Agent，`setSkillEnabled`/记忆总开关等实时生效。
- **启用状态**：`settings.enabledTools`（`Record<toolName, boolean>`）仅记录显式覆盖，未记录走默认。
- **executionMode**：read_file/list_files/web_search/技能/记忆为 `'parallel'`；write_file/edit_file/bash 为 `'sequential'`（危险工具串行 + 权限确认）。
- **执行**：Agent `toolExecution:'parallel'`，但单个工具的 executionMode 由工具自身声明。bash 支持 abort（kill 进程组）与超时；write_file/edit_file 自动建父目录。

### 5.4 权限系统

```
Agent 调工具 → beforeToolCall 钩子
  ├─ 判定顺序：deny（破坏性命令正则）> 只读命令自动放行
  │            > 持久白名单（bash）> 会话放行 > 弹窗确认
  ├─ 命中危险工具（write_file/edit_file/bash）
  │   ├─ 生成 requestId
  │   ├─ rendererClient.agentEvent.onPermissionRequest(req) 推送
  │   ├─ 返回 pending Promise（阻塞工具执行）
  │   └─ 渲染进程弹框 → mainClient.agent.respondPermission(requestId, approved, scope)
  │       └─ resolvePermission 解除 Promise
  │           ├─ approved → undefined（放行）
  │           └─ 拒绝 → {block:true, reason:'用户拒绝执行该工具'}
  └─ 非危险工具 → 直接放行
```

支持 abort：signal abort 时 `resolve({block:true, reason:'已中断'})`。

### 5.5 流式事件到渲染进程

`bridgeEvents(sessionId, agent)` 订阅 `agent.subscribe`：

- **纯错误载体过滤**：`isEmptyErrorCarrier` 判定 assistant + errorMessage + 无实质内容，其 `message_*` 事件不落库不转发（避免空气泡）。
- **轮次超限 / LRU 暂停**：`turn_end` 计数达 `maxTurnsPerRun`（默认 40）或 LRU 满被暂停时，agent_end 携带明确提示文案（而非静默 aborted）。
- **message_end 落库**：assistant/toolResult 落 DB（user 已在 prompt 入口落库），并记录 usage（kind='chat'）。
- **agent_end**：用完整 transcript 替换 `event.messages`（renderer 全量合并）；区分 aborted（`stopReason==='aborted'`，不携带 error）与真实失败（携带 `agent.state.errorMessage`）；记录 `endedRuns`（prompt 兜底 catch 据此避免补发第二个 agent_end 覆盖错误态）。若本轮真实失败且未落库过任何 assistant 内容（空错误载体被过滤），补一条 `finishReason='error'` 的失败标记行，使重启/重读库后前端仍能恢复「重试/编辑」入口。
- **其他事件**：原样包装 `{sessionId, event}` 推送 `rendererClient.agentEvent.onEvent`。

### 5.6 会话历史转换/加载/保存

- **落库**（convert `toCreateMessageParams`）：user 存原始 content（文件/技能块带标记）；assistant content 存 block 数组，api/provider/usage 快照存 metadata；toolResult 的 toolCallId/toolName 落独立列，isError/usage/details 存 metadata；custom 整条序列化。图片 base64 经 `persistMessageImages` 转为 `file:` 引用落盘。
- **加载**（`fromMessageRow`）：按 role 重建 AgentMessage，图片 `file:` 引用经 `rowsToAgentMessages` 还原为 base64。
- **压缩**：`compressSession` 保留最后 6 条（自适应窗口：压缩后降到阈值 × 0.7 以下），之前用 LLM 摘要，乐观锁推进 `compress_summary`/`compress_last_index`/`compress_version`，不删原消息。`getSessionContext` 返回 `id > compressLastIndex` 的消息。`transformContext` 在上下文头部注入 `[之前的对话摘要]` user 消息。
- **自动压缩**：`autoCompressIfNeeded` 在 prompt 入口静默触发（未压缩上下文达到窗口 75% 时，可配置 50–100），用粗估 token 算法（CJK 1 字 ≈ 1 token，其余 3.5 字符/token）。

### 5.7 对话控制语义

| 操作 | 行为 |
|---|---|
| `retry` | 删末尾连续失败 assistant（含失败标记行）→ rehydrate → continue（不重复用户消息） |
| `regenerate` | 删末条 assistant（不限 finishReason）→ rehydrate → continue |
| `recallLastUserMessage` | 删末尾失败 assistant + 末尾 user，返回是否回收（供前端回填输入框） |
| `steer`/`followUp` | 注入 user 消息引导运行中/已结束的 agent（暂未接 UI，预留） |

### 5.8 上下文注入（长期记忆 + 压缩摘要）

- **长期记忆**：会话（Agent 实例）**首次创建时全量注入系统提示词**并固化进 `sessions.resolved_system_prompt` 快照，会话期间不再变动 → systemPrompt 前缀稳定，命中 LLM 前缀缓存。记忆总量在写入时被硬上限约束（20 条 / 3000 字 / 单条 200 字，超限拒绝）。记忆变更不失效快照，仅对「尚未创建过 Agent 的新会话」生效；会话内 Agent 通过 `list_memories` 等工具感知自己的记忆操作。`memoryEnabled` 开关只控制记忆工具可用性，不影响已注入的记忆段（切换开关不改变提示词）。
- **压缩摘要**：`transformContext` 在消息头部注入 `[之前的对话摘要]` user 标记块（不修改 systemPrompt）。

---

## 6. 数据库子系统

**引擎**：Node 内置 `node:sqlite` 的 `DatabaseSync`，文件 `userData/data.db`，启用外键约束 + WAL 模式 + 5000ms 超时。模块级单例 `db`。

### Schema（schema.ts）

所有表均为 `STRICT` 表，时间列统一 unix 毫秒（INTEGER）。`CREATE TABLE IF NOT EXISTS` 不更新已存在表结构，单机单版本部署：schema 变更直接改建表语句、删库重建，不写迁移。

**sessions（会话）**

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `crypto.randomUUID()` |
| title | TEXT NOT NULL DEFAULT '新会话' | 标题（首条消息后自动生成） |
| status | TEXT DEFAULT 'active' CHECK('active','ended') | |
| model | TEXT | 会话级 ModelKey JSON |
| thinking_level | TEXT | 会话级思考级别 |
| system_prompt | TEXT | 会话级系统提示覆盖 |
| resolved_system_prompt | TEXT | 最终组装后的系统提示词快照（首次创建 Agent 时固化，重建复用；自定义提示词/全局默认提示词变更时失效） |
| parent_session_id | TEXT FK→sessions.id | 分支会话来源 |
| compress_summary / compress_last_index / compress_version | TEXT/INTEGER/INTEGER | 压缩摘要 / 压缩指针 / 乐观锁版本 |
| deleted_at | INTEGER | 软删除时间（回收站） |
| pinned / archived | INTEGER DEFAULT 0 | 置顶 / 归档 |
| created_at / updated_at / last_active_at | INTEGER | |

**messages（消息）**

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| session_id | TEXT NOT NULL FK→sessions.id ON DELETE CASCADE | |
| role | TEXT NOT NULL | user/assistant/toolResult/custom |
| content | TEXT NOT NULL | JSON（Block[] 或字符串） |
| tool_call_id / tool_name | TEXT | toolResult 冗余列 |
| model / provider / finish_reason | TEXT | 生成模型 / 停止原因 |
| timestamp | INTEGER NOT NULL | `Date.now()` |
| metadata | TEXT | JSON（api/provider/usage/details/isError） |

**model_configs（模型配置，取代旧 credentials 表）**

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 同时作 pi-ai provider id |
| display_name | TEXT NOT NULL | UI 显示名 |
| source | TEXT CHECK('preset','custom') | |
| preset_provider | TEXT | preset 时记录服务商 id |
| api_format | TEXT CHECK('openai-completions','anthropic-messages') | |
| base_url | TEXT | 自定义端点 |
| model_id | TEXT NOT NULL | 实际模型 id |
| context_window / max_tokens | INTEGER NOT NULL | |
| multimodal / reasoning | INTEGER DEFAULT 0 | |
| pricing | TEXT | 自定义定价 JSON（含峰谷时段） |
| api_key_encrypted | BLOB | safeStorage 加密 |
| created_at / updated_at | INTEGER | |

**settings（设置项）**：`key TEXT PK`、`value TEXT NOT NULL`（JSON 值），写入经 `SETTING_VALIDATORS` 白名单校验。

**mcp_servers（MCP 服务器配置）**：id、name、transport（stdio/http）、command/args/env/url（args/env JSON 序列化）、enabled、created_at/updated_at。

**memories（长期记忆）**：id（UUID）、content、category（general/preference/fact/project）、source（manual/auto，auto 仅为历史遗留不再产生）、created_at/updated_at。写入时强制总量上限（20 条 / 3000 字 / 单条 200 字，超限拒绝）；记忆在会话首次创建 Agent 时全量注入系统提示词快照（见 5.8）。

**usage_logs（用量日志）**：id、session_id（FK CASCADE）、kind（chat/title/compress）、provider/model、prompt_tokens/completion_tokens、cost、timestamp。**token 统计的唯一数据源**，不挂在 messages 上（辅助调用不产生消息但同样消耗 token）。

**FTS5 虚拟表**
- `messages_fts(text, tokenize='unicode61')`：rowid 与 messages.id 一一对应；不用 contentless 模式（不支持 DELETE/UPDATE，索引需随消息增删改同步）。
- `memories_fts(text, tokenize='unicode61')`：rowid 为 memories.id 的 FNV-1a 哈希（`rowidKey`）；检索时先取命中 rowid 集合，再在 JS 层按哈希还原比对（UUID 与 INTEGER rowid 无法直接 JOIN）。
- 分词：CJK 段 2-gram 化（单字保留），非 CJK 按 `\W` 切词（fts.ts）。

**索引**：`idx_sessions_active(last_active_at)`、`idx_sessions_parent`、`idx_messages_session_id(session_id, id)`、`idx_messages_timestamp`、`idx_model_configs_updated`、`idx_memories_updated`、`idx_usage_logs_timestamp`、`idx_usage_logs_session`。

**轻量列清理**（不引入完整迁移体系）：`DROP TABLE IF EXISTS credentials`；老库 messages 若有 token 用量列则 DROP（已由 usage_logs 取代）；老库 usage_logs 若有 `source_message_id` 则 DROP；老库 model_configs 缺 `pricing` 列时 ALTER ADD（保留数据）。

### 数据访问模式

- 全部经各域 API 工厂函数（sessions.ts / messages.ts / model-configs.ts / settings.ts / mcp-servers.ts / memory.ts / usage.ts），参数化查询，`transaction(db, fn)` 包装事务。
- `createMessage` 在事务内写消息 + 写 FTS + 刷新会话 updated_at。
- 会话删除为**软删除**（标记 deleted_at），回收站 30 天自动清理 + 设置页手动清空（清库前先清附件文件）。
- `searchMessages`：FTS5 预筛 + JS 精确过滤 + `makeSnippet` 摘要片段，JOIN sessions 排除软删会话。
- `forkSession`（分支对话）：复制分支点前历史，继承标题/模型/思考级别/系统提示；附件文件复制由 db-service 层完成。
- 压缩用乐观锁（`WHERE id=? AND compress_version=?`）。
- boolean 以 0/1 存储，映射层 `!!` 转换；content/metadata JSON 字符串，读取时 parse。

---

## 7. 服务层一览

| 服务 | namespace | 暴露方法 |
|---|---|---|
| AppService | `app` | getAppVersion、openExternal、getAutoLaunch/setAutoLaunch、getDiagnosticsInfo、openDiagnosticsDir、clearLogs |
| DbService | `db` | 会话/消息/设置/压缩/上下文/回收站/全文搜索/记忆/用量/导出完整 CRUD + forkSession |
| WindowService | `window` | initWindow、setBackgroundColor、triggerWindowAction（12 种动作） |
| AgentService | `agent` | 对话控制（prompt/abort/steer/followUp/continue_/retry/regenerate/recallLastUserMessage）、思考级别、压缩（compressSession/getSessionContextUsage + 自动压缩）、剪贴板截图/文档解析、工具（listTools）、Tavily 配置、技能管理、权限（respondPermission + bash 白名单）、驱逐（evictSession/evictAllSessions）、附件读取 |
| McpService | `mcp` | listServers/createServer/updateServer/setEnabled/deleteServer/getStatus/testConnection/connectAll |
| ModelConfigService | `modelConfig` | listModelConfigs/createModelConfig/updateModelConfig/deleteModelConfig/testModelConfig/listPresetProviders/listPresetModels/listPresetModelsOnline |

---

## 8. 构建与配置

### electron-vite（[electron.vite.config.ts](file:///Users/hupengfei/Documents/my-app/electron.vite.config.ts)）

`defineConfig` 分三段：

- **main**：`resolve.alias`（`@main`/`@preload`/`@renderer`）；`build.externalizeDeps.exclude: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai']`。
  - **ESM 外部化绕过**：这两个包是纯 ESM（exports 仅 `import` 条件无 `require` 条件），electron-vite 默认 externalize 所有 dependencies，导致主进程 CJS `require()` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。通过 exclude 把它们排除出 externalization，让 Rollup 打进 bundle（ESM→CJS 转换），其余依赖继续 externalize。
- **preload**：仅 alias。
- **renderer**：`vue()`、`createSvgIconsPlugin`、`Components({ resolvers:[NaiveUiResolver()], dirs:[] })`（Naive UI 按需自动注册 N* 组件，关闭本地目录扫描）；alias。

### tsconfig

- [tsconfig.json](file:///Users/hupengfei/Documents/my-app/tsconfig.json)：仅 references，指向 `tsconfig.node.json` 与 `tsconfig.web.json`。
- [tsconfig.node.json](file:///Users/hupengfei/Documents/my-app/tsconfig.node.json)：extends `@electron-toolkit/tsconfig/tsconfig.node.json`，include main/preload 及 renderer 的 service/store/utils；paths `@main/*`/`@preload/*`/`@renderer/*`。
- [tsconfig.web.json](file:///Users/hupengfei/Documents/my-app/tsconfig.web.json)：渲染进程（vue-tsc）。

### electron-builder（[electron-builder.yml](file:///Users/hupengfei/Documents/my-app/electron-builder.yml)）

- appId `com.desktop-agent.app`，productName「桌面助手」。
- **win**：executableName「桌面助手」，nsis（桌面快捷方式 always）。
- **mac**：entitlementsInherit `build/entitlements.mac.plist`，notarize false，category productivity，extendInfo 含文稿/下载文件夹访问描述。
- **linux**：target AppImage + deb。
- asarUnpack `resources/**`，npmRebuild false，electronDownload mirror npmmirror。

### scripts/

- **generate-icons.mjs**：图标生成脚本（Squircle + 星光，产出 resources/icon.png、build/icon.png、托盘图标）。
- **patch-electron-plist.mjs**：postinstall 改写开发态 macOS Electron.app 的 CFBundleDisplayName/Name 为「桌面助手」（打包态由 electron-builder 提供正确名称）。

---

## 9. 关键设计速查

| 设计 | 要点 |
|---|---|
| **每会话独立 Agent** | `agents: Map<sessionId, Agent>` + LRU（max 8），并发会话互不阻塞 |
| **两阶段锁** | 快速路径（cache 命中）lock-free；慢路径（cache miss）promise-chain 串行化 + 双重检查 |
| **安全驱逐** | 先同步移除 map/LRU，再 abort + `waitForIdle`，杜绝双 run 冲突 |
| **BaseWindow 双视图** | headerView（32px 标题栏）+ contentView，弹窗不遮标题栏；render-client Proxy 广播替代 getAllWindows |
| **双向 IPC** | renderer→main（invoke）+ main→renderer（rendererClient 广播），权限回路闭环 |
| **模型隔离** | Models 集合不装 builtin（避免污染）；ModelKey 二元组定位；config.id 即 provider id |
| **API Key 安全** | `safeStorage` 加密 BLOB，单独列读写，渲染进程只接触 `hasApiKey` 布尔 |
| **会话压缩** | LLM 摘要 + 乐观锁推进版本，不删原消息，`transformContext` 注入摘要 + 自动压缩预检 |
| **流式事件过滤** | `isEmptyErrorCarrier` 过滤纯错误载体，避免空气泡；轮次超限 / LRU 暂停自动中止并携带提示；失败未产出内容时补失败标记行（重启后恢复重试入口） |
| **危险工具权限** | write_file/edit_file/bash/install_skill 前置确认，支持 once/session/always 三作用域 + bash 白名单；请求 60s 超时自动拒绝（防挂起）；rm 破坏性删除 deny 正则覆盖选项在文件名之后的写法 |
| **上下文注入** | 长期记忆在会话首次创建 Agent 时全量注入 systemPrompt 快照（重建复用、命中前缀缓存）；压缩摘要经 `transformContext` 以 user 标记块注入，绝不改 systemPrompt |
| **MCP 联动** | 配置变更 → reload 连接池 → 驱逐全部 Agent，下一轮重建时重新拉取工具集 |
| **无兼容代码** | 旧 `credentials` 表直接 drop，token 列迁移至 usage_logs，`parseModelKey` 不支持旧版纯 ID |
