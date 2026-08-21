# 基础工具能力差距分析（对比市面成熟工具）

> 对比对象：Claude Code、Cursor、Windsurf（Devin Desktop）
> 分析日期：2026-08-15（Grep / Glob / WebFetch 已于当日补齐，见文末更新记录）
> 范围：`src/main/agent/tools/` 下的内置工具及权限体系

---

## 一、现有工具清单

| # | 工具名 | 标签 | 类别 | 执行模式 | 默认启用 | 危险 |
|---|--------|------|------|---------|---------|------|
| 1 | `read_file` | 读取文件 | 文件操作 | parallel | 是 | 否 |
| 2 | `write_file` | 写入文件 | 文件操作 | sequential | 是 | **是** |
| 3 | `edit_file` | 编辑文件 | 文件操作 | sequential | 是 | **是** |
| 4 | `list_files` | 列出文件 | 文件操作 | parallel | 是 | 否 |
| 5 | `glob` | 匹配文件 | 文件操作 | parallel | 是 | 否 |
| 6 | `grep` | 搜索内容 | 搜索 | parallel | 是 | 否 |
| 7 | `bash` | 执行命令 | 命令执行 | sequential | 是 | **是** |
| 8 | `bash_output` | 读取后台输出 | 命令执行 | parallel | 是 | 否 |
| 9 | `kill_shell` | 终止后台命令 | 命令执行 | sequential | 是 | 否 |
| 10 | `enter_plan_mode` | 进入计划模式 | 规划 | sequential | 是 | 否 |
| 11 | `exit_plan_mode` | 提交计划 | 规划 | sequential | 是 | 否 |
| 12 | `web_search` | 网页搜索 | 搜索 | parallel | 否 | 否 |
| 13 | `web_fetch` | 抓取网页 | 搜索 | parallel | 是 | 否 |
| 14 | `search_knowledge` | 检索知识库 | 搜索 | parallel | 是 | 否 |
| 15 | `find_skill` | 技能搜索 | 技能管理 | parallel | 是 | 否 |
| 16 | `install_skill` | 技能安装 | 技能管理 | parallel | 是 | **是** |
| 17 | `read_skill` | 技能读取 | 技能管理 | parallel | 是 | 否 |
| 18 | `list_memories` | 查看记忆 | 记忆管理 | parallel | 是 | 否 |
| 19 | `add_memory` | 添加记忆 | 记忆管理 | parallel | 是 | 否 |
| 20 | `update_memory` | 更新记忆 | 记忆管理 | parallel | 是 | 否 |
| 21 | `delete_memory` | 删除记忆 | 记忆管理 | parallel | 是 | 否 |
| 22 | `notify` | 桌面通知 | 工具 | sequential | 是 | 否 |

另支持 MCP 协议动态接入外部工具（stdio / streamable HTTP）。

---

## 二、能力矩阵对比

| 能力 | 本项目 | Claude Code | Cursor | Windsurf |
|------|--------|-------------|--------|----------|
| 读文件 | `read_file` | `Read` | IDE 原生 | IDE 原生 |
| 写文件 | `write_file` | `Write` | IDE 原生 | IDE 原生 |
| 编辑文件 | `edit_file` | `Edit` | IDE 原生 | IDE 原生 |
| 列出文件 | `list_files` | `Bash(ls)` | IDE 原生 | IDE 原生 |
| 文件模式匹配 | `glob` | `Glob` | IDE 原生 | IDE 原生 |
| 内容搜索（正则） | `grep` | `Grep` | IDE 原生 | IDE 原生 |
| 执行命令 | `bash` | `Bash` | Terminal | Terminal |
| 网页搜索 | `web_search` | `WebSearch` | `WebSearch` | Cascade 内置 |
| URL 内容抓取 | `web_fetch` | `WebFetch` | 有 | Cascade 内置 |
| 任务/子 Agent | 无 | `Task`（多种子 agent） | Multi-Agent | Cascade |

---

## 三、关键欠缺能力（按优先级排序）

### P0 — 核心能力缺失（✅ 已全部补齐，见文末实现记录）

#### 1. ~~缺少 Grep（内容搜索）工具~~ ✅ 已实现 `grep`

- **已补齐**：`src/main/agent/tools/grep.ts`。正则搜索（JavaScript 语法）、文件/目录范围、glob 文件名过滤、三种输出模式（content / files_with_matches / count）、忽略大小写、上下文行（类似 `grep -C`）、head_limit
- **防护**：自动跳过 node_modules/.git 等目录、二进制文件（NUL 检测）、超过 1MB 的文件；遍历上限 2 万文件、输出上限 50K 字符
- **收益**：原需 bash 绕行 2-3 轮调用且触发权限确认，现在 1 次只读调用直接放行

#### 2. ~~缺少 Glob（文件模式匹配）工具~~ ✅ 已实现 `glob`

- **已补齐**：`src/main/agent/tools/glob.ts`。支持 `**/*.tsx`、`src/**/*.test.ts`、`*.{ts,js}`、`[a-c].txt` 等模式；结果按修改时间排序（新→旧）
- **语义**：不含 `/` 的模式（如 `*.ts`）按任意深度的文件名匹配，与 ripgrep `-g` 一致
- **共享实现**：`src/main/agent/tools/fs-walk.ts`（忽略目录表 + glob 转正则 + 带上限遍历），glob/grep 共用

#### 3. ~~缺少 WebFetch（URL 内容抓取）工具~~ ✅ 已实现 `web_fetch`

- **已补齐**：`src/main/agent/tools/web-fetch.ts`。HTML 自动转近似 Markdown 文本（保留标题/列表/链接）；JSON/XML/纯文本原样返回；PDF 复用 mdize 解析；其余二进制返回类型提示
- **防护**：仅 http/https、15s 超时、10MB 响应上限（Content-Length 预检 + 字节数双保险）、输出 50K 字符截断
- **收益**：Agent 可阅读 web_search 结果、官方文档、API 文档；与 `web_search` 形成「搜索 → 阅读」闭环

### P1 — 重要能力缺失

#### 4. 缺少子 Agent / Task 系统

- **现状**：所有任务由单一 Agent 串行处理
- **Claude Code**：`Task` 可启动专门子 Agent（探索型、规划型、通用型），并行执行独立任务
- **Cursor**：支持 8 个 Agent 并行运行
- **影响**：复杂任务无法并行化，效率低；上下文窗口容易被大量搜索结果撑爆

#### 5. 缺少 Notebook 编辑工具

- **现状**：无法操作 Jupyter Notebook（.ipynb）
- **Claude Code**：`NotebookEdit` 专门编辑 Notebook 单元格
- **影响**：数据分析类场景完全无法覆盖

#### 6. ~~缺少后台命令管理（BashOutput / KillShell）~~ ✅ 已实现（2026-08-15）

- **已补齐**：`bash` 支持 `background=true` 后台启动长驻命令并返回 `session_id`；新增 `bash_output`（读取后台输出，全量/增量 tail）与 `kill_shell`（终止后台进程组）。见文末第五批实现记录
- **Claude Code**：支持 `BashOutput`（异步读取后台进程输出）和 `KillShell`（终止后台进程）
- **影响**：长时间运行的命令（如 `npm run dev`、`npm test`）可后台运行、增量读取、随时终止，不再超时被强杀

#### 7. ~~缺少 Plan Mode（规划模式）~~ ✅ 已实现（2026-08-15）

- **已补齐**：`enter_plan_mode` 进入计划模式（此期间危险工具被拦截）+ `exit_plan_mode` 提交计划等待用户审批（批准后放行执行，拒绝则按反馈调整重提）。见文末第七批实现记录
- **Claude Code**：`EnterPlanMode` / `ExitPlanMode`，先生成计划让用户审核再执行
- **Windsurf**：Planning Mode，生成 plan.md 文件供协作
- **影响**：复杂任务可先规划、用户提前审方案再执行，避免 Agent 走偏

### P2 — 增强型能力

#### 8. ~~`read_file` 不支持图片和二进制预览~~ ✅ 已实现（2026-08-15）

- **已补齐**：`createReadFileTool(supportsImages)` 多模态门控——模型支持图片时，png/jpg/gif/webp 经魔数校验返回 image block（5MB 上限）；不支持时返回文本提示（避免提供方 400 中断整回合）。见文末第二批实现记录
- **Claude Code**：Read 工具支持 PNG/JPG（多模态直接看图）、PDF、Jupyter Notebook
- **影响**：用户发截图时 Agent 可「看到」图片内容（多模态模型）

#### 9. `edit_file` 缺少模糊匹配能力

- **现状**：`oldText` 必须精确匹配，含换行与空白
- **痛点**：LLM 经常因缩进/空白差异导致匹配失败；错误信息已较好，可考虑增加「附近匹配」建议

#### 10. ~~`bash` 缺少持久化 Shell 会话~~ ✅ 已实现（2026-08-15）

- **已补齐**：每个会话一个持久化 bash（`--noprofile --norc -s`），命令经「哨兵 + $?」标记完成边界，`cd` / `export` 在会话内保留。见文末第五批实现记录
- **Claude Code**：persistent bash session，在同一 shell 中连续执行命令，保留 cd、环境变量等状态
- **影响**：Agent 无需反复绝对路径/重复 cd，减少 token 消耗与出错概率

#### 11. 缺少 TodoWrite（任务管理）工具

- **Claude Code**：可创建/管理结构化的任务列表，追踪进度
- **现状**：Agent 没有显式的任务追踪机制
- **影响**：复杂任务的进度不透明，用户难以了解当前执行到哪一步

---

## 四、现有工具的改进空间

### `read_file`（✅ 2026-08-15 已优化）

| 问题 | 现状 | 建议 |
|------|------|------|
| 行号显示 | ✅ 已支持 | `cat -n` 风格（右对齐 + tab），offset 续读保持原文件行号；尾部换行不计行 |
| 图片支持 | ✅ 已支持（多模态门控） | png/jpg/gif/webp 魔数校验后返回 image block；模型不支持时返回文本提示而非 image block（避免提供方 400 导致整回合中断）；5MB 上限；BMP 不支持 |
| 二进制检测 | ✅ 已支持 | 前 8KB 含 NUL 字节即报错提示，不再输出乱码 |

### `write_file`

| 问题 | 现状 | 建议 |
|------|------|------|
| 读取前置检查 | ✅ 已支持（2026-08-15） | 目标文件已存在时拒绝写入并提示先 read_file，防盲写覆盖（对齐 Claude Code Write 语义） |
| 大文件处理 | ✅ 已支持（2026-08-15） | 单次写入内容超 1MB 直接拒绝，提示改用 edit_file 分段编辑 |

### `bash`

| 问题 | 现状 | 建议 |
|------|------|------|
| 流式输出 | ✅ 已支持（2026-08-15） | 见文末第四批实现记录：执行中实时推送输出，卡片「实时输出」区滚动展示 |
| 持久化会话 | ✅ 已支持（2026-08-15） | 见文末第五批实现记录：同一 shell 内 cd/export 保留 |
| 后台执行 | ✅ 已支持（2026-08-15） | `background=true` + `bash_output` / `kill_shell`，见文末第五批实现记录 |
| 输出截断方向 | ✅ 已支持（2026-08-15） | 改为保留**尾部** 50K（错误信息通常在末尾），见文末第七批实现记录 |
| 交互式命令 | ✅ 已支持（2026-08-15） | 检测并拒绝交互式/读 stdin 命令（vim/less/ssh/裸 cat/git commit 无 -m 等），提示改用非交互写法 |

### `edit_file`（✅ 2026-08-15 已优化）

| 问题 | 现状 | 建议 |
|------|------|------|
| 模糊匹配 | ✅ 匹配失败时给出近似候选诊断 | 空白差异/大小写差异可唯一定位时，错误信息直接附上文件原文片段与行号，模型下一轮即可复制修正；检测行号前缀误粘贴并提示 |
| diff 输出 | ✅ 标准 unified diff | 见文末第三批实现记录：hunk 上下文 + LCS 行对比 + git apply 兼容，前端 Monaco DiffEditor 渲染 |

---

## 五、建议的实现路径

```
第一阶段（核心补全，解决「能不能用」）✅ 已完成（2026-08-15）:
  ├── 1. Grep 工具 — 正则内容搜索（纯 JS 实现，自动忽略噪声目录/二进制/大文件）
  ├── 2. Glob 工具 — 文件模式匹配（自研 glob 转正则，按修改时间排序）
  └── 3. WebFetch 工具 — URL 抓取（HTML→Markdown、JSON/PDF 支持、超时与大小防护）

第二阶段（效率提升，解决「好不好用」）✅ 4、5 已完成（2026-08-15）:
  ├── 4. bash 持久化会话 ✅（哨兵 + $? 边界标记，cd/export 保留）
  ├── 5. bash 后台执行 + BashOutput / KillShell ✅（background=true + bash_output / kill_shell）
  ├── 6. 子 Agent / Task 系统（当前最大缺口）
  └── 7. TodoWrite 任务管理

第三阶段（高级能力）:
  ├── 8. Plan Mode（规划模式）✅（enter/exit_plan_mode，见第七批实现记录）
  ├── 9. read_file 图片预览 ✅（多模态门控，见第二批实现记录）
  ├── 10. Notebook 编辑
  └── 11. 代码库索引 / 语义搜索增强
```

---

## 六、最大差距总结

**核心搜索三件套已补齐**：`grep`（内容搜索）、`glob`（文件模式匹配）、`web_fetch`（URL 抓取）。「找到所有使用了 `createUser` 函数的文件」现在只需 1 次 `grep` 调用即可完成，且作为只读工具直接放行、无需权限确认。

**当前最大缺口**：子 Agent / Task 系统（并行任务）。这是与 Claude Code / Cursor 差距最明显的一项——复杂任务无法并行化，上下文窗口容易被大量搜索结果撑爆。P1 剩余缺口仅此一项（Notebook 编辑属 P1），P2 剩 TodoWrite 任务管理。

---

## 七、实现记录

### 2026-08-15：补齐 P0 三件套

| 工具 | 文件 | 要点 |
|------|------|------|
| `glob` | `src/main/agent/tools/glob.ts` | glob 模式匹配，结果按 mtime 排序，上限 500 条 |
| `grep` | `src/main/agent/tools/grep.ts` | 正则内容搜索，3 种输出模式 + 上下文行 + glob 过滤 |
| `web_fetch` | `src/main/agent/tools/web-fetch.ts` | URL 抓取，HTML→Markdown / JSON / PDF |
| 共享辅助 | `src/main/agent/tools/fs-walk.ts` | 忽略目录表、glob→正则、带上限目录遍历（glob/grep 共用） |

配套改动：

- `src/main/agent/tools/index.ts`：三个工具注册进 `TOOL_REGISTRY`，均默认启用；只读操作不进 `DANGEROUS_TOOLS`，无需权限确认，`executionMode: 'parallel'`
- `src/renderer/src/utils/toolResult.ts`：工具卡片收起态摘要（「匹配 N 个文件」「命中 N 行/个文件」「已抓取 host（xx KB）」）

设计取舍：

- **glob 匹配改用 picomatch**（2026-08-15 第八批）：仍为纯 JS 零依赖库（非二进制），语义对齐 ripgrep——`dot: false` 通配符不匹配隐藏文件、隐藏目录不遍历；替代首批自研的 glob→正则（见文末第八批实现记录）
- **不引入 ripgrep 二进制依赖**：目录遍历/忽略表/上限兜底仍为纯 JS 自研（二进制 NUL 检测 + 1MB 单文件上限 + 遍历上限兜底性能），保证打包体积与跨平台一致性；后续若性能不足可换 `rg` 优先策略
- **`web_fetch` 不做模型摘要**（Claude Code 的 WebFetch 会用小模型提炼）：当前直接返回转换后的全文并截断至 50K 字符，保持工具简单；模型提炼可作为后续增强
- **HTML 转换为纯正则实现**：覆盖文档页/文章页的标题、列表、链接、代码块结构，不追求渲染级还原；script/style/注释/图片一律剥离

### 2026-08-15（第二批）：read_file / edit_file 优化

**read_file**（`src/main/agent/tools/read-file.ts` 改为 `createReadFileTool(supportsImages)` 工厂）：

- **行号输出**：`cat -n` 风格（右对齐 + tab），offset 续读保持原文件行号；尾部换行产生的空行不计（对齐 cat 语义）
- **图片支持（多模态门控）**：`buildTools({ supportsImages })` 由 `model.input.includes('image')` 决定（agent-manager 创建 Agent 时注入）。支持则 png/jpg/gif/webp 经魔数校验后返回 image block；不支持则返回文本提示 —— pi-ai 不按模型能力过滤 image block，直接注入会在下一次模型调用时被提供方 400 拒绝，导致整回合中断
- **防护**：5MB 图片上限、魔数校验（防文本文件伪装成 .png）、二进制检测（前 8KB NUL）改为明确报错
- **取舍**：BMP 提供方普遍不支持，不返回 image block；SVG 是 XML 文本，走文本路径

**edit_file**（匹配失败的诊断增强）：

- 空白容忍正则（oldText 空白串 → `\s+`）唯一定位时，错误信息直接附上**文件原文片段 + 行号**，模型下一轮复制即可修正
- 大小写差异同理给出原文
- 检测 oldText 携带 read_file 行号前缀（`数字\t`）并提示去除
- 不自动应用模糊匹配（风险高），只给诊断信息让模型确认后重试

验证：11 项功能测试全部通过（行号/offset、二进制报错、图片门控双路径、伪装图片、4 类 edit 失败诊断）。

### 2026-08-15（第三批）：edit_file 返回标准 unified diff + 前端 diff 渲染

**后端**（`src/main/agent/tools/edit-file.ts` 的 `buildDiff` / `emitRegion`）：

- **输出标准 unified diff**：`--- a/<path>` / `+++ b/<path>` 头 + `@@ -x,y +x,y @@` hunk（2 行上下文，相邻 hunk 重叠时合并），同时写入 toolResult 的 `text`（给模型）与 `details.diff`（给前端）
- **hunk 内 LCS 行对比**：新侧内容直接取自实际写入结果（按编辑字符偏移映射切片），区域行数乘积超 400 万退化整块 -/+（防超大文件内存失控）；任意对齐方式（行中替换 / 空替换残留空行 / 尾换行编辑）都忠实反映真实写入
- **git apply 兼容**（14 用例正向/反向 apply 双向验证通过）：
  - 尾部换行产生的空元素不计为真实行（否则幽灵上下文行导致 patch 被拒）
  - 绝对路径开头 `/` 吸收进前缀（`a/tmp/x` 而非 `a//tmp/x`，后者 git 报 invalid path）
  - 尾行缺换行时输出 `\ No newline at end of file` 标记；「行尾是否带换行」参与 LCS 相等判定，EOF 增删换行的编辑输出 -/+ 各一行
  - no-op 编辑（oldText===newText）跳过空 hunk
- 摘要行（`已替换 N 处（首个改动在第 M 行）`）保留在 text 最前，模型无需解析 diff 即可知改动位置

**前端**（`src/renderer/src/components/chat/ToolCallCard.vue`）：

- `details.diff` 包成 ` ```diff ` 围栏交给 `MarkdownRender`（markstream-vue），`code-renderer="monaco"` 走 Monaco DiffEditor 渲染：+/- 着色、hunk 折叠信息、diffWordWrap
- 配置收敛在 `code-block-props`（`monacoOptions` 必须放这里，作顶层 prop 不生效）：隐藏复制按钮/头部、MAX_HEIGHT 300、vitesse 明暗主题随 `themeStore.isDark`
- 无 diff（失败结果 / 历史消息）时回退 NCode 纯文本；懒渲染策略不变（首次展开才挂载）

验证：`npm run typecheck` 通过；diff 正确性用「编辑后文件 + 生成的 diff → `git apply -R` 还原回原文 → `git apply` 重放」双向校验，14 个用例（行中替换/多 hunk/空替换残留空行/整段替换/插入/相邻合并/首尾编辑/空行文件/无尾换行×3/EOF 增删换行）全部通过。

### 2026-08-15（第四批）：bash 命令输出流式化

**主进程**（`src/main/agent/tools/bash.ts`）：

- `execute` 启用第 4 个参数 `onUpdate`（pi-agent-core 的 `AgentToolUpdateCallback`，触发 `tool_execution_update` 事件，仅 UI 消费、不进入模型上下文）
- 每次推 **完整累计文本快照**（stdout + `[stderr]` 合并，替换语义而非增量，与官方 harness bash 一致），50ms 节流（`STREAM_INTERVAL_MS`）合并高频输出，避免 IPC 洪峰；`finalize`/error 时冲刷残留快照
- 截断（50K）后停止推送，仅在截断瞬间补一次带 `...(输出已截断)` 标记的快照

**渲染进程**：

- `chat-events.ts`：`ToolStatus` 新增 `stream` 字段；`applyChatEvent` 处理 `tool_execution_update`（从 `partialResult.content` 提取文本，替换写入 stream；仅 running/pending 期间接收，结束后由终态结果接管）
- `agent-event-service.ts`：`tool_execution_update` 按 `sessionId::toolCallId` rAF 缓冲（每帧只应用各工具最新快照，替换语义故丢弃中间态安全），其他事件前强制 flush 保序；后台会话直接应用
- `ToolCallCard.vue`：执行中展示「实时输出」区（等宽字体 pre 自动换行），首个流快照到达时自动展开卡片并跟随滚动到底部

验证：`pnpm typecheck` 通过；改动文件 `eslint --fix` 后 0 问题（全仓 lint 的存量错误均来自 scripts/tmp-*.mjs 等无关文件）。

### 2026-08-15（第五批）：后台命令管理（BashOutput / KillShell）+ 持久化 Shell 会话

**新增模块** `src/main/agent/tools/bash-session.ts`（纯 Node，不依赖 electron/db）：

- **PersistentShell**：每 Agent 会话一个 `bash --noprofile --norc -s`（stdin 驱动）。命令按 FIFO 队列写入，用「唯一哨兵 + `$?`」标记完成边界与退出码；`cd` / `export` 在 shell 内保留。输出按 stdout/stderr 分缓冲、哨兵行剔除、50ms 节流流式推送（复用第四批 `tool_execution_update` 通道）
- **关键实验结论**：非交互 bash 与命令同进程组，向组内发 SIGINT/SIGTERM 都会连带杀死 bash 且死后不再响应 stdin（`exitCode===null` 对信号杀死同样成立，存活判断必须用 close 事件）。故**超时/中止 = 整组 SIGTERM→SIGKILL、会话整体重置**，下次调用自动重建；后台命令不受影响（abort 保留后台进程，符合用户选择）
- **BackgroundShell**：`background=true` 时独立进程组启动，输出环形缓冲（100K 上限），支持全量读取 / 增量 tail（游标），进程组整体终止
- **BashSessionManager**：默认会话按 Agent 会话缓存；后台会话 LRU 上限 8（优先淘汰已退出者）；`disposeAll()` 在 `app.on('before-quit')` 回收全部进程

**bash 家族工具**（`createBashTools(sessionId)` 工厂，按会话绑定）：

- `bash`：新增 `background` 参数。阻塞模式在持久化会话中执行（`cwd` 参数每次显式 `cd`，结果保留）；后台模式立即返回 `session_id` 提示。仍属危险工具走权限确认
- `bash_output`：按 `session_id` 读后台输出，`tail=true`（默认）只返回新增、`false` 返回全部；带 [进程运行中 / 已退出] 状态头
- `kill_shell`：按 `session_id` 终止后台进程组

**接入**：`tools/index.ts` 注册表改为 build 工厂（`{ name, label, description, defaultEnabled, build }`），bash 家族随 bash 启停；`agent-manager` 传入 `sessionId`；渲染层无改动（复用第四批流式与工具卡片）。

验证：`pnpm typecheck` 通过、改动文件 eslint 0 问题；`scripts/tmp-bash-session-test.mjs` 用真实 bash 验证 8 项：哨兵输出+退出码、cd 持久化、非零退出码、哨兵剔除、sleep 超时未完成、SIGTERM 整组终止、重建 shell 立即可用，全部通过。

### 2026-08-15（第六批）：工具细节改进

- **write_file 读取前置检查**（`write-file.ts`）：目标文件已存在时拒绝写入并提示先 read_file（对齐 Claude Code Write 语义，防盲写覆盖）；同时加**单次写入 1MB 上限**，超限提示改用 edit_file 分段编辑
- **bash 输出截断改保留尾部**（`bash-session.ts`）：`mergeOutput` 与原始缓冲均改为保留末尾 50K（滑动窗口），截断标记前置（`...(输出已截断，仅保留末尾 N 字符)...`）；错误信息通常在末尾，不再被截掉
- **bash 交互式命令检测**（`bash.ts`）：拒绝交互式/读 stdin 命令——交互程序（vim/nano/less/top/ssh/psql…）、裸调用读 stdin 的程序（cat/read/python/node/bash…）、`git rebase -i`/`git add -p`/`git commit`（无 -m 等）、`sudo`（无 -n）、`crontab -e`；错误信息引导非交互写法（`git commit -m "..."`、`cat file`、`python script.py`、`sudo -n`）

### 2026-08-15（第七批）：Plan Mode（规划模式）

**主进程**：

- `src/main/agent/tools/plan-mode.ts`：`createPlanModeTools(sessionId)` 产出两个工具
  - `enter_plan_mode`：进入计划模式（`sessionPlanMode` 按会话置位）
  - `exit_plan_mode`：把计划提交给用户审批——推 `PlanApprovalRequest` 给 renderer、挂起等待（复用 `PERMISSION_TIMEOUT_MS` 超时自动拒绝）。批准 → 清除计划模式并返回「开始执行」；拒绝 → 保持计划模式，返回用户反馈供调整后重提
- `permission.ts`：beforeToolCall 在计划模式下拦截全部危险工具（bash/write/edit/install_skill），引导先提交计划
- `agent-manager.ts`：agent_start 时 `clearPlanMode`（计划模式按单次 run 生效）
- `agent-service.ts`：新增 `respondPlan(requestId, approved, feedback)` IPC
- `tools/index.ts`：注册 enter/exit_plan_mode（默认启用）

**渲染进程**：

- `usePlanStore.ts`：按会话暂存待审批计划；`respond` 回传批准/拒绝+反馈
- `agent-event-service.ts`：新增 `onPlanRequest` 接收；agent_end 清理残留计划请求
- `PlanApprovalBar.vue`：展示计划标题/全文 + 「批准/拒绝」按钮 + 拒绝反馈输入框，挂在 ChatView 输入框上方

流程闭环：复杂任务 Agent 调 `enter_plan_mode` → 输出计划 → `exit_plan_mode` 提交 → 用户批准 → 放行执行；拒绝 → 按反馈调整重提。

验证：`pnpm typecheck`（node+web）通过；改动文件 eslint 0 问题。

### 2026-08-15（第八批）：grep / glob 隐藏文件语义对齐（引入 picomatch）

- **引入 picomatch 4.x**（零依赖、纯 JS，不违背「不引入二进制依赖」的取舍）：`fs-walk.ts` 新增 `createGlobMatcher(pattern)`，替换自研 `globToRegExp` / `isBasenamePattern`
  - `dot: false`：`*`/`**`/`?` 通配符不匹配以 `.` 开头的隐藏文件，除非模式显式写点号（`.env*`、`.*` 仍可匹配）—— 修复了 `*.ts` 匹配 `.hidden.ts` 的问题
  - 不含 `/` 的模式动态启用 `matchBase`（任意深度文件名匹配，ripgrep `-g` 语义）；注意 picomatch 的 `matchBase` 对含 `/` 的模式反而破坏匹配，必须按模式决定
- **`walkFiles` 跳过隐藏目录**（以 `.` 开头），对齐 ripgrep / Claude Code Glob 默认不遍历隐藏目录；隐藏文件仍列出（由模式决定是否命中）
- grep.ts / glob.ts 改用 `createGlobMatcher`（入参统一为 `/` 分隔相对路径），并更新参数描述
- 验证：`scripts/tmp-glob-test.mjs` 26 项全通过（`**`/`*`/`?`/字符类/花括号/hidden 文件/隐藏目录遍历/显式点号模式）；`pnpm typecheck` 通过、改动文件 eslint 0 问题
