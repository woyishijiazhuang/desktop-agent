# 工作区（Workspace）架构设计

> 状态：设计稿（待评审）→ **已实现（P0~P7 完成，2026-08-30）**
> 目标：将"全局单窗口 + 全局 workdir + 全局会话"的架构，重构为"多工作区多窗口 + 每窗口绑定 workdir + 会话按工作区分隔 + 项目记忆 agent.md"

> 实现进度：P0 数据层 ✅ / P1 窗口泛化 ✅ / P2 IPC 作用域 ✅ / P3 workdir 链路 ✅ /
> P4 记忆系统 ✅ / P5 设置独立窗口 ✅ / P6 渲染层 ✅ / P7 类型检查 + 构建验证 ✅
> 与设计的差异说明：
> - IPC 作用域改为「作用域方法内部经 useIpcMainContext 解析 sender → workdir」（ipc-scope.ts），未改库的分发层；
> - 设置项变更驱逐策略由「当前会话」改为「全部会话」（设置独立窗口无当前会话概念）；
> - 回收站（countTrashSessions/purgeTrash）保持全局（设置窗口内管理，跨工作区汇总）。

---

## 1. 背景与目标

当前架构中，`workDir` 是全局设置（settings 表 `agent.workdir`），所有会话混在一个列表里，记忆也是全局单层。当一个用户同时在多个项目上工作时，会话、工作目录、记忆全部互相污染。

本次重构的目标：

1. **工作区多开**：一个工作区 = 一个 workdir + 一个应用窗口，多个工作区可同时打开。
2. **会话按工作区隔离**：每个窗口侧边栏只显示该 workdir 下的会话。
3. **设置独立窗口**：设置页从主窗口路由中拆出为独立窗口，全局设置共享。
4. **项目记忆 agent.md**：每个 workdir 维护一个 `agent.md` 作为项目记忆；现有 memories 表保留为**全局个人记忆**（跨工作区共享）。

已确认的设计决策：

| 决策点 | 结论 |
|---|---|
| 设置作用域 | 全局共享（模型/密钥/技能/MCP/权限等），工作区只隔离会话与 workdir |
| 工作区管理入口 | 设置窗口集中管理（新建/打开/删除/编辑 agent.md） |
| 关闭窗口语义 | 仅关闭窗口，保留工作区与会话；删除工作区需在设置中显式操作 |
| 项目记忆 | `{workdir}/agent.md` 文件，随项目存储、可 git 版本化 |
| 全局记忆 | memories 表保留为个人记忆，跨工作区共享注入 |

---

## 2. 核心概念

### 2.1 工作区（Workspace）

- 一个工作区以 **workdir 绝对路径**为唯一标识。
- 每个工作区拥有：一个应用窗口（BaseWindow + 双 WebContentsView）、一组会话（sessions.workdir = 该路径）、一个 `agent.md` 文件。
- 工作区元数据持久化在新增的 `workspaces` 表；会话归属在 `sessions.workdir` 列；agent.md 是磁盘文件，不落库。

### 2.2 窗口类型

| 类型 | 数量 | 说明 |
|---|---|---|
| 工作区窗口 | 0..N | 每个绑定一个 workdir，展示 ChatView |
| 设置窗口 | 0..1 | 全局设置 + 工作区管理，展示 SettingsView |

同一 workdir 只允许一个窗口；打开已存在的工作区时聚焦其窗口。

---

## 3. 数据层设计

### 3.1 新增 `workspaces` 表

`src/main/database/schema.ts` 增加 DDL：

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  workdir TEXT PRIMARY KEY,        -- 绝对路径，工作区唯一标识
  name TEXT NOT NULL,              -- 显示名（默认取目录 basename，可重命名）
  bounds TEXT,                     -- JSON：窗口位置/尺寸记忆
  last_opened_at INTEGER NOT NULL, -- 用于启动时恢复顺序
  created_at INTEGER NOT NULL
) STRICT;
```

新建 `src/main/database/workspaces.ts`（`createWorkspacesApi`），提供：

- `listWorkspaces()` → `{ workdir, name, bounds, lastOpenedAt, sessionCount }`
- `upsertWorkspace({ workdir, name?, bounds?, lastOpenedAt? })`
- `getWorkspace(workdir)` / `deleteWorkspace(workdir)`
- `touchWorkspace(workdir)`（刷新 last_opened_at）
- `countSessionsByWorkdir(workdir)`（供列表显示会话数）

`src/main/database/index.ts` 组装进 `db` 门面；`src/main/database/types/workspace.ts` 定义类型。

### 3.2 `sessions` 表增加 `workdir` 列

```sql
ALTER TABLE sessions ADD COLUMN workdir TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_sessions_workdir_active ON sessions(workdir, last_active_at);
```

- `Session` 类型（`src/main/database/types/session.ts`）增加 `workdir` 字段。
- `createSession` 的 `CreateSessionParams` 增加必填 `workdir`。
- 以下 API 增加 `workdir` 过滤参数：
  - `listSessionsPaged({ workdir, limit, cursor, cursorId })`
  - `searchSessions(workdir, query, ...)`
  - `listDeletedSessions(workdir, ...)` / `purgeTrash(workdir)` / `purgeExpiredDeletedSessions`（按 workdir 分组清理）
  - `getSessionContext(sessionId)` 不变量（sessionId 全局唯一），无需改。
- messages 经 `session_id` 关联，天然按工作区分隔，无需改动。

### 3.3 移除全局 workdir 设置

- `src/main/database/settings.ts` 白名单删除 `'agent.workdir'`。
- `src/main/agent/agent-service.ts` 的 `getWorkdir/setWorkdir` 移除，`pickWorkdir` 迁入工作区服务（见 §4.4）。

---

## 4. 主进程改造

### 4.1 窗口管理器多窗口化（核心）

`src/main/service/window-manager.ts` 由单窗口重构为多窗口：

```ts
type WorkspaceWindow = {
  workdir: string
  win: BaseWindow
  headerView: WebContentsView
  contentView: WebContentsView
}
workspaceWindows: Map<string, WorkspaceWindow> // key = workdir
settingsWindow: { win: BaseWindow; headerView; contentView } | null
```

新增/改造函数：

| 函数 | 说明 |
|---|---|
| `createAppWindow(kind: 'workspace' \| 'settings', opts)` | 参数化现有 BaseWindow + 双视图构建逻辑，两种窗口共用 |
| `openWorkspaceWindow(workdir, bounds?)` | 已存在则聚焦；否则创建并 `touchWorkspace` |
| `ensureWorkspaceWindow(workdir): Promise<WorkspaceWindow>` | 等价原 `ensureMainWindow`，渲染层就绪后 resolve |
| `closeWorkspaceWindow(workdir)` | 关闭窗口但保留工作区行 |
| `restoreStartupWindows()` | 启动时按 `last_opened_at` 倒序打开所有工作区窗口；无工作区则创建默认工作区（`{userData}/work`）并打开 |
| `getWorkspaceByWebContents(wc)` | 由 sender 反查 `{ workdir }`（扩展现有 `windowByWebContents` 反查表） |
| `getActiveWorkspace()` | 最近聚焦的工作区（托盘"新建对话"目标） |
| `sendToWorkspace(workdir, channel, msg)` / `broadcastToWorkspaces(...)` | 替代原 `sendToViews` 的定向/广播 |
| `recreateAllWindows()` | 标题栏模式切换时重建全部窗口，保留 bounds |

行为要点：

- 窗口位置/尺寸在 `resize`/`move` 时写回 `workspaces.bounds`。
- `close-to-tray` 逐窗口 `hide()`；`before-quit` 置 `quitting` 统一放行销毁全部窗口。
- macOS `activate`：无窗口时 `restoreStartupWindows()`。
- `src/main/index.ts` 启动顺序：`applyStoredThemeMode()` → `restoreStartupWindows()` → `createTray()` → `createAppMenu()`。

### 4.2 IPC 作用域（关键机制）

**目标**：A 工作区窗口不能读写 B 工作区的会话/文件。

**方案**：主进程以 `event.sender` 为凭据自动注入 workdir，渲染层不显式传参。

- 在 `src/main/service/index.ts` 的 `initializeIpcMainServices` 外增加一层 `withWorkspaceScope(svc, scopedMethods)` 包装：对标记为工作区作用域的方法，分发前经 `getWorkspaceByWebContents(sender)` 解析 workdir，作为额外首参注入 `method(event, workdir, ...args)`；无法解析则抛错。
- 工作区作用域的方法清单（约定）：
  - `db.*`：listSessionsPaged / searchSessions / listDeletedSessions / purgeTrash / createSession 相关
  - `agent.*`：会话级操作（send / evictSession / getSessionContext 等）
  - `bash.*`：会话级 shell 操作
- 推送事件路由（`src/main/service/render-client.ts`）：`agentEvent.*` 携带 `sessionId` → 经 `sessionWorkdirCache`（Map<sessionId, workdir>，创建/驱逐时维护）解析目标工作区 → `sendToWorkspace`；主题/模型配置等全局事件 → `broadcastToWorkspaces` + 设置窗口。
- 新增 `db.settingChanged { key }` 广播：设置变更后推送所有窗口，触发对应 store 刷新（当前各窗口独立加载、无同步机制，需补齐）。

> P2 前置 spike：确认 `electron-ipc-service` 的分发是否支持包装层拦截（方法签名 `(event, ...args)` 约定），验证 BaseWindow 多窗口下推送通道可用性。

### 4.3 workdir 解析链路（全局 → 按会话）

- 新建 `src/main/agent/workdir.ts`：`resolveAgentWorkdir()` 替换为 `resolveSessionWorkdir(sessionId)`（读 session 行 workdir，配 `Map<sessionId, workdir>` 轻量缓存，Agent 驱逐时清理）。
- `src/main/agent/agent-manager.ts` `createAgent(sessionId)`：从 session 行取 workdir，固化到 Agent 实例；系统提示词组装（`buildSystemCapabilitySections(workdir, shellKind)`）与 `buildMemorySection(workdir)`（§5）按该 workdir 生成。
- 工具侧 `src/main/agent/tools/{bash,glob,grep,download}.ts`：`buildTools({ sessionId })` 已持有 sessionId，改为 `resolveSessionWorkdir(sessionId)` 取默认 cwd/root；bash 的 `PersistentShell.run({cwd})` 与 `startBackground({cwd})` 传该 workdir。
- `BashSessionManager.defaults` 已按 sessionId 键控，天然隔离，无需改。

### 4.4 新增 `WorkspaceService`（namespace `workspace`）

在 `src/main/service/workspace-service.ts` 新增，注册进 `src/main/service/index.ts`：

| 方法 | 说明 |
|---|---|
| `list()` | 全部工作区 + 会话数 |
| `create(dir, name?)` | 校验目录 → upsert 行 → `openWorkspaceWindow` |
| `rename(workdir, name)` | |
| `open(workdir)` | 打开/聚焦窗口 |
| `close(workdir)` | 仅关窗 |
| `remove(workdir)` | 关窗 → 删除该 workdir 全部会话（messages CASCADE）→ 删行（二次确认由前端弹） |
| `pickAndCreate()` | 目录选择框（迁自 `agent-service.pickWorkdir`）→ `create` |
| `getAgentMd(workdir)` / `saveAgentMd(workdir, content)` | 读/写 `{workdir}/agent.md` |

> 渲染层 `initWindow()`（`window-service`）返回值扩展为 `{ type: 'workspace'|'settings', workdir?, name?, ...WindowState }`，供前端识别窗口身份。

### 4.5 设置独立窗口

- `openSettingsWindow()`：复用 `createAppWindow('settings')`，加载 `index.html#/settings`，单例（已存在则聚焦）。
- 托盘/菜单"打开设置"（`tray-service.ts` / `app-menu-service.ts`）由 `showMainWindowAnd('open-settings')` 改为 `openSettingsWindow()`。
- 设置窗口不绑定 workdir：全局设置在此编辑，变更经 `db.settingChanged` 广播到所有工作区窗口。
- 工作区窗口内的 `#/settings` 路由保留可访问，但不作为主入口（或不保留，由设置窗口独占）。

---

## 5. 记忆系统设计

### 5.1 两层记忆模型

| 层级 | 载体 | 作用域 | 内容 |
|---|---|---|---|
| 个人记忆（现有） | `memories` 表 + FTS | 全局，跨工作区共享 | 个人偏好、跨项目事实 |
| 项目记忆（新增） | `{workdir}/agent.md` 文件 | 单个工作区 | 项目专属上下文、约定、进展 |

两者职责清晰：**个人记忆**是"我是谁、我怎么做事"，**项目记忆**是"这个项目长什么样、有什么约定"。

### 5.2 agent.md 设计

- **位置**：`{workdir}/agent.md`，随项目存储，可 git 版本化，用户可直接编辑。
- **定位：地图而非领地**：agent.md 是"项目地图"，保持精炼，记录项目概述、技术栈、目录结构、约定、当前进展。详细内容（README、docs/、接口文档等）留在项目文件里，由 Agent 按需 `read_file` 读取——项目描述再多也不需要全部塞进 agent.md，这是解决"项目需要较多描述"的正确方式。
- **注入**：`AgentManager.buildMemorySection()` 改为 `buildMemorySection(workdir)`，读取 `{workdir}/agent.md`（存在且非空时）追加 `## 项目记忆` 段；个人记忆段 `## 长期记忆` 保持在前，两者并存。
- **注入上限（可配置）**：注入上限与文件大小无关，限制的是"每轮常驻上下文的量"。默认注入 8K 字符（`PROJECT_MEMORY_MAX_CHARS = 8192`），超限截断并追加提示"agent.md 已超出注入上限，完整内容请用 read_file 读取"。上限由设置项 `agent.agentMdInjectionChars` 配置（档位 4K/8K/16K + 自定义，沿用现有下拉模式）。128K 上下文下 8K 字符约占用 6%~10%，留足余量；完整项目上下文由 Agent 按需读取，不常驻每轮。
- **快照语义**：与现有记忆一致——Agent 首次创建时注入并固化进 `resolved_system_prompt`；agent.md 变更后当前会话沿用快照，新会话生效。Agent 更新 agent.md 后应通过 `read_file` 实时重读（在注入段的引导语中写明该约定）。
- **Agent 维护**：无需新增工具。Agent 通过现有 `read_file` / `edit_file` / `write_file` 直接读写（路径相对 workdir 解析）。
- **用户维护**：设置窗口"工作区"tab 提供 agent.md 编辑器（`workspace.getAgentMd` / `workspace.saveAgentMd`）。
- **缺失时**：不注入该段，不强制创建；新建会话时系统提示词中的工作目录段会注明"可用 agent.md 建立项目记忆"。

### 5.3 对现有记忆代码的改动

| 位置 | 改动 |
|---|---|
| `agent-manager.ts` `buildMemorySection` | 增加 workdir 参数，追加 agent.md 段（按注入上限截断） |
| `database/settings.ts` | 注册新设置 `agent.agentMdInjectionChars`（档位校验） |
| `tools/memory.ts`、`MemoryPanel.vue`、`db-service.ts` | **不改**（个人记忆维持全局） |
| `agent-service.ts` `generateWelcomeSuggestions` | 计数仍用个人记忆；可叠加"是否已建立 agent.md"提示 |

---

## 6. 渲染层改造

### 6.1 窗口身份识别

- `useWindowStore`：`initWindow()` 返回扩展后的 WindowState，保存 `windowType` / `workdir` / `workspaceName`。
- 工作区窗口标题栏（headerView）显示工作区名（目录 basename 或重命名值）。
- 设置窗口（`#/settings`）：跳过 ChatView 初始化逻辑（会话列表、模型预载等）。

### 6.2 会话作用域

- `useSessionStore` / `useChatStore`：若采用 IPC 自动注入方案，**调用签名不变**（workdir 由主进程注入），改动集中在初始化、空态（"该工作区暂无会话"）与工作区切换后的重载。
- 首次进入工作区窗口：自动选最近会话或临时空对话（逻辑不变，数据已按 workdir 过滤）。

### 6.3 设置窗口新增"工作区"tab

`SettingsView.vue` 新增 `WorkspacePanel.vue`（`components/settings/`）：

- 工作区列表：路径、名称、会话数、上次打开时间；操作：打开窗口 / 重命名 / 删除（二次确认，提示级联删除会话）。
- 新建工作区：按钮 → 系统目录选择框 → `workspace.create`。
- agent.md 编辑器：选中工作区后编辑/保存 `{workdir}/agent.md`。
- 通用 tab 中原"工作目录"配置区移除。

---

## 7. 迁移方案

启动时执行（幂等，`src/main/database/index.ts` 或独立 migration 模块）：

1. `ALTER TABLE sessions ADD COLUMN workdir`（若不存在）。
2. 读取旧 `agent.workdir` 设置（无则 `{userData}/work`），将**全部存量会话**回填该 workdir。
3. 为该 workdir 创建 `workspaces` 行。
4. 删除 `agent.workdir` 设置（不写兼容代码，遵循项目惯例）。
5. 升级前自动备份 `data.db` 到 `data.db.bak-<timestamp>`。

agent.md 不迁移（按需创建）。

---

## 8. 边界情况

| 场景 | 处理 |
|---|---|
| 首次启动、无工作区 | 自动创建默认工作区（`{userData}/work`）并打开窗口 |
| workdir 被删除/不可访问 | 窗口照常打开，`mkdirSync` 重建目录，界面提示 |
| 打开已存在工作区 | 聚焦已有窗口，不重复创建 |
| 关闭到托盘 + 多窗口 | 每窗口 close → hide；退出时销毁全部；macOS `activate` 恢复上次打开的工作区 |
| 托盘"新建对话" | 定位 `getActiveWorkspace()` 对应窗口 |
| 通知点击 | session → workdir → 聚焦对应窗口 |
| 工作区删除 | 关窗 → 级联删会话 → 删行，前端二次确认 |
| 同一 workdir 被设置窗口与聊天窗口同时操作 | agent.md 读写以"最后一次保存"为准（简单约定，不引入锁） |
| 标题栏模式切换 | `recreateAllWindows()` 重建全部窗口，设置窗口一并重建 |

---

## 9. 工作量评估

| 阶段 | 内容 | 复杂度 | 涉及主要文件 |
|---|---|---|---|
| P0 数据层 | workspaces 表 + sessions.workdir + API 过滤 + 迁移 | 小 | `database/schema.ts`、`database/sessions.ts`、`database/workspaces.ts`（新）、`database/types/*`、`database/settings.ts` |
| P1 窗口泛化 | 单窗口 → 多窗口 Map、启动恢复、bounds 持久化、多窗口重建 | 大 | `service/window-manager.ts`、`main/index.ts`、`service/window-service.ts` |
| P2 IPC 作用域 | sender → workdir 注入、事件按工作区路由、settingChanged 广播 | 大 | `service/index.ts`、`service/render-client.ts`、`service/db-service.ts`、`service/workspace-service.ts`（新） |
| P3 workdir 链路 | resolveSessionWorkdir、Agent 持 workdir、工具/提示词改造 | 中 | `agent/workdir.ts`、`agent/agent-manager.ts`、`agent/tools/*` |
| P4 记忆系统 | buildMemorySection 注入 agent.md、大小上限、agent.md 编辑器 | 中 | `agent/agent-manager.ts`、`service/workspace-service.ts`、`components/settings/WorkspacePanel.vue`（新） |
| P5 设置独立窗口 | createAppWindow 参数化、托盘/菜单入口、窗口类型识别、工作区管理 tab | 中 | `service/window-manager.ts`、`service/tray-service.ts`、`service/app-menu-service.ts`、`SettingsView.vue` |
| P6 渲染层 | 窗口身份、会话作用域、空态、设置窗口路由 | 中 | `store/useWindowStore.ts`、`store/useSessionStore.ts`、`ChatView.vue`、`router/index.ts` |
| P7 回归验证 | 老数据迁移验证、多窗口交互、Windows/Linux 回归 | 中 | — |

**总工作量：单人约 3~4 周**（P0→P3 约占 60%，为架构地基；P4/P5/P6 相对独立，可在 P1/P2 完成后并行推进）。

### 实施顺序建议

```
P0 数据层（含迁移）
  → P1 窗口泛化骨架（先单工作区跑通，再多窗口）
  → P2 spike 验证 IPC 路由 → P2/P3
  → P4 记忆（依赖 P3 的 workdir 链路）
  → P5 设置窗口（依赖 P1）
  → P6 渲染层（随 P2/P3 跟进）
  → P7 回归
```

### 主要风险

1. **electron-ipc-service 多窗口兼容**：`sendToViews` 已是自建路由，但推送通道与分发包装需在 P2 前 spike 验证（中风险）。
2. **BaseWindow 多实例 + 双视图**：窗口生命周期/事件绑定复杂度上升，需统一 `createAppWindow` 入口避免内存泄漏（中风险）。
3. **数据迁移不可逆**：升级前自动备份 `data.db`（低风险）。
4. **agent.md 体积失控**：注入上限可配置（默认 8K）+ "地图而非领地"约定（详请按需 read_file）+ 截断提示兜底（低风险）。
