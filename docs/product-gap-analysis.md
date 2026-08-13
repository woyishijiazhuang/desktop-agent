# 产品差距分析：桌面助手 vs 主流 AI 客户端

> 统计日期：2026-08-04
> 分析对象：本仓库「桌面助手」（Electron + Vue3 + TS，基于 pi-agent-core/pi-ai）
> 对比基准：Claude Desktop、ChatGPT Desktop（含 Codex/Work）、豆包电脑版、Kimi Work、LobeChat（开源代表）
> 结论先行：**核心对话体验已对齐主流，输入形态（图片/文件/截图/拖拽）与 MCP 生态已补齐。当前差距集中在「语音交互」「记忆与知识库」「Agent 编排（多 Agent/浏览器/沙箱/定时）」「桌面基建残余（托盘/全局快捷键/自动更新/通知）」四大块。**

---

## 1. 项目现状盘点（已有能力）

依据代码与文档（[docs/backend.md](backend.md) / [docs/frontend.md](frontend.md)）核实：

**对话核心**
- 流式 Markdown 渲染（markstream-vue 增量渲染、代码块复制/高亮、ECharts 自定义块）
- 思考过程展示（ReasoningBlock，防注入纯文本展示）
- 工具调用卡片（参数 JSON 高亮、状态实时更新、默认折叠）
- 中止 / 重试 / 重新生成 / 编辑（recall 回填输入框）
- 临时空对话（ephemeral，首条消息才落库）

**输入形态**
- 图片/文件拖拽上传、剪贴板粘贴、文件选择（PDF/Word/CSV 经 doc-parser 提取文本）
- 附件本地落盘：图片存 `userData/attachments/`，DB 只存 `file:` 引用，删除会话/清空回收站级联清理附件

**会话管理**
- 侧栏搜索（标题过滤 + **全文消息搜索**：SQLite LIKE 预筛 + JS 精确过滤，命中消息跳转滚动定位 + 高亮）
- 置顶组 / 日期分组（今天/昨天/7天内/30天内/更早）/ 已归档组三级组织
- 删除入回收站（软删除，30 天自动清理 + 设置页手动清空）
- 重命名 / 导出（Markdown / JSON，弹系统保存对话框）、会话压缩（LLM 摘要 + 乐观锁）
- 每会话独立模型，切换即驱逐 Agent 生效

**模型管理**
- 预置目录 11 家服务商（deepseek/openai/anthropic/groq/mistral/xai/openrouter/fireworks/together/cerebras/huggingface）+ 自定义 OpenAI/Anthropic 兼容端点
- 上下文窗口/输出上限/多模态/推理能力字段、测试连接
- API Key `safeStorage` 加密，渲染进程只见 `hasApiKey` 布尔

**Agent / 工具**
- 内置工具：read_file / list_files / write_file / edit_file / bash / web_search（Tavily Web Search API，Key safeStorage 加密，设置页可配）
- 危险工具（write_file/edit_file/bash）执行前权限确认弹窗，拒绝可 block，支持 abort，bash 支持持久白名单
- 工具级启用开关、并行/串行执行模式

**MCP 生态**
- @modelcontextprotocol/sdk 客户端：stdio + streamable HTTP 双传输
- 设置页「工具与扩展」管理 MCP server（CRUD/启停/连接测试/状态与错误查看）
- 工具注入 Agent（server 名前缀防冲突，配置变更自动 reload + 驱逐 Agent 使下一轮生效）

**设置与外观**
- 系统提示、7 级思考级别（off~max）、深浅色 + 跟随系统
- 自定义无边框窗口（BaseWindow + 双 WebContentsView，弹窗不遮标题栏）、窗口控制
- 开机自启开关、窗口置顶（状态跟踪）

**用量与诊断**
- 消息含 tokens/cost 落库，设置页「用量」面板可视化（echarts：7/30/全部范围按天堆叠、按模型分布）
- electron-log 文件日志 + crashReporter 崩溃收集，设置页「数据与诊断」查看日志目录/崩溃转储/清空

**工程底座**
- 本地 SQLite（node:sqlite）、双向类型安全 IPC、每会话 Agent LRU（max 8）

---

## 2. 功能差距矩阵

图例：✅ 已有　◐ 部分/简易实现　❌ 缺失　— 不适用/未确认

### 2.1 输入形态

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 文本输入 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 图片输入（视觉理解） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 文件上传（PDF/Word/CSV） | ✅ | ✅ | ✅ | ✅ | ✅（知识库） |
| 截图/剪贴板粘贴 | ✅ | ✅ | ✅（截图捕获） | ✅ | ✅ |
| 语音输入（STT） | ❌ | ✅（进阶） | ✅（GPT-Live） | ✅ | ✅ |
| 语音输出（TTS/朗读） | ❌ | ✅ | ✅ | ✅ | ✅ |
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
| 编辑消息后重发 | ◐（仅失败编辑/recall） | ✅ | ✅ | ✅ | ✅ |
| 分支对话（branch） | ❌ | ✅ | ❌ | ❌ | ✅ |
| Artifacts/画布（可交互预览） | ❌ | ✅（Artifacts） | ✅（Canvas） | ◐ | ✅ |
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
| 长期记忆（跨会话） | ✅（可编辑记忆条目 + 相关度注入） | ◐（Projects 内） | ✅（Memory） | ✅ | ✅ |
| 项目/知识库（RAG） | ❌ | ✅（Projects） | ✅（Projects） | ✅ | ✅（知识库） |
| 定时任务/计划任务 | ❌ | ❌ | ✅（Scheduled Tasks） | ✅（豆包定时任务） | ✅ |
| 会话压缩（上下文管理） | ✅ | ✅（自动） | ✅ | ✅ | ✅ |

### 2.4 Agent 与生态

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 文件读写/目录操作 | ✅ | ✅（经 MCP） | ✅ | ✅ | ✅ |
| Shell 执行 | ✅ | ✅ | ✅（Codex） | ✅ | ◐ |
| 网页搜索 | ✅（Tavily，需配 Key） | ✅ | ✅ | ✅ | ✅ |
| MCP 协议支持 | ✅（stdio/HTTP） | ✅ | ✅（Plugins） | ✅（MCP/插件） | ✅（一键装 MCP） |
| 多 Agent 协作/子任务 | ❌ | ◐（Cowork/Dispatch） | ✅（Work 多 Agent） | ✅（Kimi 300 并发） | ✅（Agent 组） |
| 浏览器操作 | ❌ | ✅（Computer Use/Cowork） | ✅（内置浏览器） | ✅（WebBridge） | ❌ |
| 电脑屏幕操作（Computer Use） | ❌ | ✅（Cowork） | ✅（Computer Use） | ◐ | ❌ |
| 代码沙箱/运行代码 | ❌ | ✅ | ✅（数据分析） | ✅ | ❌ |
| 插件/技能市场 | ◐（经 MCP 接入，无集中市场） | ✅（MCP 生态） | ✅（Plugin Directory） | ✅（Skills） | ✅（插件市场） |
| 权限确认机制 | ✅（危险工具弹窗） | ✅（逐应用授权） | ✅ | ✅ | ◐ |

### 2.5 应用级基建（桌面端）

| 能力 | 本项目 | Claude | ChatGPT | 豆包/Kimi | LobeChat |
|---|---|---|---|---|---|
| 自定义窗口/标题栏 | ✅ | ✅ | ✅ | ✅ | — |
| 深浅色主题 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 托盘（Tray）驻留 | ❌ | ✅ | ✅ | ✅ | ◐ |
| 全局快捷键呼出 | ❌（仅窗内 Cmd+N） | ✅ | ✅（Option+Space） | ✅ | ❌ |
| 窗口置顶 | ✅（状态跟踪） | ✅ | ✅ | ✅ | ❌ |
| 开机自启 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 系统通知 | ❌ | — | ✅ | ✅ | ✅ |
| 自动更新 | ❌（publish 占位） | ✅ | ✅ | ✅ | ✅ |
| 崩溃上报/日志 | ✅（electron-log + crashReporter） | ✅ | ✅ | ✅ | ◐ |
| 首次启动引导/Onboarding | ❌（空模型引导卡片） | ✅ | ✅ | ✅ | ✅ |
| 命令面板（Cmd+K） | ❌ | ◐ | ✅ | ✅ | ✅ |
| 快捷键帮助页 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 国际化（i18n） | ❌（硬编码中文） | ✅ | ✅ | ✅ | ✅ |
| 多窗口/多工作区 | ❌ | ❌ | ✅（Chat/Work/Codex） | ◐ | ✅ |
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

统计口径：上表 6 个维度共 **61 项**能力（2.2 为 12 项、2.3 为 11 项含会话压缩）。

| 维度 | 项数 | ✅ 已有 | ◐ 部分 | ❌ 缺失 | 缺失率 |
|---|---|---|---|---|---|
| 输入形态 | 7 | 5 | 0 | 2 | 29% |
| 对话交互 | 12 | 7 | 2 | 3 | 25% |
| 会话与内容组织 | 11 | 6 | 0 | 5 | 45% |
| Agent 与生态 | 10 | 5 | 1 | 4 | 40% |
| 应用级基建 | 15 | 6 | 0 | 9 | 60% |
| 工程与质量 | 6 | 2 | 0 | 4 | 67% |
| **合计** | **61** | **31** | **3** | **27** | **44%** |

**按缺失原因归类：**

| 缺失类型 | 数量 | 代表项 |
|---|---|---|
| 纯功能新增（UI + 主进程） | 8 | 语音输入/输出、分支对话、消息分享、会话导入、备份恢复、代码沙箱、多窗口 |
| 依赖模型/生态能力 | 5 | 知识库 RAG、长期记忆、多 Agent、浏览器操作、Computer Use |
| 桌面基建（Electron 能力） | 5 | 托盘、全局快捷键、系统通知、自动更新、定时任务 |
| 产品打磨 | 5 | Artifacts、Onboarding、命令面板、快捷键帮助页、i18n |
| 工程与质量 | 4 | 单元测试、E2E、CI、性能监控 |

---

## 4. 核心差距解读

**1. 语音交互缺失（输入形态仅剩的 2 项缺口）**
图片/文件/截图/拖拽已全部补齐（多模态依赖模型 `multimodal` 字段 + user content block 走通），输入形态缺失率从 86% 降至 29%，剩余缺口集中在语音：STT（语音输入）与 TTS（语音输出/朗读）。主流 2026 年标准输入 = 文本 + 图片 + 文件 + 语音，语音是最后的输入形态补齐项。

**2. 无长期记忆与知识库（RAG）**
Claude Projects / ChatGPT Memory / LobeChat 知识库均提供跨会话上下文。本项目只有「会话压缩」，无全局记忆或项目级知识库。会话 schema 已预留 `parent_session_id`，但未启用派生会话/项目概念。

**3. MCP 已接入，但 Agent 编排未分层**
MCP client（stdio/HTTP 双传输、工具注入、设置页管理）已落地，第三方工具生态打通。剩余差距是多 Agent 协作/子任务、浏览器操作、Computer Use、代码沙箱、定时任务等编排能力——这些依赖 MCP 之上的 Agent 框架层（pi-agent-core 的调度/委派能力）。

**4. 桌面基建剩余 4 项**
开机自启、窗口置顶、日志与崩溃上报已补齐。仍缺：托盘驻留、全局快捷键呼出、系统通知、自动更新（electron-builder.yml 的 publish 仍为 example.com 占位）。面向真实分发（尤其 macOS 需 notarize）之前必须补齐。

**5. 会话资产单向流出**
导出（MD/JSON）、置顶、归档已支持，但无导入/备份/分享，用户数据仍困在本地单机，缺少对抗锁定的「回流」通道。

---

## 5. 建议优先级（Roadmap 草案）

> 状态图例：✅ 已完成　⏳ 等待完善（暂停 / 待做）

**P0（体验闭环）** —— 全部完成 ✅
1. ✅ 图片/文件拖拽上传与粘贴（视觉多模态入口）—— 附件本地落盘重构：图片存 `userData/attachments/`，DB 只存 `file:` 引用，删除会话级联清理；PDF/Word/CSV 经 doc-parser 提取文本
2. ✅ 全文消息搜索（SQLite LIKE 预筛 + JS 精确过滤，搜索会话标题 + 消息内容，命中消息跳转高亮）
3. ✅ 会话置顶 / 归档
4. ✅ 会话导出（Markdown/JSON）

**P1（桌面化能力）**
5. ⏳ 系统托盘 + 全局快捷键呼出（Option+Space）—— 等待完善
6. ⏳ 自动更新（electron-updater + 真实 publish 源）—— 等待完善
7. ✅ 开机自启 / 窗口置顶开关
8. ✅ 日志与崩溃上报（electron-log 文件日志 + crashReporter 本地崩溃收集，设置页「数据与诊断」查看目录）

**P2（Agent 生态）**
9. ✅ MCP client 支持（stdio/HTTP 双传输，设置页 CRUD/测试连接/状态查看，工具注入 Agent，配置变更自动 reload）
10. 本地知识库（简单 RAG：目录/文件向量化检索）—— 待做
11. ✅ 长期记忆（可编辑记忆条目 + 相关度注入，参考 ChatGPT Memory 的轻量实现；全局单层，独立上下文块注入不干扰自定义系统提示词）
12. 定时任务（配合 Agent 编排）—— ⏳ 暂缓（依赖托盘 + 系统通知基建；当前「打开即聊」的被动应答形态无主动触达场景，等常驻/通知落地后重新评估）

**P3（打磨与发行）**
13. 首次启动引导、快捷键面板、命令面板（Cmd+K）—— 待做
14. ✅ 用量/Token 统计面板（echarts 按天堆叠 + 模型分布，7/30/全部范围，数据已落库）
15. i18n 骨架（至少 UI 文案外置）—— 待做
16. 单元测试 + CI —— 待做

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
