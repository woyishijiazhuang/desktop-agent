# 文件撤销（File Undo）设计方案

> 目标读者：本项目维护者
> 状态：已实现（阶段 1/2/3/4 + 清理 GC；阶段 5 配额未实现，见十一）
> 范围：`write_file` / `edit_file` 两个写文件工具的文件级撤销

---

## 一、背景与目标

Agent 直接改磁盘，用户几乎没有回退手段：

- `git` 只记录**人类有意的提交**，而 agent 在人类决定「该不该留」之前就已产生大量写入；工作区甚至可能没有 `git init`。
- 编辑器本地 undo 栈是应用内、按键粒度的，对「撤销 agent 这一批改动」无意义。
- 权限确认是**预防**机制，只能拦住明确越界的操作；拦不住「权限内、任务范围内、但判断错了」的改动。这类失败模式需要的是**可逆性**。

**设计目标**

1. 对 `write_file` / `edit_file` 的每次落盘，都能回退到操作前状态；
2. 完全本地，**不依赖 git、不污染用户仓库**；
3. 不改变模型可见的上下文（不改 systemPrompt / 工具定义，不失效 LLM 前缀缓存）；
4. 宁可拒绝撤销，也不产生「账本对不上」的文件（安全闸优先于功能）。

**非目标**

- 不替代版本控制；不覆盖 `bash` 的 `rm` / `git reset --hard` 等破坏性操作（无法可靠快照，UI 需明确提示走 git）；
- 不提供模型可调用的撤销工具（见 9.1）。

---

## 二、业界做法（调研结论）

| 方案                          | 做法                                                                                      | 可借鉴点                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Claude Code                   | 修改文件前先把**原文件复制**到本地 `file-history`，提供 rewind                            | 快照发生在写盘前；按项目隔离                                                                              |
| dsh-file-undo（插件）         | 每次 write/edit 落盘前进时间线，diff 逐条审查、两阶段撤销 + 重做                          | 安全闸三件套：`external_modified` / `superseded_by_later_ops` / 乐观锁；「撤销创建」= 真删文件且校验 hash |
| AgentUndo（论文原型）         | **内容寻址**存储 + SQLite 事件时间线 + 会话归属，`au oops` 撤销最近一批写入               | blob 按内容 hash 寻址、天然去重；「撤销一个 burst」而非单次按键                                           |
| git-native 方案               | `PreToolUse` 钩子对危险操作 `git stash create` + tag，回滚 `git checkout <tag> -- <path>` | 零拷贝成本，但**依赖仓库已 git init**                                                                     |
| Anthropic text_editor（早期） | 内置 `undo_edit` 命令，模型可调用                                                         | 主流客户端后来都改为**用户触发**，不再让模型自撤销                                                        |

**结论**：主流方案已收敛为「**写盘前快照 + 用户触发撤销 + 乐观锁/安全闸**」。本项目采用**自研内容寻址快照**（不依赖 git，覆盖 write_file 覆盖写与新建场景）。

---

## 三、现状盘点

### 3.1 可直接复用的资产

| 资产                                              | 位置                                                                                                                  | 用途                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `edit_file` 产出 git-apply 兼容 unified diff      | `src/main/agent/tools/edit-file.ts`（`buildDiff` / `emitRegion`）                                                     | 撤销预览可复用；diff 可作兜底反推手段   |
| `toolResult.details` 持久化进 `messages.metadata` | `src/main/agent/context/convert.ts`                                                                                   | 重启后仍可读到 `details.diff`           |
| 卡片已用 Monaco DiffEditor 渲染 diff              | `src/renderer/src/components/chat/ToolCallCard.vue`                                                                   | 撤销按钮与预览零成本接入                |
| 工具统一包装层范式                                | `src/main/agent/tools/index.ts`（`wrapGate` / `wrapSandboxFsPolicy`）                                                 | 快照层照此新增一层 `wrapFileHistory`    |
| `{userData}` 落盘惯例                             | `attachments/`、`skills/`、`knowledge/`                                                                               | 快照目录放在 `{userData}/file-history/` |
| 会话级资源释放链路                                | `permission.clearSessionPermissions` → `services/index.ts` 的 `setOnSessionsRemoved` / `db-service.deleteSession`     | 撤销记录的清理挂同一链路                |
| IPC 范式                                          | `IpcService` + `namespace`，注册于 `src/main/services/index.ts`；推送经 `rendererClient.agentEvent.*`（按工作区定向） | 新增服务与推送零路由表改动              |

### 3.2 缺口

1. **没有存原文件内容**。`edit_file` 的 `details.diff` 只能反推且前提是文件未被改动；`write_file` 的 `details` 只有 `path` / `bytes`，覆盖写之后旧内容永久丢失 —— 新建/覆盖类操作**完全无法撤销**。
2. 没有「文件变更历史」这一概念：无法按会话列出「agent 改过哪些文件」。
3. `write_file` **允许不 read 直接覆盖写**（刻意为之，见下），因此覆盖写丢失旧内容的风险目前无兜底 —— 正是本方案要补的部分。

> 说明：早期版本曾加过「目标文件已存在则拒绝写入、要求先 read_file」的前置检查，但其语义是**无论如何都不让 write**，存在歧义，已刻意移除，改为允许不 read 直接 write。`docs/tools-gap-analysis.md` 第六批仍记录该检查「已实现」，属过期描述。
> 因此**不再恢复**该前置检查；覆盖写的可恢复性由本方案的写前快照承担。

---

## 四、总体设计

```
                  ┌─────────────────────────── 写入路径 ───────────────────────────┐
工具调用 ─→ wrapGate ─→ wrapSandboxFsPolicy ─→ wrapFileHistory ─→ 工具 execute（落盘）
                                                    │
                                    落盘前：读旧内容 → sha256(before)
                                    落盘后：读新内容 → sha256(after)
                                                    │
                                    SnapshotStore.put(before)  +  file_change_log 追加
                  └────────────────────────────────────────────────────────────────────┘

                  ┌─────────────────────────── 撤销路径 ───────────────────────────┐
renderer「撤销」─→ FileHistoryService.undo(logId)
                     ├─ 校验：status / 乐观锁 / superseded
                     ├─ 取 blob → 原子写回（临时文件 + rename）；新建则删文件
                     └─ 更新 log.status → 推送 onFileChanges（仅工作区窗口）
                  └────────────────────────────────────────────────────────────────┘

                  ┌──────────────────── 回退路径（阶段四 revertTo） ────────────────┐
renderer「回退到这里」─→ FileHistoryService.revertTo(sessionId, logId)
                     ├─ 该条及其后的 applied 按 path 归并；目标 = 时点前记录的重放结果
                     │  （时点前无记录则取时点后最早一条的 before_hash）
                     ├─ 逐文件校验：期望状态重放比对（外部修改 → 跳过）+ 沙箱写边界
                     ├─ 取 blob → 原子写回；该时点尚不存在的文件 → 校验后删除
                     └─ 最早一条 applied 标 undone、其余标 superseded → 推送 onFileChanges
                  └────────────────────────────────────────────────────────────────┘
```

**核心决策**

| 决策                             | 选择                                    | 理由                                                                             |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| 快照形态                         | 内容寻址 blob（key = sha256）           | 同一内容多版本自动去重；不会随编辑次数线性膨胀                                   |
| 索引载体                         | 新增 SQLite 表 `file_change_log`        | 撤销状态需跨重启准确、需按会话/路径查询、需标记 cascade                          |
| 原内容是否进 `messages.metadata` | **否**                                  | `messages` 是 LLM 上下文载体，塞入完整文件内容会撑大 DB 与查询；只存 hash 引用   |
| 记录层位置                       | `tools/index.ts` 新增 `wrapFileHistory` | 主代理与 general 子代理（`subagent.ts` 独立 Agent 实例）都能覆盖；不依赖宿主钩子 |
| 撤销触发方                       | 仅用户（UI 点击）                       | 撤销本身是危险写操作；模型自撤销浪费上下文且难以判断错在哪一步                   |

---

## 五、存储设计

### 5.1 快照仓库（blob store）

```
{userData}/file-history/
  blobs/{hash[0:2]}/{hash}     # sha256 十六进制，两级分片防单目录臃肿
```

- **存原始字节**（不做 LF 归一化、保留 BOM）。`edit_file` 内部会归一化行尾，但快照必须原样保存才能无损回写。
- 写入方式：先写 `{hash}.tmp` 再 `rename`（原子，且天然幂等 —— 同 hash 重复写安全）。
- 只处理 **UTF-8 文本**；二进制（含 NUL）直接跳过记录（`undoable=false`）。
- 单文件上限（建议 2 MB，与 `write_file` 的 1 MB 上限同量级）；超限跳过记录并在 log 上标记原因。

### 5.2 索引表 `file_change_log`

```sql
CREATE TABLE IF NOT EXISTS file_change_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  tool_call_id  TEXT,                 -- 关联 toolResult，供卡片查询
  tool_name     TEXT NOT NULL,        -- write_file / edit_file
  path          TEXT NOT NULL,        -- 绝对路径（写入时的原样）
  before_hash   TEXT,                 -- NULL = 本次为新建
  after_hash    TEXT NOT NULL,
  bytes         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'applied'
                CHECK(status IN ('applied','undone','superseded','failed','skipped')),
  undo_error    TEXT,                 -- 不可撤销原因（外部修改/大文件/二进制…）
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_fcl_session ON file_change_log(session_id, id);
CREATE INDEX IF NOT EXISTS idx_fcl_path    ON file_change_log(path, id);
CREATE INDEX IF NOT EXISTS idx_fcl_created ON file_change_log(created_at);
```

- 与既有约定一致：时间列用 unix 毫秒、表用 `STRICT`。
- 实现偏差：比初稿多一条 `FOREIGN KEY ... ON DELETE CASCADE` —— 会话物理删除（清空回收站 / 到期清理 / 工作区删除）由 FK 级联清行，免去在各删除路径逐个挂删除钩子；软删除（回收站）行仍保留（会话可恢复）。孤儿快照由 blob GC 回收（见十）。
- `schema.ts` 的 `CREATE TABLE IF NOT EXISTS` 对老库自动建表，无需迁移代码。
- `status` 语义：
  - `applied`：已落盘、可撤销；
  - `undone`：已被撤销；
  - `superseded`：因回退到更早时点被连带作废（cascade）；
  - `skipped`：未记录快照（二进制/超限）；`failed`：写入本身失败。

### 5.3 与 `messages.metadata` 的关系

`details` 不塞内容，可选地补一个轻量指针（便于卡片与日志对齐，非必需）：

```ts
details = { path, bytes, undo: { logId: 12, undoable: true } }
```

渲染侧不依赖它也能工作（按 `toolCallId` 查 `file_change_log`），故即使历史消息缺该字段也不影响。

---

## 六、记录时机与并发

`wrapFileHistory(tool, sessionId)` 包装在 `wrapSandboxFsPolicy` **内层**：

```
result.push(...entry.build(opts).map((t) => wrapGate(wrapSandboxFsPolicy(wrapFileHistory(t, opts.sessionId), opts.sessionId))))
```

- 沙箱拒绝会在外层 `throw`，内层不会执行 → 不产生记录。
- **不产生半成品记录**：落盘前只把「旧内容 + before_hash」暂存在闭包变量；只有 `execute` **成功返回**后才 `SnapshotStore.put` + 插入 log 行。执行失败则丢弃暂存（无需清理）。
- 新建/文件不存在：`before_hash = null`（`readFile` 失败即视为新建）。

**并发**：`write_file` / `edit_file` 均为 `executionMode: 'sequential'`，同会话内不会并发执行同一次写；不同工具间（Agent 层 `toolExecution: 'parallel'`）理论上可并发，但**撤销侧靠乐观锁兜底**，记录侧不引入额外互斥，避免过度设计。

---

## 七、撤销语义与 API

分四期落地，粒度由小到大。

### 阶段一：单条撤销 `undo(logId)` ✅ 已实现

前置校验（任一不满足即拒绝，并给出可读原因）：

1. `status === 'applied'`；
2. **乐观锁**：当前文件内容 ===「期望状态」；不等 → `external_modified`，拒绝（保护用户手工编辑 / 其他程序写入）。无后续改动时期望状态严格取该条的 `after_hash`；有后续改动时按账本重放；
3. **基线检查**：该文件在本会话的首条记录若为 `skipped`，而撤销点在它之后 → 基线不可知，拒绝。

执行：

- 目标 = 该条生效前的内容：有时点前记录 → `replayState(时点前记录)`；否则就是该条自己的 `before_hash`；
- `before_hash === null`（该时点文件尚不存在）→ 校验后**删除文件**；否则从 blob 读目标快照 → 原子写回（临时文件 + rename）。

**文件级连带回退**：若该文件在撤销点之后还有 `applied` 改动，不再拒绝（旧实现返回 `superseded_by_later_ops`）——后续改动叠在它上面，没有中间态可复原，因而把**该文件**整体回退到这条之前，后续记录标 `superseded`（只影响该文件，其它文件不动），结果里返回 `cascaded` 条数；确认框据此写明「该文件之后还有 N 次改动，将一并回退」。

收尾：该条标 `undone`、连带记录标 `superseded`，推送 `onFileChanges`。

### 阶段二：回退到某条 `revertTo(sessionId, logId)` ✅ 已实现

「回退到此处」：把该条**及其后**同会话所有 `applied` 改动涉及的文件，恢复到「该条记录生效前」的状态（等价回退到一个时间点），对话不受影响。

- 按 `path` 归并，每文件推出两个状态（共用 `replayState`，与 `undoSession` 同一套重放规则：`applied`/`skipped` → `after_hash`、`undone` → `before_hash`、`superseded` 不改变状态）：
  - **目标状态**：时点前若无该文件记录 → 取时点后**最早一条**的 `before_hash`（即这批改动的起点）；有时点前记录 → 从该文件首条记录前重放到时点为止；
  - **期望当前状态**：全量重放结果，与磁盘实际内容不符即视为被外部修改 → 跳过该文件并报告；
  - 目标为 `null`（该文件在该时点尚不存在）→ 校验后删除文件。
- 时点前的首条记录若是 `skipped`（未存快照），基线不可知 → 该文件整体拒绝并报告，避免误删会话前已存在的文件。
- 每个受影响文件单次原子写回；受影响记录中**最早一条标 `undone`**（保住撤销链可重放），其余标 `superseded`（cascade）。
- **logId 由渲染侧换算**：取 `createdAt ≥ 该条用户消息时间戳` 的最早一条 `applied` 记录的 id。按时间戳而非「消息里出现过的 toolCallId」定位，才能覆盖 task 子代理按宿主会话记录、不出现在工具卡片上的写入（见十一「实现落点」注）。
- 确认框写明影响面（N 个文件 / M 条改动）；整批复活（redo）作为可选后续，**仍未实现**。

### 阶段三：会话级 `oops(sessionId)` ✅ 已实现

撤销本会话全部 `applied` 记录（等价 `revertTo` 到最早一条）。实现最简、价值最高，**建议作为第一个上线的入口**。

### IPC 接口

新增 `FileHistoryService`（`src/main/services/file-history-service.ts`，`namespace = 'fileHistory'`），注册进 `src/main/services/index.ts`：

```ts
listSessionChanges(sessionId: string): FileChangeItem[]   // 含 path/toolName/时间/status/undoable+原因
undo(logId: number, sessionId: string): UndoResult        // { ok, error?, externalModified? }
revertTo(sessionId: string, logId: number): RevertResult  // { ok, count, failures[] }｜回退到该条生效前
undoSession(sessionId: string): RevertResult
```

推送：在 renderer 侧服务（`agent-event-service.ts`）新增 `onFileChanges(items)`，main 用 `rendererClient.agentEvent.onFileChanges(...)` —— 该通道按会话归属工作区定向投递，天然不会串到其他工作区窗口（见 `infra/render-client.ts` 的 `collectContentTargets` 契约）。

---

## 八、UI 设计

| 入口         | 位置                                                                         | 说明                                                                                                              |
| ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 单条撤销     | 消息行悬停操作条 ⟲（含 `write_file` / `edit_file` 的行，见八·下注）          | 弹确认框写明文件与影响面（该文件之后还有 N 次改动时提示「一并回退」）；生成中不给入口                             |
| 撤销预览     | 复用卡片已有的 Monaco DiffEditor                                             | 展示「撤销视角」的 diff：绿 = 将恢复的内容，红 = 将移除的当前内容                                                 |
| 回退到此     | `MessageItem.vue` hover 操作条（仅 user 消息，且该条之后有可回退改动时出现） | 调用 `revertTo`，确认框写明「N 个文件 / M 条改动」并说明对话不受影响；生成中禁用；结果逐个 toast 报告被跳过的文件 |
| 会话级 oops  | 会话头部 / 侧栏会话菜单                                                      | 「撤销本会话的文件改动」，调用 `undoSession`                                                                      |
| 不可撤销原因 | 卡片 tooltip                                                                 | 如「文件已被手动修改，无法撤销」「bash 命令的改动无法撤销，请使用 git」                                           |

注：单条撤销入口原先放在 `ToolCallCard.vue` 卡片头部，与「结果摘要 / 状态 tag / 展开箭头」争位，且属于 hover 才需要的操作用常驻按钮呈现显得拥挤；现移到消息行的悬停操作条（与复制、分支、重新生成同排），卡片头部只保留终态灰字标签（已撤销 / 已作废 / 不可撤销）。同一 assistant 消息含多次写文件时会出现多个 ⟲（tooltip 标明工具与文件）。

状态来源：会话加载时调一次 `listSessionChanges(sessionId)` 建立 `toolCallId → item` 映射，之后由 `onFileChanges` 推送增量更新（保证重启后状态仍准确，而非渲染层本地标记）。

---

## 九、边界与安全

### 9.1 安全闸（照抄业界教训，优先级高于功能）

| 场景                          | 处理                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 快照后文件被手工/其他程序改动 | `external_modified` → 拒绝撤销（不让 AI 吞掉用户编辑）                                                                                                                   |
| 撤销中间某条旧记录            | 文件级连带回退：该文件整体回退到这条之前，后续记录标 `superseded`（不再拒绝），确认框预先说明影响面                                                                      |
| 回退跨越多个文件/多轮对话     | 逐文件校验后整体回退；外部修改过或快照缺失的文件跳过并逐个报告，不阻塞其余文件                                                                                           |
| 写回前的竞态                  | 乐观锁复核 hash                                                                                                                                                          |
| 两个撤销入口几乎同时执行      | **不加互斥**（已确认）：靠乐观锁兜底；最坏结果是「最后写盘的内容」与「最后标记的状态」不是同一次操作，导致后续撤销被误判为外部修改而拒绝——不会覆盖数据，等下次写入即自愈 |
| 撤销「新建」                  | 校验 hash 后真删文件；仅在文件仍等于 `after_hash` 时执行                                                                                                                 |
| 路径安全                      | 撤销路径必须来自 `file_change_log`；写入前 `realpath` 解析（防符号链接逃逸），并复用沙箱的写边界判定                                                                     |
| bash 造成的改动               | 不记录；UI 明确提示「请使用 git」                                                                                                                                        |

### 9.2 其他边界

- **大文件 / 二进制**：不记录快照，log 标 `skipped` + 原因，卡片不显示撤销按钮。
- **工作区外文件**：撤销本身是用户主动行为，不经 `FS_WRITE_TOOLS` 权限条，但仍需通过沙箱写边界校验（与 `wrapSandboxFsPolicy` 同一口径），避免撤销成为越界写通道。
- **前缀缓存**：本设计不改 systemPrompt、不改工具定义与顺序、不向模型注入任何内容 → 对前缀缓存零影响。
- **跨会话同文件**：log 按会话归属，但文件是全局共享的 —— 因此**校验必须在撤销时实时做**（乐观锁已覆盖）。

---

## 十、清理与配额

| 时机                                                         | 动作                                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话软删除（回收站）                                         | 保留记录（可恢复会话）                                                                                                                                               |
| 会话物理删除（`purgeTrash` / `purgeExpiredDeletedSessions`） | log 行经 FK 级联删除 → 触发 blob GC（已实现）                                                                                                                        |
| 工作区删除（`setOnSessionsRemoved`）                         | 同上，FK 级联清行后触发 blob GC（已实现）                                                                                                                            |
| 启动时                                                       | 一次 blob GC：删除已无任何 log 行引用的 hash（`FileHistoryService` 构造时触发，已实现；含 undone/superseded 行引用——会话级回退可能需要已被单条撤销的首条记录的快照） |
| 配额                                                         | 单会话 log 上限（建议 500 条）、blob 总量上限（建议 500 MB）、保留天数（建议 30 天）；超限按最老优先淘汰 log 并 GC（**未实现**）                                     |

挂载点与 `clearSessionPermissions` / `deleteSessionAttachments` 完全同构，复用既有链路，不新增生命周期机制。

---

## 十一、分期实施计划

| 阶段                   | 交付                                                                      | 验收标准                                                                  | 状态                   |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------- |
| 1. 快照基础设施        | `SnapshotStore`（blob 读写/GC）+ `file_change_log` 表 + `wrapFileHistory` | 每次 write/edit 后 DB 有记录、blob 有旧内容；失败/被拒调用无记录          | ✅ 已实现              |
| 2. 会话级撤销          | `FileHistoryService.undoSession` + 会话入口 + `onFileChanges`             | 撤销后文件内容与操作前逐字节一致（含 BOM / CRLF / 尾换行）                | ✅ 已实现              |
| 3. 单条撤销 + 行内入口 | `undo(logId)` + 消息行操作条 ⟲ + 终态标签                                 | 乐观锁与 `external_modified` 拒绝路径可用；手工改动后撤销被拒             | ✅ 已实现              |
| 4. 回退到某条          | `revertTo` + 消息级入口 + cascade 标记                                    | 跨多文件、多步回退后所有受影响文件状态正确；被作废条目状态为 `superseded` | ✅ 已实现              |
| 5. 清理与配额          | 回收站/工作区/启动三处 GC + 配额                                          | 删除会话后 blob 无泄漏；超限淘汰后仍可撤销保留期内记录                    | GC 已实现 / 配额未实现 |

**验证手段**：真实文件（含 CRLF / 无尾换行 / BOM / 中文）做「写入 → 撤销 → 逐字节比对」；并发场景用「撤销前手工改文件」验证拒绝路径。

**实现落点**（2026-09）：

| 层            | 文件                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| 表结构        | `src/main/database/schema.ts`（`file_change_log` + 3 索引）                                                    |
| log 读写 API  | `src/main/database/file-history.ts`（组装进 `db` 门面）                                                        |
| 快照 + 撤销域 | `src/main/infra/file-history.ts`（blob 读写 / 记录 / undo / **revertTo** / undoSession / GC / 推送）           |
| 工具包装层    | `src/main/agent/tools/index.ts` 的 `wrapFileHistory`（`wrapGate → sandbox → fileHistory → 工具`）              |
| IPC 服务      | `src/main/services/file-history-service.ts`（namespace `fileHistory`）                                         |
| 推送          | `rendererClient.agentEvent.onFileChanges({ sessionId, items })` → 渲染侧 `agent-event-service.ts`              |
| 渲染侧状态    | `src/renderer/src/store/useFileHistoryStore.ts`（全量拉取 + 推送合并 +「回退到此处」目标换算）                 |
| 单条撤销 UI   | 入口在 `MessageItem.vue` 行悬停操作条 ⟲（确认框）；`ToolCallCard.vue` 只保留终态标签（已撤销/已作废/不可撤销） |
| 消息级回退 UI | `MessageItem.vue` hover 操作条 ⟲ + 确认框；目标由 `MessageList.vue` 按用户消息时间戳算好后传入                 |
| 会话级入口 UI | `SessionItem.vue` ⋯ 菜单「撤销文件改动」→ `SessionSidebar.vue` 确认框                                          |

注：`undoSession` / `revertTo` 共用 `replayState`（按时间线重放 `applied`/`skipped`→`after`、`undone`→`before`）逐文件校验「期望状态」，外部修改过或快照缺失的文件跳过并逐个报告；受影响记录中最早一条标 `undone`、其余标 `superseded`。子代理（task 工具）复用宿主会话 id 记录：会话级撤销天然覆盖其改动，「回退到此处」则靠**消息时间戳 ⇄ 记录 `createdAt`** 换算目标 logId 覆盖（不用 toolCallId 匹配，因为子代理的内部工具调用不在主会话消息流里）。

---

## 十二、待确认事项

1. ~~`write_file` 是否应恢复「目标文件已存在则先拒绝、要求先 read_file」的前置检查~~ —— **已确认不恢复**：该检查语义是「无论如何都不让 write」，有歧义，已刻意移除，改为允许不 read 直接 write。覆盖写风险由本方案的写前快照承担。
2. 是否需要「重做（redo）」与「整批复活」；若不需，`superseded` 记录可更早 GC。
3. 快照是否需要跨会话共享去重（当前设计 blob 全局共享，log 按会话归属，已天然去重）。
