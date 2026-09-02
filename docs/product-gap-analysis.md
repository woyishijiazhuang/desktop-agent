# 产品差距分析：桌面助手 vs 主流 AI 客户端

> 统计日期：2026-08-04（2026-09-02 复核刷新）
> 分析对象：本仓库「桌面助手」（Electron + Vue3 + TS，基于 pi-agent-core/pi-ai）
> 对比基准：Claude Desktop、ChatGPT Desktop（含 Codex/Work）、豆包电脑版、Kimi Work、LobeChat（开源代表）
> 结论先行：**对话体验与输入形态已对齐主流并超配——语音（STT/TTS）、分支对话、托盘、系统通知、知识库 RAG、长期记忆、子代理编排、在线技能市场、多工作区窗口均已落地。当前差距收窄至「数据回流（导入/备份/分享）」「重型 Agent 生态（浏览器/Computer Use/代码沙箱）」「桌面基建残余（全局快捷键/自动更新）」「产品打磨（命令面板/i18n/Onboarding 向导）」及「工程与质量（测试/CI）」四块。**

---

## 1. 项目现状盘点（已有能力）

依据代码与文档（[docs/backend.md](backend.md) / [docs/frontend.md](frontend.md)）核实：

**对话核心**
- 流式 Markdown 渲染（markstream-vue 增量渲染、代码块复制/高亮、ECharts 自定义块）
- 思考过程展示（ReasoningBlock，防注入纯文本展示）
- 工具调用卡片（参数 JSON 高亮、状态实时更新、默认折叠）
- 中止 / 重试 / 重新生成 / 编辑（recall 回填输入框）
- 临时空对话（ephemeral，首条消息才落库）
- **分支对话**：消息悬停「从此消息开启新分支」，复制分支点前历史到新会话（forkSession，`parent_session_id` 溯源），源会话不受影响，分支点文本回填输入框供改写

**输入形态**
- 图片/文件拖拽上传、剪贴板粘贴、文件选择（PDF/Word/CSV 经 doc-parser 提取文本）
- 附件本地落盘：图片存 `userData/attachments/`，DB 只存 `file:` 引用，删除会话/清空回收站级联清理附件
- **语音输入（STT）**：Silero VAD（vad-web）端点检测断句 + 在线 MiMo ASR（zh/en/auto），说话→转写→自动发送，60s 无语音看门狗自动退出
- **语音输出（TTS/朗读）**：在线 MiMo TTS 流式逐句朗读（首句立即合成 + 后续按播放时间轴批量合并预生成），AudioContext 播放，barge-in（开口打断并掐断当前生成），9 款音色/风格/断句静音时长可配，工具调用口语播报（含 TTS 短语缓存）

**会话管理**
- 侧栏搜索（标题过滤 + **全文消息搜索**：SQLite LIKE 预筛 + JS 精确过滤，命中消息跳转滚动定位 + 高亮）
- 置顶组 / 日期分组（今天/昨天/7天内/30天内/更早）/ 已归档组三级组织
- 删除入回收站（软删除，30 天自动清理 + 设置页手动清空）
- 重命名 / 导出（Markdown / JSON，弹系统保存对话框）
- **会话压缩自动 + 手动并存**：自动压缩按未压缩上下文估算 token 达模型窗口阈值（默认 75%，可配）时静默触发，失败不阻断；手动压缩带上下文占用确认弹窗；互斥锁防并发
- 每会话独立模型，切换即驱逐 Agent 生效

**模型管理**
- 预置目录 11 家服务商（deepseek/openai/anthropic/groq/mistral/xai/openrouter/fireworks/together/cerebras/huggingface）+ 自定义 OpenAI/Anthropic 兼容端点
- 上下文窗口/输出上限/多模态/推理能力字段、测试连接
- API Key `safeStorage` 加密，渲染进程只见 `hasApiKey` 布尔

**Agent / 工具**
- 内置工具：read_file / list_files / write_file / edit_file / bash / web_search（Tavily Web Search API，Key safeStorage 加密，设置页可配）
- 危险工具（write_file/edit_file/bash）执行前权限确认弹窗（autoApprove 免确认 / timeoutSec 倒计时 / 拒绝可 block / 支持 abort），bash 支持持久白名单
- 工具级启用开关、并行/串行执行模式
- **子代理（subagent）**：`task` 工具委派 plan（只读白名单）/ general（全量工具）两类子代理，独立上下文运行并回传结果，主代理同轮可并行多个委派
- **计划模式（plan-mode）**：enter_plan_mode → 规划（bash 等被拦截）→ exit_plan_mode 提交计划 → 前端审批条批准/拒绝（带反馈）→ 批准后预登记命令本 run 免确认 + 计划落库 + 进度上报，与 Claude Code EnterPlanMode 一致
- **长期记忆工具**：memory list/add/update/delete_memory 四个工具，会话可实时读写记忆

**知识库（RAG）**
- 文档导入（docx/pdf/xlsx/pptx/csv/md/txt/json/xml/yaml，sha256 去重，源文件归档）→ 切片落库 → 后台批量向量化（OpenAI 兼容 Embedding API，可指向本地 Ollama，`source=model` 复用模型配置或 `source=custom` 自配）
- 检索：FTS5 2-gram 粗筛 + 向量余弦相似度重排的混合检索（未配 embedding 自动退化关键词）
- `search_knowledge` 工具注入命中片段；设置页管理文档/索引状态/换模型重算/搜索测试

**长期记忆**
- 全局记忆条目 CRUD（分类 general/preference/fact/project、自动/手动来源、搜索、清空），硬上限 30 条/3000 字/单条 500 字
- 注入方式：会话 Agent 实例首次创建时**全量固化进 systemPrompt**（保证前缀缓存命中），本会话内不随编辑变动（⚠️ 非「相关度向量注入」）

**技能市场（Skills）**
- 远程在线市场闭环：find-skill（字节 FindSkill + 腾讯 SkillHub 双源搜索，无需 Key，标注本地已装）→ install-skill（zip 安全解压校验）→ read-skill（读 SKILL.md/包内文件）；技能落盘 `userData/skills/`
- 设置页「技能」：搜索管理 + 已安装列表（启停/删除/打开目录）；实际执行仍由 Agent 按其 SKILL.md 调已有工具/bash 完成

**MCP 生态**
- @modelcontextprotocol/sdk 客户端：stdio + streamable HTTP 双传输
- 设置页「工具与扩展」管理 MCP server（CRUD/启停/连接测试/状态与错误查看）
- 工具注入 Agent（server 名前缀防冲突，配置变更自动 reload + 驱逐 Agent 使下一轮生效）

**桌面化（应用级）**
- 自定义无边框窗口（BaseWindow + 双 WebContentsView，弹窗不遮标题栏）、窗口控制
- **托盘驻留**：Tray + 菜单（显示/隐藏、新建对话、打开设置、退出）；「关闭到托盘」设置开关（默认关闭；开启则关窗驻留，macOS 行为不变）
- **系统通知**：notifier（Electron Notification，设置开关控制，点击唤窗/打开文件）+ `notify` 工具（Agent 请求「完成后通知我」）；触发场景：任务失败、prompt 兜底失败、设置页测试
- **多工作区多窗口**：工作区 = 项目目录，每工作区独立窗口 + 会话列表隔离 + 项目级 agent.md 记忆 + 独立主题色；侧栏工作区标识卡、设置页工作区管理，启动恢复多窗口
- 开机自启开关、窗口置顶（状态跟踪）
- **全局快捷键呼出：未实现**（仅窗内 Cmd+N 新建对话）

**设置与外观**
- 系统提示、7 级思考级别（off~max）、深浅色 + 跟随系统、语音（VoicePanel：MiMo Key/区域/语言/音色/风格/静音时长）、知识库、记忆、技能、工作区、工具与 MCP 等独立设置页签
- 用量与诊断：消息 tokens/cost 落库，设置页「用量」面板（echarts：7/30/全部范围按天堆叠、按模型分布）
- electron-log 文件日志 + crashReporter 崩溃收集（本地落盘不上报），设置页「数据与诊断」查看/清空日志目录、崩溃转储目录

**工程底座**
- 本地 SQLite（node:sqlite）、双向类型安全 IPC、每会话 Agent LRU（max 8）、自研工具链（Grep/Glob/WebFetch 等）

---

## 2. 功能差距矩阵

图例：✅ 已有　◐ 部分/简易实现　❌ 缺失　— 不适用/未确认
> 注：语音 STT/TTS、知识库 embedding、网页搜索等依赖第三方在线 API（MiMo/Tavily/Ollama）与自配 Key。

### 2.1 输入形态

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 文本输入 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 图片输入（视觉理解） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 文件上传（PDF/Word/CSV） | ✅ | ✅ | ✅ | ✅ | ✅（知识库） |
| 截图/剪贴板粘贴 | ✅ | ✅ | ✅（截图捕获） | ✅ | ✅ |
| 语音输入（STT） | ✅（Silero VAD + 在线 MiMo ASR） | ✅（进阶） | ✅（GPT-Live） | ✅ | ✅ |
| 语音输出（TTS/朗读） | ✅（MiMo TTS 流式朗读 + barge-in） | ✅ | ✅ | ✅ | ✅ |
| 拖拽文件到对话 | ✅ | ✅ | ✅ | ✅ | ✅ |

### 2.2 对话交互

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 流式输出 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Markdown/代码高亮 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 思考过程展示 | ✅ | ✅（扩展思维） | ◐ | ✅ | ✅（思维链） |
| 工具调用展示 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 停止/中止 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 重新生成 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 编辑消息后重发 | ◐（仅失败编辑/recall/分支回填） | ✅ | ✅ | ✅ | ✅ |
| 分支对话（branch） | ✅（消息级 fork 至新会话） | ✅ | ❌ | ❌ | ✅ |
| Artifacts/画布（可交互预览） | ◐（仅对话内 ECharts 交互块） | ✅（Artifacts） | ✅（Canvas） | ◐ | ✅ |
| 消息内表格/图表渲染 | ◐（Markdown 表 + ECharts 块） | ✅（Mermaid/SVG） | ✅ | ✅ | ✅ |
| 消息分享/生成链接 | ❌ | ✅ | ✅ | ❌ | ✅ |
| 全文消息搜索 | ✅ | ✅ | ✅ | ✅ | ✅ |

### 2.3 会话与内容组织

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 会话列表/搜索/删除 | ✅（删除入回收站） | ✅ | ✅ | ✅ | ✅ |
| 会话重命名 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 会话置顶/归档/固定 | ✅（置顶 + 归档分组） | ✅ | ✅（pin） | ✅ | ✅ |
| 日期分组 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 会话导出（JSON/MD） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 会话导入 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 数据备份/恢复 | ❌（SQLite 单文件） | — | ✅（云端） | ✅ | ✅ |
| 长期记忆（跨会话） | ◐（可编辑条目 + 全量固化注入，无相关度向量排序） | ◐（Projects 内） | ✅（Memory） | ✅ | ✅ |
| 项目/知识库（RAG） | ✅（FTS5 + embedding 余弦混合检索） | ✅（Projects） | ✅（Projects） | ✅ | ✅（知识库） |
| 定时任务/计划任务 | ❌ | ❌ | ✅（Scheduled Tasks） | ✅（豆包定时任务） | ✅ |
| 会话压缩（上下文管理） | ✅（自动阈值触发 + 手动） | ✅（自动） | ✅ | ✅ | ✅ |

### 2.4 Agent 与生态

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 文件读写/目录操作 | ✅ | ✅（经 MCP） | ✅ | ✅ | ✅ |
| Shell 执行 | ✅ | ✅ | ✅（Codex） | ✅ | ◐ |
| 网页搜索 | ✅（Tavily，需配 Key） | ✅ | ✅ | ✅ | ✅ |
| MCP 协议支持 | ✅（stdio/HTTP） | ✅ | ✅（Plugins） | ✅（MCP/插件） | ✅（一键装 MCP） |
| 多 Agent 协作/子任务 | ✅（plan/general 子代理委派，可并行） | ◐（Cowork/Dispatch） | ✅（Work 多 Agent） | ✅（Kimi 300 并发） | ✅（Agent 组） |
| 浏览器操作 | ❌ | ✅（Computer Use/Cowork） | ✅（内置浏览器） | ✅（WebBridge） | ❌ |
| 电脑屏幕操作（Computer Use） | ❌ | ✅（Cowork） | ✅（Computer Use） | ◐ | ❌ |
| 代码沙箱/运行代码 | ❌（bash 直连本机，无隔离） | ✅ | ✅（数据分析） | ✅ | ❌ |
| 插件/技能市场 | ✅（字节/腾讯双源在线技能） | ✅（MCP 生态） | ✅（Plugin Directory） | ✅（Skills） | ✅（插件市场） |
| 权限确认机制 | ✅（危险工具弹窗 + autoApprove + 倒计时） | ✅（逐应用授权） | ✅ | ✅ | ◐ |

### 2.5 应用级基建（桌面端）

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 自定义窗口/标题栏 | ✅ | ✅ | ✅ | ✅ | — |
| 深浅色主题 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 托盘（Tray）驻留 | ✅（关闭到托盘开关 + 菜单） | ✅ | ✅ | ✅ | ◐ |
| 全局快捷键呼出 | ❌（仅窗内 Cmd+N） | ✅ | ✅（Option+Space） | ✅ | ❌ |
| 窗口置顶 | ✅（状态跟踪） | ✅ | ✅ | ✅ | ❌ |
| 开机自启 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 系统通知 | ✅（notifier + notify 工具） | — | ✅ | ✅ | ✅ |
| 自动更新 | ❌（publish 占位，无 electron-updater） | ✅ | ✅ | ✅ | ✅ |
| 崩溃上报/日志 | ✅（electron-log + crashReporter 本地） | ✅ | ✅ | ✅ | ◐ |
| 首次启动引导/Onboarding | ◐（欢迎卡 + 无模型引导卡，无分步向导） | ✅ | ✅ | ✅ | ✅ |
| 命令面板（Cmd+K） | ❌ | ◐ | ✅ | ✅ | ✅ |
| 快捷键帮助页 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 国际化（i18n） | ❌（硬编码中文） | ✅ | ✅ | ✅ | ✅ |
| 多窗口/多工作区 | ✅（工作区=项目目录+独立窗口） | ❌ | ✅（Chat/Work/Codex） | ◐ | ✅ |
| 用量/Token 统计面板 | ✅（设置页用量页） | ✅ | ✅ | ✅ | ✅ |

### 2.6 工程与质量

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 单元测试 | ❌（无测试脚本） | — | — | — | ✅（Vitest） |
| E2E 测试 | ❌ | — | — | — | ✅（Playwright） |
| CI/CD | ❌ | ✅ | ✅ | ✅ | ✅ |
| 性能监控/遥测 | ❌ | ✅ | ✅ | ✅ | ◐ |
| 数据加密存储 | ✅（safeStorage） | ✅ | ✅（云端） | ✅ | ◐ |
| 本地优先/隐私 | ✅（全本地 SQLite） | ◐（需 MCP 才本地） | ❌（云端为主） | ◐ | ✅ |

---

## 3. 差距统计汇总

统计口径：上表 6 个维度共 **61 项**能力（2.2 为 12 项、2.3 为 11 项含会话压缩）。本次复核（2026-09-02）相对 08-04 快照：原 27 项缺失中 8 项已实现、3 项升级为部分实现。

| 维度 | 项数 | ✅ 已有 | ◐ 部分 | ❌ 缺失 | 缺失率 |
|---|---|---|---|---|---|
| 输入形态 | 7 | 7 | 0 | 0 | 0% |
| 对话交互 | 12 | 8 | 3 | 1 | 8% |
| 会话与内容组织 | 11 | 7 | 1 | 3 | 27% |
| Agent 与生态 | 10 | 7 | 0 | 3 | 30% |
| 应用级基建 | 15 | 9 | 1 | 5 | 33% |
| 工程与质量 | 6 | 2 | 0 | 4 | 67% |
| **合计** | **61** | **40** | **5** | **16** | **26%** |

> 完全对齐 40/61（66%）；若将 ◐ 一并计为「未完全对齐」，则 21/61（34%）仍有打磨空间。

**按缺失原因归类（16 项 ❌）：**

| 缺失类型 | 数量 | 代表项 |
|---|---|---|
| 重 Agent 生态（依赖引入重型运行时） | 3 | 浏览器操作、Computer Use、代码沙箱 |
| 数据回流/资产管理 | 3 | 会话导入、数据备份/恢复、消息分享 |
| 桌面基建残余 | 2 | 全局快捷键呼出、自动更新（真实 publish 源） |
| 产品打磨 | 3 | 命令面板、快捷键帮助页、i18n |
| 编排补充 | 1 | 定时任务（原暂缓前提已解除） |
| 工程与质量 | 4 | 单元测试、E2E、CI、性能监控 |

**◐ 待完善（5 项）**：长期记忆相关度向量注入、Artifacts 通用画布、首次启动分步向导、编辑消息后重发、消息内 Mermaid/SVG 图表渲染。

---

## 4. 核心差距解读

**1. 输入形态已 100% 补齐，语音为在线 API 依赖**
语音 STT（Silero VAD 断句 + MiMo ASR）与 TTS（MiMo 流式朗读 + barge-in 打断 + 工具播报）均已落地，07-30 快照的输入形态最后缺口已关闭。代价是语音链路依赖第三方在线 API（MiMo Key），与 Tavily 网页搜索同属「自配 Key」形态；后续可评估离线 TTS/ASR 或本地模型兜底。

**2. RAG 与记忆已落地，剩「相关度注入」增强项**
知识库（embedding 余弦混合检索 + 文档管理 UI）与长期记忆（可编辑条目、上限 30 条）均已落地。已知差距：记忆注入是**全量固化进 systemPrompt**而非按相关度向量排序（FTS 仅服务面板搜索）——升级路径可复用 embedding.ts + searchKnowledge 混合检索架构，为记忆域补向量即可。另有名实不符的旧文档表述已在 2.3 修正。

**3. Agent 编排已分层，剩余三座「重生态」大山**
MCP（stdio/HTTP）、子代理委派（task：plan 只读 / general 全量 + 并行）、计划模式（规划→审批→执行）、在线技能市场、定时任务所需的托盘/通知基建均已就位，编排层已不再是瓶颈。真正的差距是需要引入重型运行时的能力：浏览器操作（playwright/CDP）、Computer Use（屏幕截图 + 鼠标键盘控制）、代码沙箱（隔离执行运行时）——这三项目前只有 web-fetch 文本抓取与直连本机 bash。

**4. 桌面基建只剩「全局快捷键 + 自动更新」**
托盘驻留、系统通知、多工作区独立窗口、开机自启、窗口置顶、日志/崩溃本地收集已全部补齐。仍缺：全局快捷键呼出主窗口（`globalShortcut`，仅窗内 Cmd+N）、真实自动更新（electron-builder.yml publish 仍为 example.com 占位且未引入 electron-updater）。面向真实分发（macOS 需 notarize + 真实 publish 源）前必须补齐。

**5. 会话资产仍单向流出**
导出（MD/JSON）与分支（fork 到新会话）已支持，但无导入/备份/恢复/分享，用户数据仍困在本地单机，缺少对抗锁定的「回流」通道。注意会话 JSON 导出结构（app/version/exportedAt/session/messages）已为将来的导入预留解析依据。

**6. 工程与质量全空白**
无单元测试、无 E2E、无 CI/CD、无性能遥测。相比 LobeChat 的 Vitest + Playwright，随着 Agent 编排（子代理/计划模式/压缩/权限）复杂度上升，回归风险在累积。

---

## 5. 建议优先级（Roadmap 草案）

> 状态图例：✅ 已完成　◐ 部分完成　⏳ 待做　🔭 远期
> 更新说明：2026-09-02 复核，已将语音、托盘、通知、子代理、分支、RAG、技能市场、工作区等标记为完成，并重新编号。

**P0（体验闭环）—— 全部完成 ✅**
1. ✅ 图片/文件拖拽上传与粘贴（视觉多模态入口）
2. ✅ 全文消息搜索（标题 + 消息内容，命中跳转高亮）
3. ✅ 会话置顶 / 归档
4. ✅ 会话导出（Markdown/JSON）
5. ✅ 语音输入/输出闭环（Silero VAD + MiMo ASR/TTS，流式朗读 + barge-in）
6. ✅ 分支对话（消息级 fork 至新会话）

**P1（桌面化能力）**
7. ✅ 系统托盘驻留（关闭到托盘开关 + 托盘菜单）
8. ✅ 系统通知（Agent 完成/失败 + notify 工具）
9. ⏳ 全局快捷键呼出（Option+Space / 全局注册，`globalShortcut`）—— 待做
10. ⏳ 自动更新（electron-updater + 真实 publish 源）—— 待做（分发前必做）
11. ✅ 开机自启 / 窗口置顶开关
12. ✅ 日志与崩溃上报（electron-log + crashReporter 本地，设置页查看/清空）
13. ✅ 多工作区多窗口（工作区 = 项目目录 + 独立窗口/会话/agent.md）

**P2（Agent 生态）**
14. ✅ MCP client（stdio/HTTP 双传输，设置页 CRUD/测试/状态，工具注入，变更自动 reload）
15. ✅ 本地知识库 RAG（OpenAI 兼容 Embedding + FTS5 余弦混合检索，文档管理 UI）
16. ◐ 长期记忆（可编辑条目 + 全量固化注入）—— 待做：相关度向量注入（复用 embedding 架构为记忆域补向量）
17. ✅ 多 Agent 子代理与计划模式（task：plan/general 委派 + 并行；enter/exit_plan_mode + 审批条）
18. ✅ 在线技能市场（字节/腾讯双源：搜索 → 安装 → 发现闭环）
19. ⏳ 定时任务（配合 Agent 编排）—— 待做（原「等常驻/通知基建」暂缓前提已解除，托盘 + 系统通知均已落地，可重新评估）

**P3（打磨与发行）**
20. ◐ 首次启动引导（已有空会话欢迎卡 + 无模型引导卡）—— 待做：分步 Onboarding、快捷键帮助页、命令面板（Cmd+K）
21. ✅ 用量/Token 统计面板（echarts 按天堆叠 + 模型分布，7/30/全部范围）
22. ⏳ i18n（至少 UI 文案外置，当前硬编码中文）—— 待做
23. ⏳ 数据回流：会话导入 / 备份恢复 / 消息分享 —— 待做
24. ⏳ 单元测试 + CI（含 E2E）—— 待做
25. 🔭 浏览器操作 / Computer Use / 代码沙箱 —— 远期（需引入 playwright/CDP/隔离运行时等重型框架）

---

## 6. 参考来源

- Claude Desktop：Projects / Custom Instructions / Artifacts / MCP / Extended Thinking / Computer Use（Cowork）
  - https://claudelab.net/en/articles/claude-ai/claude-desktop-app-complete-guide-2026
  - https://www.clauder-navi.com/en/claude-pc-control
  - https://lotus.blog.csdn.net/article/details/162375731
- ChatGPT Desktop：Chat + Work + Codex、Memory、Voice（GPT-Live）、Screenshot、Always-on-top、Scheduled Tasks、Projects
  - https://help.openai.com/en/articles/11391654
  - https://help.openai.com/zh-hans-cn/articles/9260256
  - https://aimemory.pro/blog/chatgpt-desktop-app-memory
- 豆包电脑版：操作本地电脑/浏览器、Skills、定时任务、Office 套件
  - https://www.doubao.com/download/desktop
- Kimi Work：本地 Agent、300 并发、MCP 插件、多格式产出、Goal Mode
  - https://www.kimi.com/resources/kimi-work-introduction
- LobeChat：MCP 一键安装、分支对话、知识库、TTS/STT、插件/Agent 市场、多模型
  - https://www.npmjs.com/package/@lobehub/chat
  - https://aicoolies.com/reviews/lobechat-review
