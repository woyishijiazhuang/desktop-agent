# 前端架构文档（Vue 3 渲染进程）

> 本文档描述「桌面助手」前端（Electron 渲染进程）的架构设计、目录结构、每个文件的职责，以及状态管理、聊天流式渲染、会话/设置交互、样式主题的深入说明。

---

## 目录

1. [概览](#1-概览)
2. [应用架构](#2-应用架构)
3. [状态管理（Pinia Stores）](#3-状态管理pinia-stores)
4. [文件详解](#4-文件详解)
   - 4.1 [入口与根组件](#41-入口与根组件)
   - 4.2 [路由与 IPC 层](#42-路由与-ipc-层)
   - 4.3 [布局](#43-布局)
   - 4.4 [视图（Views）](#44-视图views)
   - 4.5 [组件（Components）](#45-组件components)
   - 4.6 [Composables](#46-composables)
   - 4.7 [Utils](#47-utils)
   - 4.8 [Assets](#48-assets)
   - 4.9 [自定义标题栏（header）](#49-自定义标题栏header)
5. [聊天流式与渲染深入](#5-聊天流式与渲染深入)
6. [会话与设置 UX 深入](#6-会话与设置-ux-深入)
7. [样式与主题](#7-样式与主题)
8. [关键设计速查](#8-关键设计速查)

---

## 1. 概览

本前端是 Electron + Vue 3 + TypeScript 桌面端 AI 对话 Agent 应用的渲染进程，位于 [src/renderer](file:///Users/hupengfei/Documents/my-app/src/renderer)。它实现了一个本地优先的 AI 聊天助手：支持多家模型服务商与自定义 OpenAI/Anthropic 兼容端点、流式 Markdown 渲染、工具调用展示、危险工具权限确认、会话管理与压缩历史、长期记忆、技能与 MCP 配置、用量统计、深浅主题切换。

标题栏不在 Vue 应用内，而是主进程 `BaseWindow` 上的独立 WebContentsView（[src/renderer/header](file:///Users/hupengfei/Documents/my-app/src/renderer/header)，纯 TS，不依赖 Vue/Pinia），保证应用内弹窗永远无法遮盖标题栏。

### 技术栈

| 依赖 | 作用 |
|---|---|
| Vue 3 | `<script setup>` 组合式 API |
| Pinia | 状态管理（setup store 形式） |
| Vue Router 4 | hash 模式，路由懒加载 |
| Naive UI | 组件库，通过 `NConfigProvider` 联动主题 |
| `markstream-vue` | 流式 Markdown 渲染器（chat 模式 + final 标志 + echarts 语言级覆盖） |
| `highlight.js` | 按需注册语言，供 NCode 高亮 |
| `vue-stick-to-bottom` | 粘底滚动，ResizeObserver 驱动 |
| `@vicons/ionicons5` | 图标 |
| `electron-ipc-service` | 双向 IPC 客户端/服务端框架 |
| `@earendil-works/pi-agent-core` / `pi-ai` | Agent 事件与消息类型 |
| `echarts` | 用量统计与图表块渲染 |

渲染进程通过 `electron-ipc-service/renderer` 的类型化客户端与主进程通信：渲染进程调主进程方法（`mainClient.app.*`、`mainClient.db.*`、`mainClient.window.*`、`mainClient.agent.*`、`mainClient.mcp.*`、`mainClient.modelConfig.*`），主进程通过命名空间服务（`UiService`、`AgentEventService`）反向推送事件。

CSP 策略（[index.html](file:///Users/hupengfei/Documents/my-app/src/renderer/index.html)）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`。

---

## 2. 应用架构

### 启动引导（[main.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/main.ts)）

1. 引入全局 CSS（`main.css` → `base.css`）与 markstream-vue 样式。
2. `setCustomComponents('chat', { echarts: EChartsBlock })` 注册 markstream 语言级覆盖（须在 MarkdownRender 首次挂载前）。
3. `createPinia()` 创建 Pinia 实例。
4. **关键**：在 `mount()` 之前同步调用 `useThemeStore(pinia)`，在 `<html>` 上落下 `.dark` 类，避免深色模式首屏 FOUC（闪烁）。
5. `createApp(App).use(pinia).use(router).mount('#app')`。

### IPC 客户端层

**[utils/main-client.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/utils/main-client.ts)**：单行导出 `mainClient = createIpcRendererClient<IpcMainServices>()`，是渲染进程调主进程的统一入口（类型由主进程 `IpcMainServices` 推导）。覆盖命名空间：`app`、`db`、`window`、`agent`、`mcp`、`modelConfig`。

**[service/index.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/service/index.ts)**：注册主进程反向推送的接收服务。
- `UiService`（namespace `ui`）：`windowStateChange(state)` → `Object.assign(windowStore.state, state)`；`showToast(options)` → 经 `utils/toast.ts` 调 Naive UI `useMessage()` 弹出全局 toast；`trayAction(action)` → 派发 `CustomEvent('tray-action')`，App.vue 监听后导航。
- `AgentEventService`（namespace `agentEvent`）：`onEvent(payload)` 路由到对应会话的 chat store 容器（含 rAF 流式限频）；`onPermissionRequest(req)` → `usePermissionStore().enqueue(req)`；`onSessionUpdate(session)` → `useSessionStore().upsertSession(session)` + `useChatStore().updateCompress(session)`（压缩成功后同步分界元信息）。

通过 `initializeIpcRendererServices([UiService, AgentEventService])` 完成注册。

### 路由（[router/index.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/router/index.ts)）

- `createWebHashHistory()`（Electron 渲染进程用 hash 避免文件协议路由问题）。
- 根路由 `/` 挂 `DefaultLayout`，子路由：`''` 重定向到 `/chat`；`chat`（[ChatView.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/views/ChatView.vue)，meta.title `对话`）；`settings`（[SettingsView.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/views/SettingsView.vue)，meta.title `设置`）。
- `afterEach` 钩子：`document.title = ${title} - 桌面助手`。

### 布局系统

- [App.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/App.vue)：根组件，Provider 链 `NConfigProvider`（`:theme` / `:theme-overrides` 由 `useThemeStore.isDark` 驱动）→ `NMessageProvider` → `NDialogProvider` → `ToastBridge` + `<router-view />`。监听托盘动作事件完成新建对话/打开设置导航。
- [DefaultLayout.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/layouts/DefaultLayout.vue)：纯承载 `<router-view />` 的占位布局（标题栏已迁至主进程独立 WebContentsView，见 [4.9](#49-自定义标题栏header)）。

### 整体数据流

```
UI 动作（输入/切换会话/改设置）
  → Pinia store action
  → mainClient.xxx.* IPC（invoke 到主进程）
  → 主进程执行（跑 Agent / 读写 DB / 调模型 API）
  → 主进程通过 rendererClient.agentEvent.onEvent 推送 AgentEvent
  → AgentEventService.onEvent → chat.applyEvent 更新对应会话容器
  → 响应式 UI 自动更新（MessageList / MessageItem / ChatInput）
```

---

## 3. 状态管理（Pinia Stores）

### 3.1 useChatStore

- **路径**：[store/useChatStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useChatStore.ts)
- **store 名**：`chat`
- **职责**：**多会话聊天状态容器**（按 sessionId 存每会话实时状态）+ 「当前会话」视图代理 + 全部聊天动作。

**核心结构**：
- `sessions = reactive<Record<string, SessionChatState>>`：每会话独立容器（messages/isBusy/toolStatus/error/lastTurnFailed/model 等）。
- `current` computed：指向 `currentSessionId` 对应容器；临时态（`currentSessionId === null`）指向虚拟 key `__ephemeral__`。聊天组件通过同名字段读取「当前会话视图」，后台会话事件照常更新各自容器（侧栏据此显示「生成中/失败」状态点）。

**Key state（当前会话视图）**：

| 字段 | 含义 |
|---|---|
| `currentSessionId` | 当前会话 id；`null` 表示临时空对话（ephemeral） |
| `messages` | 当前会话消息列表（user/assistant/toolResult） |
| `isBusy` | 是否正在生成 |
| `error` | 错误提示文本 |
| `toolStatus` | 工具调用实时状态，key = toolCallId |
| `currentModelKey` | 当前会话生效模型键；`null` = 无可用模型 |
| `lastTurnFailed` | 上一轮是否真实失败（非中止） |
| `prefillText` | 一次性回填文本（recall 失败消息时回填输入框） |
| `compressLastIndex` / `compressSummary` | 压缩分界元信息：最后一个被压缩消息的 DB id / 摘要全文（MessageList 据此渲染分界卡片） |

**Key actions**：

| action | 行为 |
|---|---|
| `hydrateState(sessionId)` | 分页加载最近 `PAGE_SIZE=30` 条；`deriveLastTurnFailed` + `deriveToolStatus` 推导失败态与持久化工具状态 |
| `loadMoreMessages()` | 以 `oldestLoadedId` 为边界向上翻页并 prepend |
| `enterEphemeral()` | 清空当前视图 + `currentSessionId=null`，不写库；模型设为「上次使用/默认」、思考级别设为「上次使用」 |
| `selectModel(key)` | 更新容器 + `setLastUsed`；会话已落库时写回 `session.model`、touch 置顶、驱逐内存 Agent（下一轮生效） |
| `selectThinkingLevel(level)` | 写回会话行 + 写回「上次使用思考级别」（新建会话继承）+ 实时同步内存 Agent（`setThinkingLevel`，无需驱逐） |
| `send(text)` | 临时态先置 `isBusy=true` 上锁 → `createSession({model})` → 虚拟容器整体迁移为新会话容器（免重载）→ 乐观 push userMsg → `mainClient.agent.prompt`；未选模型时拦截并提示 |
| `abort()` / `retry()` / `regenerate()` | 对应主进程 IPC |
| `recallLastMessage()` | 回收末条失败 user 消息回填输入框（`prefillText`） |
| `applyEvent(sessionId, event, error)` | 核心事件分发（定位容器 + 惰性初始化，委托 `chat-events.ts` 纯函数） |
| `jumpToMessage(messageId)` | 搜索跳转：已加载窗口内发定位信号，否则加载含目标的窗口 |
| `updateCompress(session)` | main 压缩成功后经 onSessionUpdate 同步当前会话容器的压缩分界元信息 |
| `forkFromMessage(userMessageId)` | 从某 user 消息复制历史开新分支 |
| `removeSessionState(sessionId)` | 删除会话后清理容器防内存泄漏 |

### 3.2 chat-events.ts（事件纯函数）

- **路径**：[store/chat-events.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/chat-events.ts)
- **职责**：定义 `SessionChatState`/`ToolStatus` 数据结构，提供 `applyChatEvent`（事件分发表）与 `mergeTranscript`（agent_end 权威列表合并）两个**纯函数**。

**事件分发表**：
- `agent_start` → isBusy=true、error=null；
- `message_start` → 推入新消息（仅 assistant/toolResult；user 已由 send 乐观加入）；
- `message_update` / `message_end` → **就地替换列表末条同 role 消息**（流式更新/finalize 共用，timestamp 不变 → 稳定 key 不变 → 增量渲染）；
- `tool_execution_start` / `tool_execution_end` → 更新 `toolStatus[toolCallId]`；
- `agent_end` → `mergeTranscript` 合并权威 transcript、isBusy=false；携带 error（真实失败，中止不携带）时写 error + `lastTurnFailed=true`。

**mergeTranscript 核心动机**：压缩会话的 Agent 内存态只含压缩保留的最近消息，agent_end 推来的 transcript 被裁剪；直接全量替换会让压缩前的旧消息从界面消失。算法以「窗口内首个与 transcript 有签名交集（role::timestamp::toolCallId）的消息」为重合点，保留其前旧消息、拼接 transcript 重合点后的内容；完全无交集时退化直接用 transcript。同时适配分页窗口（只替换尾部，保留更早的分页历史）。

### 3.3 useSessionStore

- **路径**：[store/useSessionStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useSessionStore.ts)
- **store 名**：`session`
- **职责**：会话列表 CRUD + 当前会话管理；切换会话联动 `useChatStore`。

**State**：`sessions`、`currentSessionId`、`hasInitialized`（区分「首次启动需初始化」与「ChatView remount 保持原状」，避免 /settings↔/chat 往返破坏临时态）。

**Actions**：`load`、`createSession`、`startNewChat`（临时态，不写库）、`select(id)`（不 touch 排序）、`renameSession`（touch 置顶）、`setPinned`/`setArchived`、`deleteSession`（删当前则切下一个或进临时态）、`refreshSession`、`upsertSession`（main 推送标题更新用）。

### 3.4 useModelConfigsStore

- **路径**：[store/useModelConfigsStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useModelConfigsStore.ts)
- **store 名**：`modelConfigs`
- **职责**：模型配置管理（用户添加的 `model_configs` + 预置服务商元数据 + 「上次使用模型」）。**加密 key 永不进入渲染进程**——只接触脱敏的 `ModelConfigSummary`（含 `hasApiKey` 布尔）。

**State**：`configs`、`presetProviders`、`lastUsedModel`（读 `settings.defaultModel`，语义为「上次使用模型」）。

**Actions**：`load`、`loadPresetProviders`、`listPresetModels(providerId)`、`listPresetModelsOnline(providerId, apiKey)`（在线拉取解决 catalog 滞后）、`create(input, apiKey?)`、`update(id, patch)`（apiKey: string=覆盖/null=清除/undefined=不动）、`remove(id)`、`test(id)`、`loadLastUsed`、`setLastUsed(key)`。

**Getters**：`hasModel`（启动引导用）、`findConfig(key)`、`defaultModelKey()`（**不做「首个 config」自动回退**——模型必须由用户显式选择，新会话仅沿用上次使用）。

### 3.5 useSettingsStore

- **路径**：[store/useSettingsStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useSettingsStore.ts)
- **store 名**：`settings`
- **职责**：默认系统提示 / 上次使用思考级别 / 最大轮次 / 工具开关 / 网页搜索 / 技能 / 记忆 / 自动压缩 / 托盘与标题栏。

**State**：`defaultSystemPrompt`、`lastUsedThinkingLevel`（上次使用思考级别，新建会话继承，与模型 lastUsed 语义一致）、`maxTurnsPerRun`、`tools`（ToolInfo[]）、`webSearchKeyConfigured`（明文 key 不进 renderer）、`findSkillSource`、`installedSkills`、`memoryEnabled`、`skillsEnabled`、`autoCompressEnabled/Threshold`、`closeToTray`、`titleBarMode`。导出 `THINKING_LEVEL_OPTIONS`（off→max 七档）。

**关键**：大多数保存动作后调 `evictCurrentAgent()` 驱逐当前会话内存 Agent，使新设置下一轮生效（自动压缩/最大轮次/托盘/标题栏等 main 侧实时读取的除外）；非法值（思考级别、轮次、压缩阈值）拒绝写库。

### 3.6 usePermissionStore

- **路径**：[store/usePermissionStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/usePermissionStore.ts)
- **store 名**：`permission`
- **职责**：危险工具权限确认队列。`pending: PermissionRequest[]`；`enqueue`（AgentEventService 入队）、`dequeue`、`current`（队首）。

### 3.7 useThemeStore

- **路径**：[store/useThemeStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useThemeStore.ts)
- **store 名**：`theme`
- **职责**：主题模式（light/dark/auto），在 `<html>` 上切换 `.dark` 类，联动 Naive UI 与 markdown 主题。

**关键设计**：纯 renderer 关注点，`localStorage` 持久化（key `app.theme`，同步读取防 FOUC）；`isDark = mode==='dark' || (auto && systemDark)`；auto 模式经 `matchMedia` 监听系统外观；`syncWindowBackground` 同步主进程窗口底色（`#ffffff`/`#18181b`，防 resize 露白）。main.ts 中 mount 前调用一次同步应用。

### 3.8 useWindowStore

- **路径**：[store/useWindowStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useWindowStore.ts)
- **store 名**：`window`
- **职责**：持有 reactive `WindowState`（isMaximized/isMinimized/isFullScreen/isAlwaysOnTop/isFocused/isNativeTitleBar）。store 构造时经 `mainClient.window.initWindow()` 初始化，之后由 `UiService.windowStateChange` 增量更新。

---

## 4. 文件详解

### 4.1 入口与根组件

#### [index.html](file:///Users/hupengfei/Documents/my-app/src/renderer/index.html)
HTML 外壳。CSP meta；`<div id="app">`；加载 `/src/main.ts`。

#### [main.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/main.ts)
应用引导。注册 markstream echarts 覆盖；`createPinia()`；mount 前同步应用主题；挂载。

#### [App.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/App.vue)
根组件。Provider 链（`NConfigProvider` → `NMessageProvider` → `NDialogProvider` → `ToastBridge` + router-view）。`themeOverrides` 按 isDark 切换：共享品牌覆盖（主色紫罗兰 `#7c3aed`、8px 圆角、Inter 字体族）+ 深色专属 surface 覆盖（bodyColor `#18181b`、cardColor `#1f1f23` 等，与 base.css token 对齐）。监听 `TRAY_ACTION_EVENT`（托盘动作导航）。

#### [env.d.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/env.d.ts)
`vite/client` 模块声明。

### 4.2 路由与 IPC 层

#### [router/index.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/router/index.ts)
hash 路由，`DefaultLayout` 包裹 `/chat` 与 `/settings` 子路由（懒加载）；`afterEach` 设 document.title。

#### [service/index.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/service/index.ts)
注册 `UiService` + `AgentEventService`（见 [第 2 节](#2-应用架构)）。

#### [service/ui-service.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/service/ui-service.ts)
namespace `ui`：`showToast`、`windowStateChange`、`trayAction`（CustomEvent 解耦，导出 `TRAY_ACTION_EVENT`）。

#### [service/agent-event-service.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/service/agent-event-service.ts)
namespace `agentEvent`：`onEvent(payload)` —— 所有会话事件路由到对应 useChatStore 容器；**流式限频**——当前会话 `message_update` 走 rAF 缓冲（本地大模型每秒数百条，同一帧只保留最新一条），`message_end/agent_end/tool_*` 等权威事件前强制 flush；后台会话直接 apply（不触发渲染）。`onPermissionRequest`、`onSessionUpdate`。

#### [utils/main-client.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/utils/main-client.ts)
`mainClient = createIpcRendererClient<IpcMainServices>()`。

### 4.3 布局

#### [layouts/DefaultLayout.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/layouts/DefaultLayout.vue)
纯承载 `<router-view />`（标题栏已迁至主进程独立 WebContentsView）。**权限确认弹窗挂在此全局布局**：无论聊天页/设置页，权限请求都能及时展示，避免「在设置页时请求只入队不展示、Agent 静默挂起」。

### 4.4 视图（Views）

#### [views/ChatView.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/views/ChatView.vue)
聊天主视图。

- 挂 `<SessionSidebar />` + 右侧主区（权限确认弹窗已移至全局 DefaultLayout）。
- `onMounted`：并行加载 `modelConfigs.load/loadLastUsed` + `settingsStore.loadSettings` + `sessionStore.load`；首次初始化（`!hasInitialized`）时回到最近会话或 `startNewChat`；注册全局快捷键 `Cmd/Ctrl+N` 新建会话。
- 未添加模型时显示引导页（跳 /settings）。
- `watch(chatStore.error)` → 全局 message 弹 `friendlyError`（映射 401/429/network/aborted 为友好文案）+ `clearError`。
- 失败操作条：`!isBusy && lastTurnFailed` 时显示「重试 / 编辑」条。
- `<MessageList :messages :is-busy :compress-last-index :compress-summary @send @regenerate />` + `<ChatInput :is-busy @send @abort />`；主区 `max-width: 960px` 居中。

#### [views/SettingsView.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/views/SettingsView.vue)
设置页。左侧 8 类导航（通用 / 模型 / 用量 / 工具 / 技能 / 记忆 / MCP / 数据与诊断）+ 右侧内容区。

- `onMounted`：并行加载 settings、modelConfigs、回收站计数、开机自启、诊断目录、版本号。
- 通用页：主题、开机自启、关闭到托盘、窗口置顶、标题栏模式、最大轮次与压缩阈值（本地草稿 + 失焦提交）。
- 模型页：模型列表增删改（AddModelDialog）。
- 各功能面板按 `activeTab` 以 `v-show` 切换（常驻挂载，UsagePanel 依赖 `active` prop 触发刷新）。

### 4.5 组件（Components）

#### chat/

| 组件 | 职责 |
|---|---|
| `chat/ChatInput.vue` | 输入区：文本框 + 附件（拖拽/粘贴/选择）+ 技能多选 chips + 模型选择器 + 思考级别选择器 + 发送/中止；图片受模型多模态能力约束 |
| `chat/MessageList.vue` | 消息列表：稳定 key + 粘底滚动（isBusy 时 smooth）+ toolResult 并入工具卡 + 顶部哨兵自动加载历史 + 搜索跳转定位/高亮 + 压缩分界卡片（`compressLastIndex` 后渲染 CompressDivider）+ 空会话欢迎页 |
| `chat/MessageItem.vue` | 单条消息行：user/assistant 左右分离（user 右气泡，assistant 左全宽）；拆解 thinking/toolCall/text（流式 `final` 标记）；孤儿 toolResult 结果卡；失败标记行（空内容 + finishReason=error → 错误提示卡）；悬停操作条（时间/复制/分支/重生成） |
| `chat/CompressDivider.vue` | 压缩分界卡片：「以上 N 条已压缩为摘要」，点击展开显示摘要全文 |
| `chat/ToolCallCard.vue` | 工具调用卡片：工具名 + AI 意图说明 + 状态 + 结果摘要；展开分「参数」「结果」两区（NCode 懒渲染 + JSON pretty） |
| `chat/ReasoningBlock.vue` | 思考过程块：流式中自动展开滚动，结束自动收起；纯文本展示防注入 |
| `chat/EChartsBlock.vue` | markstream 语言级覆盖：```echarts 围栏 → ECharts 图表（跟随主题 dark 重建，流式/不可解析回退源码） |
| `chat/UserImageBlock.vue` | 用户消息图片：base64 直接显示 / `file:` 引用经 IPC 读盘（模块级缓存），点击全屏预览 |
| `chat/UserFileBlock.vue` | 用户消息文件内容块：折叠卡片，展开显示解析文本 |
| `chat/UserSkillBlock.vue` | 用户消息技能块：技能名卡片，展开查看 SKILL.md 全文 |

#### settings/

| 组件 | 职责 |
|---|---|
| `settings/AddModelDialog.vue` | 添加/编辑模型弹窗：预置（catalog 选择 + 在线拉取）或自定义（API 格式/Base URL）；高级配置含多模态/推理/上下文/输出上限/自定义定价；测试连接 |
| `settings/McpPanel.vue` | 「MCP」页容器，装配 McpServersCard |
| `settings/McpServerDialog.vue` | MCP server 新增/编辑弹窗：stdio（命令+参数+环境变量）或 HTTP/SSE（URL），测试连接 |
| `settings/McpServersCard.vue` | MCP 服务器卡片：列表（传输/启停/连接状态/工具数）、增删改、启停与测试 |
| `settings/MemoryPanel.vue` | 记忆页：总开关 + 记忆工具开关 + 手动添加/搜索/编辑/删除/清空记忆条目 |
| `settings/SkillsPanel.vue` | 技能页：技能总开关 + FindSkillCard + 技能工具开关 + InstalledSkillsCard |
| `settings/SystemPromptEditor.vue` | 系统提示编辑器：本地草稿 + placeholder 展示内置默认全文，保存/恢复默认 |
| `settings/ToolSwitches.vue` | 通用工具开关列表（工具/技能/记忆三面板复用） |
| `settings/ToolsPanel.vue` | 工具页：通用工具开关 + bash 白名单查看/移除 + WebSearchCard |
| `settings/UsagePanel.vue` | 用量统计：时间范围、汇总卡片、ECharts 每日趋势堆叠柱、按模型分布条形图 |
| `settings/WebSearchCard.vue` | 网页搜索（Tavily）：启用开关 + API Key 保存/清除/测试（Key 加密存 main） |
| `settings/FindSkillCard.vue` | 技能搜索：启用开关 + 数据源切换（字节/腾讯）+ 测试连接 + 官网入口 |
| `settings/InstalledSkillsCard.vue` | 已安装技能列表：启停/卸载/打开目录，展示来源/版本/下载数 |

#### sidebar/

| 组件 | 职责 |
|---|---|
| `sidebar/SessionSidebar.vue` | 左侧会话侧栏：搜索（标题过滤 + 消息全文搜索防抖，命中跳转定位）、新建对话（临时态）、置顶/日期/归档分组、底部主题切换/压缩历史/设置/关于入口、重命名弹窗、压缩确认弹窗 |
| `sidebar/SessionItem.vue` | 单条会话行：图标 + 标题 + 置顶标记 + 状态点（busy 脉冲/error 红点）+ 相对时间 + 三点菜单（置顶/归档/导出 MD\|JSON/重命名/删除） |

#### permission/ 与全局

| 组件 | 职责 |
|---|---|
| `permission/PermissionDialog.vue` | 危险工具权限确认弹窗：工具名 + 参数 NCode；拒绝/允许一次/本次会话/总是允许（仅 bash 且非破坏性命令）；关闭视作拒绝；破坏性命令警示 |
| `AboutDialog.vue` | 关于弹窗：产品简介 + 技术栈 + 关键能力标签 + 版本号（经 `app.getAppVersion` 实时获取） |
| `ToastBridge.vue` | 在 Provider 子树内捕获 `useMessage()` 并 `registerToast` 到 `utils/toast`，供非组件上下文使用 |

### 4.6 Composables

| 文件 | 职责 |
|---|---|
| `composables/useAttachments.ts` | 附件收集：图片（dataURL/base64，受模型多模态约束）、文档（经 main 解析为文本）、纯文本；拖拽/粘贴/选择三入口 + 剪贴板截图兜底；大小上限与主进程一致 |
| `composables/useCopy.ts` | 剪贴板复制 + Naive message 反馈 |
| `composables/useStableMessageKeys.ts` | 为无稳定 id 的 AgentMessage 生成稳定 key：signature = role::timestamp::toolCallId，流式期间末条替换签名不变 → key 不变 → markstream 增量渲染；含流式热路径优化（前缀引用比较，仅重映射末条） |

### 4.7 Utils

| 文件 | 职责 |
|---|---|
| `utils/main-client.ts` | `createIpcRendererClient<IpcMainServices>()` IPC 客户端单例 |
| `utils/messageText.ts` | 消息 block 判别与文本提取：`FileTextBlock`/`SkillTextBlock` + 守卫 + `extractUserText`（排除文件/技能块） |
| `utils/toolResult.ts` | 工具结果/参数摘要：`summarizeToolResult`（退出码/字节/条数，失败显首行）、`summarizeToolArgs`（reason 缺失时从关键参数推导意图） |
| `utils/highlight.ts` | highlight.js 按需注册 8 种语言导出单例 + `tryPrettyJSON` |
| `utils/toast.ts` | 全局 toast：`registerToast` 由 ToastBridge 注册，`showToast` 供 UiService IPC 使用（API 未就绪时降级 console） |
| `utils/format.ts` | `formatContextWindow`（2 的幂次按 1024 换算、整千按 1000、1M 附近统一「1M」）、`formatTokens`（千分位）、`formatCompactTokens`（图表轴）、`formatCost`（¥ 自适应小数位） |

### 4.8 Assets

| 文件 | 要点 |
|---|---|
| `assets/base.css` | 全站 CSS 变量 token 体系（详见 [第 7 节](#7-样式与主题)） |
| `assets/main.css` | 引入 base.css；body overflow hidden + user-select none（桌面应用感），code 行内样式，`#app` 撑满视口 |

### 4.9 自定义标题栏（header）

- **路径**：[src/renderer/header/](file:///Users/hupengfei/Documents/my-app/src/renderer/header)（index.html / index.css / index.ts）
- **机制**：主进程 `BaseWindow` 上独立 WebContentsView（高 32px，与主进程 `HEADER_HEIGHT` 一致），弹窗永远无法遮盖。
- **实现**：不引入 Vue/Pinia/Naive UI，纯 TS 轻量实现。主题从 `localStorage('app.theme')` 读取并给 `<html>` 落 `.dark`（与 useThemeStore 同规则，监听 storage 事件同步）；注册 `HeaderUiService`（namespace `ui`，只消费 `windowStateChange`）+ `NoopAgentEventService`（空实现防广播报错）；按钮点击 → `mainClient.window.triggerWindowAction(...)`；`render(state)` 按窗口状态切换 html class（`win-max/win-focused/win-on-top/win-native`）。

---

## 5. 聊天流式与渲染深入

### 一轮对话完整流程

1. **用户输入**：[ChatInput.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/components/chat/ChatInput.vue) 的 NInput textarea。Enter（或 Cmd/Ctrl+Enter）触发 `send` → `chatStore.send(text, attachments, skills)`。
2. **send 流程**（`useChatStore.send`）：
   - 临时态（`currentSessionId===null`）：先置虚拟容器 `isBusy=true` 上锁（防 await 期间二次发送产生重复会话）→ `sessionStore.createSession({model})` → 虚拟容器整体迁移为新会话容器（`hydrated=true`，免重载 DB）。
   - 组装 user 消息块：正文 text → 技能块（`skill_name`）→ 文件内容块（`file_name`）→ 图片 ImageContent，乐观 push。
   - `isBusy=true`、`error=null`、`lastTurnFailed=false`。
   - `await mainClient.agent.prompt(sessionId, text, images?, files?, skills?)`（主进程跑 Agent，流式事件经 `AgentEventService.onEvent` 回推）。
3. **事件回流**（`AgentEventService.onEvent` → `chat.applyEvent(sessionId, event)` → `applyChatEvent` 纯函数）：

| 事件 | 处理 |
|---|---|
| `agent_start` | isBusy=true、error=null |
| `message_start` | 推入新消息（assistant/toolResult） |
| `message_update` / `message_end` | 就地替换末条同 role 消息（流式 token 增量 / finalize） |
| `tool_execution_start` / `tool_execution_end` | 更新 `toolStatus[toolCallId]`（running/completed/error） |
| `agent_end` | `mergeTranscript` 合并权威 transcript（兼容压缩裁剪 + 分页窗口）、isBusy=false；有 error → lastTurnFailed=true。主进程在「失败但未产出内容」时补失败标记行（finishReason=error），重读库后 MessageItem 渲染错误提示卡并恢复重试条 |

4. **渲染链**：
   - `MessageList` 接 `:messages` + `:is-busy`；`useStableMessageKeys` 生成稳定 key。
   - `MessageItem` 按 role 分支渲染：user 右侧气泡；assistant 左侧全宽（text → markstream、thinking → ReasoningBlock、toolCall → ToolCallCard）；toolResult 独立结果卡。

### 流式限频（AgentEventService）

本地大模型每秒可产生数百条 `message_update`，逐条应用会超出 60fps 渲染上限。当前会话的 `message_update` 走 **rAF 缓冲**：同一帧只保留最新一条，`message_end/agent_end/tool_*` 等权威事件前强制 flush（保证顺序与终态）。后台会话直接 apply（不触发渲染）。

### 稳定 key 机制（useStableMessageKeys）

pi-ai 的 Message 无稳定 id，仅有 timestamp（可能重复）/ toolCallId（toolResult）。直接用数组索引作 key 会在流式更新/全量替换时导致组件重挂载，使 markstream 无法做增量 diff。

**解决方案**：`signature = role::timestamp::toolCallId`，配合 `Map<signature, id>` 记忆表。流式 `message_update` 就地替换末条同 role（timestamp 不变 → signature 不变 → key 不变 → Vue 仅 patch content prop → markstream 增量渲染而非重挂载）。含流式热路径优化：前缀引用比较，仅重映射末条（O(n) 引用比较）。

### 自动滚动（vue-stick-to-bottom）

- `useStickToBottom({ resize:'instant', initial:'instant' })`：库在 contentRef 挂 ResizeObserver，任何异步高度变化（流式 token、markdown 重排、代码高亮、图片加载）在 `isAtBottom` 时自动重新滚底。
- `watch(isBusy)` → `setOptions({ resize: busy?'smooth':'instant' })`：生成中平滑弹簧跟随流式 token；空闲时即时，杜绝首屏/切会话时的滚动动画。
- 用户消息追加时强制 `scrollToBottom('instant')`；用户上滚离开底部时浮出「回到底部」按钮；`overflow-anchor: none` 关闭浏览器原生滚动锚定。

### 流式 Markdown

`MessageItem.isStreaming` = 末条消息 + isBusy + 末 block 为 text。据此给末条 text block 传 `final=false`（流式态，markstream 走流式增量渲染），其余 text block 传 `final=true`（终态稳定渲染）。`code-block-props` 启用代码块复制按钮与头部。markstream-vue 自带 `.dark .markstream-vue` 覆盖据 `<html>.dark` 翻转 markdown 暗色。

---

## 6. 会话与设置 UX 深入

### 会话侧栏（SessionSidebar）

- **临时空对话（ephemeral）**：「新建对话」调 `sessionStore.startNewChat` → `currentSessionId=null` + `chatStore.enterEphemeral()`（清空当前视图，不写库）。首条消息发送时由 `chatStore.send` 落库创建会话行并把虚拟容器整体迁移。`hasInitialized` 标志区分「首次启动需初始化」与「ChatView remount 保持原状」，避免 /settings↔/chat 往返破坏用户主动进入的临时态。
- **分组与搜索**：置顶组 / 日期分组（今天/昨天/7天内/30天内/更早）/ 归档组；搜索支持标题过滤 + 消息全文搜索（防抖，命中消息 `jumpToMessage` 滚动定位 + 高亮）。
- **重命名/删除/导出菜单**：每项 hover 显示 ⋯ NDropdown（置顶/归档/导出 MD|JSON/重命名/删除）；重命名弹 NModal；删除弹确认（删当前则切下一个或 startNewChat）；导出经 main `exportSession` 弹系统保存对话框。
- **压缩历史**：底部 ArchiveOutline 按钮，压缩确认弹窗展示上下文占用（`getSessionContextUsage`），确认后调 `mainClient.agent.compressSession` + 重载。压缩成功后 main 推送 `onSessionUpdate` → `updateCompress` 同步分界元信息，MessageList 在 `compressLastIndex` 对应消息后渲染「以上 N 条已压缩为摘要」分界卡片（点击展开摘要全文）。
- **底部入口**：主题切换 / 压缩历史 / 设置（路由 /settings）/ 关于（AboutDialog）。
- **currentSessionId 双端同步**：`useChatStore.currentSessionId` 与 `useSessionStore.currentSessionId` 始终同步（侧栏高亮读前者，事件过滤读后者）。

### 设置视图（SettingsView）

- **模型配置管理**：列表展示 displayName + 来源 NTag + 多模态/推理 NTag + modelId + 上下文 + maxTokens + hasApiKey NTag；编辑/删除；「添加模型」打开 AddModelDialog（preset/custom 双模式 + 高级配置 + 自定义定价 + 测试连接 + 在线拉取模型列表）。Key 加密保存于主进程，渲染进程只接触 `ModelConfigSummary`。
- **用量统计**：UsagePanel 经 `db.getUsageStats(rangeDays)`（7/30/全部）展示汇总 + ECharts 每日趋势堆叠柱 + 按模型分布。
- **技能 / 记忆 / MCP**：SkillsPanel（总开关 + 搜索数据源 + 已安装列表）、MemoryPanel（总开关 + 记忆条目管理）、McpPanel（server 列表 + 增删改 + 启停 + 测试）。
- **数据与诊断**：回收站清空、日志/崩溃目录打开与日志清空、版本号。

---

## 7. 样式与主题

### CSS 架构（base.css + main.css）

**token 体系**（`:root` 浅色 / `:root.dark` 深色）：设计取向「中性 zinc 灰阶 + 紫罗兰强调色」，暗色对标代码编辑器（VS Code / One Dark / Tokyo Night）中性炭灰底。

| token 分组 | 示例 |
|---|---|
| 背景层级 | `--bg`（深色 `#18181b`）/ `--bg-soft` / `--bg-mute` |
| 边框 | `--border` / `--border-soft` |
| 文字 | `--text-1`（主）/ `--text-2`（次）/ `--text-3`（弱） |
| 主题色 | `--primary`（浅 `#7c3aed` / 深 `#a78bfa`）+ hover/pressed/soft |
| 语义色 | success/warning/error 及 -soft |
| 代码 | `--code-bg` / `--code-border` |
| 阴影/圆角 | `--shadow-sm/md`、`--radius` 8px / `--radius-lg` 12px |
| 消息行 | `--user-msg-bg` / `--hover-bg` / `--msg-max-width` 768px / `--avatar-size` 30px / `--row-gap` 22px |

兼容旧引用：`--color-background` 等间接 var 引用新 token，自动翻转。

- 深色模式在 `<html>` 加 `.dark` 类生效（由 `useThemeStore` 同步切换）。
- 全局 reset、body 字体 Inter、`text-rendering: optimizeLegibility` + `-webkit-font-smoothing`。
- 滚动条归一化（`scrollbar-width: thin` + webkit 8px 圆角半透明 thumb）。
- `main.css`：body `overflow:hidden` + `user-select:none` + 纯色底；`#app` 100vh/100vw。

### 主题 store（useThemeStore）

- 三模式 `light` / `dark` / `auto`（默认 auto）；`localStorage` 持久化（`STORAGE_KEY='app.theme'`）。
- `isDark = mode==='dark' || (mode==='auto' && systemDark)`；`apply()` 切换 `<html>.dark`；`syncWindowBackground` 同步主进程窗口底色。
- main.ts 在 mount 前同步调用，首屏即落 `.dark`。

### Naive UI 主题集成（App.vue）

- `NConfigProvider :theme="isDark ? darkTheme : null"` 联动组件深色。
- `themeOverrides.common`：浅色 brand（主色 `#7c3aed` + 8px 圆角 + Inter 字体族）；深色 darkSurface（主色提亮 `#a78bfa`，表面色/文字色/边框对齐 base.css zinc token）。
- markstream-vue 自带 `.dark .markstream-vue` 覆盖据 `<html>.dark` 翻转 markdown 暗色。

### 自定义标题栏（header/index.css）

32px 高度、`-webkit-app-region: drag` 拖拽区（按钮区 no-drag）；`win-native`（macOS 原生红绿灯模式）隐藏品牌与自绘按钮；`win-on-top` 置顶高亮 pin 按钮；`win-max` 切换最大化/还原图标；失焦降透明度。

---

## 8. 关键设计速查

| 设计 | 要点 |
|---|---|
| **多会话容器** | `sessions: Record<sessionId, SessionChatState>`，后台会话事件照常更新；`current` 视图代理 + 虚拟 `__ephemeral__` 容器 |
| **临时空对话（ephemeral）** | `currentSessionId=null` 时不写库，首条消息发送时落库并整体迁移容器；`hasInitialized` 防 remount 破坏临时态 |
| **currentSessionId 双端同步** | `useChatStore.currentSessionId` 与 `useSessionStore.currentSessionId` 始终同步 |
| **流式限频** | 当前会话 `message_update` rAF 缓冲（同帧只留最新），权威事件前强制 flush |
| **稳定 key 渲染** | `signature = role::timestamp::toolCallId` + 记忆表，流式更新就地 patch 而非重挂载 |
| **transcript 合并** | `mergeTranscript` 以签名交集为重合点合并权威 transcript，兼容压缩裁剪 + 分页窗口 |
| **流式 Markdown** | 末条 text block `final=false` 走增量渲染，其余 `final=true` 终态渲染；echarts 语言级覆盖 |
| **粘底滚动** | ResizeObserver 驱动；生成中平滑、空闲即时；用户消息追加强制滚底 |
| **失败态推导** | `lastTurnFailed` 从历史推导（不重置），错误提示跨页面/重载持久；主进程补失败标记行（finishReason=error）恢复重试入口 |
| **压缩分界 UI** | chatStore 持有 compressLastIndex/compressSummary；onSessionUpdate 同步；MessageList 渲染 CompressDivider（展开查看摘要） |
| **模型独立** | 每会话独立模型（`session.model`）；切换模型驱逐内存 Agent，下一轮生效；思考级别实时同步无需驱逐 |
| **Key 安全** | 渲染进程只接触 `ModelConfigSummary.hasApiKey` 布尔，明文 key 永不进渲染进程 |
| **主题无 FOUC** | mount 前 `useThemeStore(pinia)` 同步落 `.dark`；Naive UI `NConfigProvider` 联动 |
| **设置即生效** | 所有设置 save 后驱逐当前 Agent，新设置下一轮生效 |
| **权限回路** | `onPermissionRequest` 推送 → 全局弹框（DefaultLayout）→ `respondPermission` → 解除 pending，关闭视为拒绝；请求 60s 超时自动拒绝（main 侧兜底） |
