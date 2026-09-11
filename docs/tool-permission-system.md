# 工具权限与确认系统

> 本文档描述桌面 AI 应用中工具调用的多层权限控制机制，覆盖门控、沙箱、计划模式、决策引擎、OS 沙箱的完整链路。

---

## 目录

1. [概览](#1-概览)
2. [五层架构总览](#2-五层架构总览)
3. [第 1 层：工具启停门控（wrapGate）](#3-第-1-层工具启停门控wrapgate)
4. [第 2 层：沙箱文件策略（wrapSandboxFsPolicy）](#4-第-2-层沙箱文件策略wrapsandboxfspolicy)
5. [第 3 层：计划模式拦截](#5-第-3-层计划模式拦截)
6. [第 4 层：危险工具权限决策引擎](#6-第-4-层危险工具权限决策引擎)
   - 6.1 [DANGEROUS_TOOLS 集合](#61-dangerous_tools-集合)
   - 6.2 [bash 命令决策（decideBash）](#62-bash-命令决策decidebash)
   - 6.3 [文件操作决策（decideFile）](#63-文件操作决策decidefile)
   - 6.4 [install_skill 处理](#64-install_skill-处理)
   - 6.5 [自动放行机制（isRunAutoAllowed）](#65-自动放行机制isrunautoallowed)
   - 6.6 [破坏性命令 deny 兜底](#66-破坏性命令-deny-兜底)
   - 6.7 [权限确认交互流程](#67-权限确认交互流程)
7. [第 5 层：bash OS 沙箱（SandboxManager）](#7-第-5-层bash-os-沙箱sandboxmanager)
8. [放行规则记录与作用域](#8-放行规则记录与作用域)
9. [子代理的权限处理](#9-子代理的权限处理)
10. [开启「跳过工具确认」后的行为](#10-开启跳过工具确认后的行为)
11. [完整决策流程图](#11-完整决策流程图)
12. [关键文件索引](#12-关键文件索引)

---

## 1. 概览

工具调用在到达执行层之前，需要经过多道检查。设计目标：

- **非危险工具**（read_file、glob、grep、web_search 等）始终免确认放行，零摩擦。
- **危险工具**（write_file、edit_file、bash、install_skill）根据命令/路径/上下文决定放行或弹出确认。
- **破坏性操作**（rm -rf、sudo、git push --force 等）无论何种设置都强制人工确认。
- **沙箱开启时**，文件读写有 OS 级边界约束，不在范围内则硬拒（不弹确认）。

---

## 2. 五层架构总览

工具调用从外到内依次经过以下检查层，任一层拦截即终止，不再进入下一层：

| 层级 | 名称 | 位置 | 职责 | 拦截方式 |
|------|------|------|------|----------|
| 1 | 工具启停门控 | `tools/index.ts` `wrapGate` | 工具是否可用（用户手动关闭 / 域总开关） | 返回「已停用」提示 |
| 2 | 沙箱文件策略 | `tools/index.ts` `wrapSandboxFsPolicy` + `sandbox.ts` | OS 级读写边界强制约束 | 抛错硬拒 |
| 3 | 计划模式拦截 | `permission.ts` | 规划阶段阻止一切危险操作 | 返回 block |
| 4 | 危险工具权限决策引擎 | `permission.ts` `createBeforeToolCallHook` | 细粒度 allow / ask / hardAsk 决策 | 返回 block 或弹确认 UI |
| 5 | bash OS 沙箱 | `sandbox.ts` `SandboxManager` | 进程级 OS 沙箱（seatbelt / bubblewrap / appcontainer） | spawn 时施加，进程级隔离 |

---

## 3. 第 1 层：工具启停门控（wrapGate）

**源码**：`src/main/agent/tools/index.ts` 第 253–283 行

每个工具在 `buildTools` 时被 `wrapGate` 包裹。执行前调用 `isToolCurrentlyEnabled(name)`（第 239–251 行），判断条件：

| 条件 | 结果 |
|------|------|
| 用户显式关闭（`overrides[name] === false`） | 停用 |
| 技能域开关关闭（`SETTING_SKILLS_ENABLED = false`） | `find_skill` / `install_skill` / `read_skill` 停用 |
| 记忆域开关关闭（`SETTING_MEMORY_ENABLED = false`） | `list_memories` / `add_memory` / `update_memory` / `delete_memory` 停用 |
| 知识库域开关关闭（`SETTING_KB_ENABLED = false`） | `search_knowledge` 停用 |
| bash 停用（`overrides['bash'] === false`） | `bash` / `bash_output` / `kill_shell` / `bash_input` 全部停用 |

被停用的工具返回固定文案提示，不执行任何内部逻辑。

**设计要点**：工具注入集合取「默认启用 或 用户曾显式开启」的并集（第 332–334 行），注入后尽量恒定（保持 LLM 前缀缓存稳定）；启停通过门控实时生效，不驱逐 Agent。

---

## 4. 第 2 层：沙箱文件策略（wrapSandboxFsPolicy）

**源码**：`src/main/agent/tools/index.ts` 第 290–324 行 + `src/main/agent/runtime/sandbox.ts`

### 4.1 作用工具

| 分类 | 工具集 | 常量名 |
|------|--------|--------|
| 写工具 | `write_file`、`edit_file`、`download` | `FS_WRITE_TOOLS`（第 194 行） |
| 读工具 | `read_file` | `FS_READ_TOOLS`（第 196 行） |

### 4.2 拦截逻辑

- 沙箱**关闭**时：不拦截（`getSessionFsPolicy` 返回 null），工具保持原行为。
- 沙箱**开启**时：
  - **写工具**：目标路径必须在 `allowWriteRoots` 内且不在 `denyReadRoots` 内，否则抛错。
  - **读工具**：目标路径不得在 `denyReadRoots` 内，否则抛错。

### 4.3 边界构建（`getSessionFsPolicy`，sandbox.ts 第 107–119 行）

```
allowWriteRoots = 平台临时目录 ∪ 会话工作区 ∪ 用户追加的 writableRoots
denyReadRoots   = 用户 denyReadRoots 配置
```

### 4.4 路径比较（`isPathWithin`，sandbox.ts 第 79–85 行）

使用 `resolve` 归一化 + `relative` 相对路径判断，词法比较防 `..` 逃逸。

### 4.5 与权限引擎的协同

在 `createBeforeToolCallHook`（permission.ts 第 257–261 行）中，当 `write_file` / `edit_file` 命中沙箱区外写入时，**直接硬拒绝不弹确认**——避免「用户点了确认 → 执行层又硬拒」的假确认体验。

---

## 5. 第 3 层：计划模式拦截

**源码**：`src/main/agent/runtime/permission.ts` 第 235–247 行

当 `isPlanMode(sessionId) === true` 时：

- **所有危险工具**（write_file / edit_file / bash / install_skill）一律被拦截。
- **唯一例外**：bash 中命中 `READONLY_COMMANDS`（如 `ls`、`git status`）的只读简单命令在规划期放行，便于探索代码库。
- Agent 被提示「请先调用 exit_plan_mode 提交计划并获得用户批准后再执行操作」。

---

## 6. 第 4 层：危险工具权限决策引擎

**源码**：`src/main/agent/runtime/permission.ts` `createBeforeToolCallHook`（第 227–317 行）

### 6.1 DANGEROUS_TOOLS 集合

```typescript
const DANGEROUS_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'install_skill', 'mcp_call'])
```

只有这 5 个工具名进入权限判定。其余工具（read_file、list_files、glob、grep、web_search 等）**完全不经过此层**，直接放行。

### 6.2 bash 命令决策（decideBash）

**源码**：permission.ts 第 154–169 行

决策顺序（deny 优先于一切 allow）：

| 优先级 | 条件 | 决策 | 说明 |
|--------|------|------|------|
| 1 | 命中 `DENY_PATTERNS`（破坏性命令） | `ask(hardAsk=true)` | 不可被任何自动放行覆盖 |
| 2 | `isSimpleCommand` + 命中 `READONLY_COMMANDS` | `allow` | 只读安全命令免确认 |
| 3 | 命中持久白名单（`bashAllowlist`） | `allow` | 用户点过「总是允许」 |
| 4 | 命中本会话放行（`sessionBashAllow`） | `allow` | 用户点过「本会话允许」 |
| 5 | `isRunAutoAllowed` | `allow` | 计划已批准 / 语音 run / 跳过确认 |
| 6 | 其余 | `ask(soft)` | 弹确认 UI |

#### READONLY_COMMANDS（第 58–99 行）

内置约 40 条只读命令，包括：`ls`、`pwd`、`cat`、`head`、`tail`、`grep`、`find`、`git status`、`git diff`、`git log`、`git branch`、`npm --version` 等。

匹配规则：
- 必须是简单命令（不含 `;&|<>` 和 `$(` `${`）。
- 词级前缀匹配（`git status` 命中 `git status --short`，但 `lsblk` 不命中 `ls`）。

#### DENY_PATTERNS（第 106–123 行）

| 模式 | 说明 |
|------|------|
| `\brm\b.*--?[rRf]` | rm 带递归/强制选项 |
| `\brmdir\s+\/s` | Windows 递归删除目录 |
| `\bgit\s+push\b.*--force` | 强制推送 |
| `\bgit\s+reset\s+--hard` | 硬重置 |
| `\bgit\s+clean\s+-[df]*` | 清理未跟踪文件 |
| `\bgit\s+checkout\s+-f` | 强制检出 |
| `\bmkfs` | 格式化文件系统 |
| `\bsudo` | 提权操作 |
| `\bdd\b.*of=\/dev\/` | 裸盘写入 |
| `\b(reboot\|shutdown\|poweroff\|halt)\b` | 关机/重启 |
| `\bchmod\s+-R\s+777` | 递归全开权限 |
| `\bchown\s+-R` | 递归改属主 |
| `\bkill\s+-9` | 强杀进程 |
| `curl.*\|\s*(ba\|z)?sh` | 管道到 shell |

### 6.3 文件操作决策（decideFile）

**源码**：permission.ts 第 172–185 行

| 优先级 | 条件 | 决策 | 说明 |
|--------|------|------|------|
| 1 | 路径在「会话可写边界」内 | `allow` | 工作区 + 可写目录 + 系统临时目录 |
| 2 | 本会话同路径放行（`sessionFileAllow`） | `allow` | 用户点过「本会话允许」 |
| 3 | 其余 | `ask(soft)` | 弹确认 UI |

**与 bash 的差异**：文件操作**无持久白名单**（路径型 always 意义有限），仅支持会话放行。

**与沙箱的协同**：`getSessionWriteBoundary`（sandbox.ts 第 127–141 行）返回的边界与沙箱共享同一可写根，但**与沙箱开关无关**——即使沙箱关闭，工作区内写入仍然自动放行。

### 6.4 install_skill 处理

不在 `decideBash` / `decideFile` 中处理。在 `createBeforeToolCallHook` 的 else 分支（第 275–281 行）直接返回 `ask(soft)`。恒弹确认，仅本次，无会话/总是放行选项。

### 6.5 MCP 工具调用处理（mcp_call）

**源码**：permission.ts 第 268–274 行

`mcp_call` 通过元工具模式间接暴露第三方 MCP server 的工具。由于 MCP 工具是动态发现的，无法在编译期预分类安全性，因此：

- 首次调用：`ask(soft)`，弹出确认 UI，摘要显示 `server/tool`（如 `my-server/read_file`）。
- 用户点「本会话允许」后：同 `server/tool` 的后续调用自动放行。
- 无持久白名单（MCP 工具动态发现，路径 always 无意义）。

### 6.6 自动放行机制（isRunAutoAllowed）

**源码**：permission.ts 第 188–202 行

三个条件**任一生效**即免确认：

| 条件 | 说明 |
|------|------|
| `isPlanRunAutoAllow(sessionId)` | 用户批准了 exit_plan_mode 提交的计划 |
| `isVoiceAutoApprove?.()` | 语音模式无确认 UI 入口，自动放行 |
| `SETTING_PERMISSION_AUTO_APPROVE` | 全局设置「跳过工具确认」开启 |

**硬约束**：`hardAsk=true`（破坏性命令）**不受任何自动放行覆盖**（第 278–279 行，检查在 `isRunAutoAllowed` 之前）。

### 6.7 破坏性命令 deny 兜底

decision 为 `ask` 且 `hardAsk=true` 时（permission.ts 第 278–279 行）：

```typescript
if (!decision.hardAsk && isRunAutoAllowed(sessionId, isVoiceAutoApprove)) return undefined
```

即：`hardAsk` 为 true 时跳过自动放行检查，**始终强制人工确认**。这意味着：
- 即使开启了「跳过工具确认」
- 即使计划已批准
- 即使语音 run

破坏性命令永远弹确认。

### 6.8 权限确认交互流程

**源码**：permission.ts 第 282–316 行

当决策为 ask 时：

1. 通过 `beginInteraction` 创建挂起的 Promise（`kind: 'tool_permission'`）。
2. 通过 `rendererClient.agentEvent.onInteractionRequest` 推送给 renderer 展示确认 UI。
3. UI 展示工具名、一行摘要（`summarizeToolArgs`）、是否 `denyHit`。
4. 用户响应后 renderer 调用 `resolvePermission(requestId, approved, scope)`。
5. 超时或中断时按 `onTimeout` / `onAbort` 语义处理（默认拒绝）。

---

## 7. 第 5 层：bash OS 沙箱（SandboxManager）

**源码**：`src/main/agent/runtime/sandbox.ts`

当 `sandbox.enabled` 为 true 时，在 bash 命令 spawn 时通过 `createSandboxWrapper` 套入 OS 级沙箱。

### 7.1 平台后端

| 平台 | 后端 | 实现 |
|------|------|------|
| macOS | seatbelt | 系统内置 |
| Linux | bubblewrap（bwrap） | 需安装 bwrap |
| Windows | appcontainer | srt-win.exe + WFP 规则，需 UAC 供给 |

### 7.2 沙箱行为

| 维度 | 策略 |
|------|------|
| 文件系统（读） | 默认全局可读；denyRead 做减法 |
| 文件系统（写） | 仅限 allowWrite（临时目录 + 工作区 + 用户追加目录） |
| 网络 | 走 srt 域名白名单代理（默认内置 npmjs/github/pypi 等常用站点） |
| 本地回环 | 放行（开发服务器可被浏览器访问） |
| fail-closed | 沙箱开启但初始化/包装失败 → 抛错拒绝执行，绝不静默裸跑 |

### 7.3 生效边界

沙箱在「spawn 时刻」一次性施加于整个 shell 进程（含其后所有命令与子进程），已在运行的会话不追溯，重启会话（或改配置后新开会话）后生效。

---

## 8. 放行规则记录与作用域

**源码**：permission.ts 第 319–369 行

用户确认后的放行规则由 `resolvePermission` 统一处理：

| scope | 行为 | 适用范围 | 存储 |
|-------|------|----------|------|
| `once` | 仅本次放行 | 所有工具 | 内存（无需存储） |
| `session` | 本会话放行 | bash（命令词级前缀）+ write/edit（精确路径）+ mcp_call（server/tool） | `sessionBashAllow` / `sessionFileAllow` / `sessionMcpAllow` Map |
| `always` | 持久白名单 | **仅 bash 且非 hardAsk** | `settings.bashAllowlist` 持久化 |

**关键限制**：
- 文件操作不支持 `always`（路径型持久白名单意义有限）。
- `install_skill` 不支持 `session`（仅 `once`）。
- `hardAsk` 命中时不支持 `session` / `always`（deny 兜底不可白名单覆盖）。

---

## 9. 子代理的权限处理

**源码**：`src/main/agent/subagent.ts` 第 106–116 行、第 181 行

| 子代理类型 | 权限钩子 | 行为 |
|-----------|---------|------|
| **plan**（只读规划子代理） | `planReadonlyHook` | 仅放行 `READONLY_COMMANDS` 中的 bash 只读简单命令，其余全部硬拒（不走用户确认） |
| **general**（通用子代理） | 复用主会话的 `createBeforeToolCallHook` | 危险工具仍弹用户确认，与主 Agent 行为一致 |

---

## 10. 开启「跳过工具确认」后的行为

**设置 key**：`permission.autoApprove`（`SETTING_PERMISSION_AUTO_APPROVE`，默认 false）

开启后的效果汇总：

| 工具 / 场景 | 是否被跳过 | 原因 |
|-------------|-----------|------|
| bash 非破坏性命令 | 跳过确认 | `isRunAutoAllowed` → allow |
| bash 破坏性命令（rm -rf、sudo 等） | **仍然硬弹确认** | `hardAsk=true`，第 278 行显式拦截 |
| write_file / edit_file（边界内） | 本来就不弹 | `decideFile` 返回 allow |
| write_file / edit_file（边界外，沙箱关闭） | 跳过确认 | `isRunAutoAllowed` 生效 |
| write_file / edit_file（沙箱区外） | 跳过确认但仍被硬拒 | 第 2 层沙箱策略直接 block |
| install_skill | 跳过确认 | `isRunAutoAllowed` 生效 |
| mcp_call（首次） | 跳过确认 | `isRunAutoAllowed` 生效 |
| mcp_call（本会话已放行） | 本来就不弹 | 会话放行命中 |
| 计划模式下任何危险工具 | **仍然拦截** | 第 3 层在第 4 层之前就拦截了 |

**核心原则**：自动放行永远无法覆盖 `hardAsk`（破坏性命令）。

---

## 11. 完整决策流程图

```
工具调用
  │
  ├─ 第1层 wrapGate：工具是否启用？
  │   └─ 否 → 返回「已停用」提示
  │
  ├─ 第2层 wrapSandboxFsPolicy：沙箱文件策略检查
  │   ├─ 写工具 + 沙箱开启 + 路径越界 → 抛错（硬拒）
  │   ├─ 读工具 + 沙箱开启 + 命中 denyRead → 抛错（硬拒）
  │   └─ 通过或沙箱关闭 → 继续
  │
  ├─ 第3层 计划模式检查：isPlanMode？
  │   ├─ 是 + 非只读bash → 拦截，引导 exit_plan_mode
  │   └─ 否 或 只读bash → 继续
  │
  ├─ 第4层 DANGEROUS_TOOLS 检查
  │   ├─ 不在集合中 → 直接放行
  │   └─ 在集合中（write_file / edit_file / bash / install_skill / mcp_call）
  │       ├─ bash  → decideBash（deny→hardAsk / 只读→allow / 白名单→allow ...）
  │       ├─ write/edit → decideFile（边界内→allow / 会话放行→allow / ask）
  │       ├─ mcp_call → 会话放行命中→allow / ask(soft)
  │       ├─ install_skill → ask(soft)，恒弹
  │       ├─ allow → 放行
  │       ├─ ask(soft) + isRunAutoAllowed → 放行
  │       ├─ ask(hardAsk) → 始终弹确认（不可自动放行）
  │       └─ ask(soft) + 无自动放行 → 弹确认 UI
  │           ├─ 用户允许(once) → 本次放行
  │           ├─ 用户允许(session) → 记录会话放行
  │           ├─ 用户允许(always) → 记录持久白名单（仅bash）
  │           └─ 用户拒绝 / 超时 → block
  │
  └─ 第5层 bash OS 沙箱（spawn 时独立施加于进程）
```

---

## 12. 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/main/agent/runtime/permission.ts` | 权限决策引擎（核心）：`createBeforeToolCallHook`、`decideBash`、`decideFile`、`resolvePermission`、`DENY_PATTERNS`、`READONLY_COMMANDS` |
| `src/main/agent/runtime/sandbox.ts` | OS 沙箱封装 + 文件域策略：`getSessionFsPolicy`、`getSessionWriteBoundary`、`isSandboxWriteAllowed`、`SandboxManager`、`resolveSrtWin` |
| `src/main/agent/tools/index.ts` | 工具注册表 + `wrapGate`（启停门控）+ `wrapSandboxFsPolicy`（沙箱文件策略门）+ `buildTools` |
| `src/main/agent/types.ts` | 类型定义：`PermissionScope`、`InteractionKind`、`SETTING_PERMISSION_AUTO_APPROVE` 等常量 |
| `src/main/agent/runtime/interaction.ts` | 统一交互通道：`beginInteraction`、`respondInteraction`、`clearSessionInteractions` |
| `src/main/agent/runtime/plan-mode.ts` | 计划模式状态管理：`isPlanMode`、`markPlanAutoAllow` |
| `src/main/agent/agent-manager.ts` | Agent 生命周期管理，`createBeforeToolCallHook` 的调用点 |
| `src/main/agent/subagent.ts` | 子代理系统：`planReadonlyHook` + 复用主会话权限钩子 |
