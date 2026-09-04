# 首屏加载提速与「首帧即完整页面」技术方案

> 记录时间：2026-09-04
> 状态：**讨论完成，尚未实施**（含实施范围决策与后续待办）
> 背景：用户反馈「项目加载时首页较慢，特别是从聊天窗口打开设置窗口时窗口先打开后加载」，并追问是否有方案让打包后的应用不再「空页面 + JS」，而是像原生 HTML 一样一开始就有页面。

---

## 目录

1. [问题现象](#1-问题现象)
2. [根因分析（基于现状代码与构建产物）](#2-根因分析基于现状代码与构建产物)
3. [方案一：入口 HTML 内联骨架屏](#3-方案一入口-html-内联骨架屏)
4. [方案二：设置窗口独立轻量入口](#4-方案二设置窗口独立轻量入口)
5. [方案三（可选）：首屏 JS 瘦身](#5-方案三可选首屏-js-瘦身)
6. [引申讨论：像原生 HTML 一样首帧即有完整页面](#6-引申讨论像原生-html-一样首帧即有完整页面)
7. [建议实施顺序与验证清单](#7-建议实施顺序与验证清单)
8. [决策记录与待办](#8-决策记录与待办)

---

## 1. 问题现象

1. 工作区首页加载较慢，打开时存在明显空白期。
2. 「从聊天窗口打开设置窗口」时，窗口先弹出、内容后加载，体感很差。
3. 诉求：打包后的应用希望「一开始就能有页面」，而不是「空页面 + JS 现画」。

## 2. 根因分析（基于现状代码与构建产物）

| 现象 | 根因 |
|---|---|
| 首页白屏、加载慢 | [index.html](file:///e:/code/desktop-agent/src/renderer/index.html) 中 `#app` 为空，首帧无可绘制内容；内容需等整个入口 JS 下载 → 解析 → 执行 → Vue 挂载后才出现。构建产物实测：入口 chunk 约 **3.9MB**（`out/renderer/assets/index-*.js`）+ 1.1MB 预载 chunk |
| 从聊天打开设置窗口「先开窗后加载」 | 工作区窗口与设置窗口**加载同一个 SPA**，仅 hash 不同（见 [window-manager.ts](file:///e:/code/desktop-agent/src/main/service/window-manager.ts) `loadAppViews`）。新建设置窗口 = 新 webContents **重新下载并解析整份 ~5MB 聊天应用**，再懒加载 ~440KB 的 `SettingsView` chunk 后才出现界面 |
| 参照系 | [src/renderer/header/index.html](file:///e:/code/desktop-agent/src/renderer/header/index.html) 是无框架静态页（HTML + 少量 TS），从不感觉慢 —— 印证「独立轻量入口 + 静态首帧」是项目内已验证的模式 |

相关文件：多页入口配置见 [electron.vite.config.ts](file:///e:/code/desktop-agent/electron.vite.config.ts)（`rendererInput` 已含 `index` + `header`）；`SettingsView` 位于 [views/SettingsView.vue](file:///e:/code/desktop-agent/src/renderer/src/views/SettingsView.vue)，经路由懒加载。

## 3. 方案一：入口 HTML 内联骨架屏

**目标**：窗口一出现就有可辨识的页面占位，消除「空页面」白屏期。

- 做法：在入口 HTML `<body>` 直接写静态骨架 DOM + 内联 `<style>`，**不依赖任何 JS**。
  - 骨架做**通用品牌占位**（logo + 标题 + 简单线条/色块区域），不做像素级 UI 复刻：复用成本低，且对工作区/设置两类窗口都适配，避免无 JS 时按 hash 分支的麻烦。
  - 颜色内联写**明暗两套**（`prefers-color-scheme`），与主进程 `WINDOW_BG_DARK/LIGHT`（[window-manager.ts](file:///e:/code/desktop-agent/src/main/service/window-manager.ts)）对齐，避免深色模式闪白。
- CSP 约束：项目 CSP 禁止内联 `script`，但放行内联 `style`（`style-src 'self' 'unsafe-inline'`），故内联 CSS 合法；骨架的淡出/移除只能由打包 JS 完成。建议骨架作为 `#app` 的兄弟节点、由 `App.vue onMounted` 后移除；或放 `#app` 内由 `mount()` 整体替换（瞬时切换，无动画）。
- 收益：白屏 → 首帧即见窗口底色与占位 UI。
- 风险：低，纯 HTML/CSS 改动。

## 4. 方案二：设置窗口独立轻量入口

**目标**：设置窗口不再加载整份聊天 SPA，只加载设置页自身所需依赖。

- 复用项目已有的多页能力（`rendererInput`），拆分步骤：
  1. 新增 `src/renderer/settings.html` + 精简入口（独立 `main.ts`）。
  2. 入口最小引导：仍挂 `NConfigProvider / NMessageProvider / NDialogProvider` + Pinia + **迷你路由**（单条 `/settings` 路由，满足 `SettingsView` 对 `useRoute` 读 tab 的依赖）；**不引导 chat 相关代码**（聊天 store、sidebar、markstream、语音等不进加载图）。
  3. 渲染层服务按需裁剪：[service/index.ts](file:///e:/code/desktop-agent/src/renderer/src/service/index.ts) 现有 5 个服务，只保留设置页真正用到的（settings-sync / theme-sync / model-config-sync / ui-service 大概率需要，agent-event 等不需要）；实施前需逐一盘点各设置面板引用的 store/service。
  4. [window-manager.ts](file:///e:/code/desktop-agent/src/main/service/window-manager.ts) `loadAppViews`：设置窗口（`workdir === null`）contentView 改载 `settings.html`，不再带 hash；初始 tab 改经 query（`settings.html?tab=...`）注入，保持「首帧即正确 tab」。
  5. 共享代码（store/service 基础模块）由 Rollup 自动抽成 shared chunk，各窗口只加载自己需要的部分。
- 收益：设置窗口加载量从 ~5MB 降至仅设置相关依赖（聊天独有的大件被排除是主要收益）。
- 风险与回归点：需确认设置入口同样走 `window.initWindow` 等主进程窗口初始化链路；回归验证 tab 记忆、「管理工作区」跳转（`openSettingsTab`）、主题/模型配置同步、标题栏模式切换后的 `recreateAllWindows`（重建含设置窗口，需覆盖新加载分支）。

## 5. 方案三（可选）：首屏 JS 瘦身

- echarts：[main.ts](file:///e:/code/desktop-agent/src/renderer/src/main.ts) 静态 import `EChartsBlock` → 使 echarts 打进入口；改为 markstream 自定义组件按需动态注册（渲染到 ```` ```echarts ```` 代码块时才加载）。
- 大件清出入口静态链：用构建分析（如 `rollup-plugin-visualizer`）量化后逐个处理。
- 收益：入口 3.9MB → 目标约 1.5~2.5MB；对工作区与设置窗口均有效，但不改变「设置窗口复用聊天 SPA」的结构问题，故排在方案二之后。

## 6. 引申讨论：像原生 HTML 一样首帧即有完整页面

**本质**：Vue 白屏并非框架缺陷，而是 SPA 的 DOM 全部在浏览器内由 JS 现画、HTML 里只有空壳。要实现「首帧即完整页面」，唯一路径是**让 HTML 文件本身携带真实 DOM**（原生 HTML 即此模式）。可用方案分三类：

| 方案 | 原理 | 首帧效果 | 适配本项目 | 代价 |
|---|---|---|---|---|
| A. 构建期预渲染（SSG）：`vite-ssg` / 预渲染插件 | 构建时在 Node 中跑 Vue 各路由，将结果固化为每路由的静态 HTML；窗口直接加载该 HTML，随后 Vue hydrate 接管 | 页面结构与样式立刻可见 | 聊天页不现实：数据全来自 DB/IPC 异步查询，预渲染只能固化静态壳 | renderer 强依赖 preload/IPC（initWindow、主题、DB），预渲染环境无这些 API，需大量 mock/跳过；静态壳收益≈骨架屏。**不建议** |
| B. MPA 原生多页（无框架或框架只做局部增强） | 每条路由/窗口 = 独立 HTML，HTML 直接写死完整结构（同 header 视图模式） | 打开即是完整页面，无 JS 也可显示 | 适合结构静态页面；设置页整体结构固定，属此列 | 若完全不用 Vue，十几张设置面板（表单/表格/弹窗）原生重写工作量很大 |
| C. Vue 但「静态 HTML + 局部挂载」（务实折衷） | 各窗口 HTML 先写好完整静态布局（真实结构/文字/样式），Vue 只负责挂载并填充动态数据 | 首帧即完整页面、无白屏 | 设置窗口契合；聊天页仍以骨架 + 瘦身为主 | 需为页面写静态首版布局，改动中等 |

**关键认知**：
1. 「完整页面」≠「完整数据」：聊天记录、设置值等运行时从 DB/IPC 获取的内容，任何技术都只能后填；原生 HTML 能做到的是页面结构/样式/文字在 HTML 里即完整，数据到达前看到的是真实页面而非空白。
2. 聊天页不适合逃离 JS：消息流、工具卡片、Markdown 高亮等几乎全动态且强依赖 IPC，预渲染收益低、mock 成本高；其「原生感」用骨架 + 入口瘦身即可接近。
3. 设置窗口才是值得改造的对象：独立小窗口、结构静态，契合「首帧即完整页面」诉求。

**结论建议**：设置窗口采用上表 B/C 混合 —— 独立 HTML 入口 + HTML 内置完整静态布局，Vue 挂载只做局部填充（保留 Vue 写面板的效率，不必原生重写）；聊天首页维持 Vue + 骨架屏。

## 7. 建议实施顺序与验证清单

1. 先做骨架屏（独立、低风险）→ 立即消除白屏。
2. 再做设置窗口独立轻量入口 → 设置窗口快速就绪（可视需求并做静态化改造）。
3. 入口 JS 瘦身视前两步效果决定。

验证清单：`pnpm build && pnpm start` 后逐项回归 ——
- 工作区首页首帧；
- 从聊天点设置按钮 / 托盘打开设置窗口；
- 设置窗口 tab 记忆与跳转；
- 暗 / 亮主题切换；
- 模型管理、语音、```` ```echarts ```` 代码块图表；
- 标题栏模式切换（`recreateAllWindows` 窗口重建，两种窗口的新加载分支均需覆盖）。

## 8. 决策记录与待办

- 2026-09-04：完成多轮讨论（根因分析、三方案、静态化可行性）。
- 用户当前选择：**仅记录方案，暂不改代码**。
- 待办 / 待决策：
  - [ ] 是否开始实施（建议按第 7 节顺序：骨架屏 → 设置窗口独立入口）；
  - [ ] 若实施，设置窗口采用「独立入口 + 静态布局」还是先只做「独立轻量 Vue 入口」；
  - [ ] 首屏瘦身（echarts 按需化）是否纳入本期。
