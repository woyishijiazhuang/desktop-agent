# 首屏加载提速与「首帧即完整页面」技术方案

> 首记时间：2026-09-04（讨论完成，用户选择「仅记录，暂不改代码」）
> 后续进展：**设置窗口独立轻量入口（方案二）已落地**；2026-09-09 用户**放弃骨架屏（方案一）**，仅实施 **echarts 按需加载（方案三第 1 条）**，本文档随实施刷新构建数据与状态。
> 背景：用户反馈「项目加载时首页较慢，特别是从聊天窗口打开设置窗口时窗口先打开后加载」，并追问是否有方案让打包后的应用不再「空页面 + JS」，而是像原生 HTML 一样一开始就有页面。
>
> 说明：文中 `file:///e:/code/desktop-agent/...` 链接为最初记录时所在环境路径；代码现位于 `/Users/hupengfei/Documents/my-app`，本文新增引用均已按当前路径书写。

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

| 现象                     | 现状（2026-09-09）                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 首页白屏、加载慢         | [index.html](file:///Users/hupengfei/Documents/my-app/src/renderer/index.html) 中 `#app` 为空，首帧无可绘制内容；内容需等入口 JS 下载 → 解析 → 执行 → Vue 挂载后才出现。干净构建实测（`out/renderer/assets`，minified）：入口 `index-*.js` 约 **1.27MB**；echarts 此前以 modulepreload 随启动预载（独立 `echarts-*.js` 约 **1.9MB**），2026-09-09 已改按需加载（见 §5），窗口首启 JS ≈ 4.0MB → ≈ 2.1MB |
| 设置窗口「先开窗后加载」 | **已解决（方案二落地）**：设置窗口改载独立轻量入口 `settings/index.html`，不再加载聊天 SPA 静态链（见 [window-manager.ts](file:///Users/hupengfei/Documents/my-app/src/main/infra/window-manager.ts#L248-L267) `loadAppViews` 与 [electron.vite.config.ts](file:///Users/hupengfei/Documents/my-app/electron.vite.config.ts#L37-L44) `rendererInput`）                                                 |
| 参照系                   | [header/index.html](file:///Users/hupengfei/Documents/my-app/src/renderer/header/index.html) 是无框架静态页（HTML + 少量 TS），从不感觉慢 —— 印证「独立轻量入口 + 静态首帧」是项目内已验证的模式                                                                                                                                                                                                       |

相关文件：多页入口配置见 [electron.vite.config.ts](file:///Users/hupengfei/Documents/my-app/electron.vite.config.ts)（`rendererInput` 含 `index` / `header` / `settings` 三个入口）；设置窗口内容在 [src/renderer/settings/](file:///Users/hupengfei/Documents/my-app/src/renderer/settings/index.html)；`SettingsView` 的原单文件结构已随方案二拆分为 `settings/` 下多视图。

## 3. 方案一：入口 HTML 内联骨架屏

> 决策（2026-09-09）：**不采纳**——用户明确不要骨架屏。本节保留供参考。

**目标**：窗口一出现就有可辨识的页面占位，消除「空页面」白屏期。

- 做法：在入口 HTML `<body>` 直接写静态骨架 DOM + 内联 `<style>`，**不依赖任何 JS**。
  - 骨架做**通用品牌占位**（logo + 标题 + 简单线条/色块区域），不做像素级 UI 复刻：复用成本低，且对工作区/设置两类窗口都适配，避免无 JS 时按 hash 分支的麻烦。
  - 颜色内联写**明暗两套**（`prefers-color-scheme`），与主进程 `WINDOW_BG_DARK/LIGHT`（[window-manager.ts](file:///e:/code/desktop-agent/src/main/infra/window-manager.ts)）对齐，避免深色模式闪白。
- CSP 约束：项目 CSP 禁止内联 `script`，但放行内联 `style`（`style-src 'self' 'unsafe-inline'`），故内联 CSS 合法；骨架的淡出/移除只能由打包 JS 完成。建议骨架作为 `#app` 的兄弟节点、由 `App.vue onMounted` 后移除；或放 `#app` 内由 `mount()` 整体替换（瞬时切换，无动画）。
- 收益：白屏 → 首帧即见窗口底色与占位 UI。
- 风险：低，纯 HTML/CSS 改动。

## 4. 方案二：设置窗口独立轻量入口

> 状态：**已实施**。落地形态为「独立 Vue 轻量入口」（非 §6 的静态布局）：新增 [src/renderer/settings/](file:///Users/hupengfei/Documents/my-app/src/renderer/settings/index.html) 入口，[loadAppViews](file:///Users/hupengfei/Documents/my-app/src/main/infra/window-manager.ts#L248-L267) 对 `workdir === null` 的窗口直接载 `settings/index.html`，初始 tab 经 hash（`#/settings/<tab>`）注入，首帧即正确分类。下述拆分步骤作为当时的实现要点记录。

**目标**：设置窗口不再加载整份聊天 SPA，只加载设置页自身所需依赖。

- 复用项目已有的多页能力（`rendererInput`），拆分步骤：
  1. 新增 `src/renderer/settings.html` + 精简入口（独立 `main.ts`）。
  2. 入口最小引导：仍挂 `NConfigProvider / NMessageProvider / NDialogProvider` + Pinia + **迷你路由**（单条 `/settings` 路由，满足 `SettingsView` 对 `useRoute` 读 tab 的依赖）；**不引导 chat 相关代码**（聊天 store、sidebar、markstream、语音等不进加载图）。
  3. 渲染层服务按需裁剪：[service/index.ts](file:///e:/code/desktop-agent/src/renderer/src/service/index.ts) 现有 5 个服务，只保留设置页真正用到的（settings-sync / theme-sync / model-config-sync / ui-service 大概率需要，agent-event 等不需要）；实施前需逐一盘点各设置面板引用的 store/service。
  4. [window-manager.ts](file:///e:/code/desktop-agent/src/main/infra/window-manager.ts) `loadAppViews`：设置窗口（`workdir === null`）contentView 改载 `settings.html`，不再带 hash；初始 tab 改经 query（`settings.html?tab=...`）注入，保持「首帧即正确 tab」。
  5. 共享代码（store/service 基础模块）由 Rollup 自动抽成 shared chunk，各窗口只加载自己需要的部分。
- 收益：设置窗口加载量从 ~5MB 降至仅设置相关依赖（聊天独有的大件被排除是主要收益）。
- 风险与回归点：需确认设置入口同样走 `window.initWindow` 等主进程窗口初始化链路；回归验证 tab 记忆、「管理工作区」跳转（`openSettingsTab`）、主题/模型配置同步、标题栏模式切换后的 `recreateAllWindows`（重建含设置窗口，需覆盖新加载分支）。

## 5. 方案三：首屏 JS 瘦身（echarts 按需加载已实施）

- echarts：[main.ts](file:///e:/code/desktop-agent/src/renderer/src/main.ts) 静态 import `EChartsBlock` → 使 echarts 打进入口；改为 markstream 自定义组件按需动态注册（渲染到 ` ```echarts ` 代码块时才加载）。（此条**已实施**，落地记录见下）
- 大件清出入口静态链（**仍为可选，未实施**）：用构建分析（如 `rollup-plugin-visualizer`）量化后逐个处理。
- 收益（旧述，供对照）：入口 3.9MB → 目标约 1.5~2.5MB、不改变「设置窗口复用聊天 SPA」的结构问题——结构问题已由方案二解决。

**已实施（2026-09-09）：echarts 按需加载**

- 组件懒化：[main.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/main.ts) 由静态 `import EChartsBlock` 改为 `defineAsyncComponent(() => import('./components/chat/EChartsBlock.vue'))` 注册进 `setCustomComponents('chat')`——入口只持占位，真正渲染 ` ```echarts ` 代码块时才动态加载组件及其 echarts 依赖（产物：独立 `EChartsBlock-*.js` 懒 chunk）。
- 弹层懒化：[ContextRingButton.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/components/sidebar/ContextRingButton.vue) 移除模块级 echarts import（按钮本体是纯 SVG）；`renderChart` 在「上下文占用」弹层首次打开时才 `import('@renderer/utils/echarts')`。
- 效果（干净构建实测，minified）：echarts ~1.9MB chunk 不再随窗口启动 modulepreload，改为真正用到才加载；首启 JS ≈ **4.0MB → 2.1MB**（入口 `index-*.js` 约 1.27MB、共享 `update-events-service` 约 0.84MB 等不变）。
- 回归要点：消息 ` ```echarts ` 块渲染 / 自动修复降级 / 「重新生成」/ 地图懒加载，与设置页 UsagePanel 饼图、侧栏上下文占用弹层，均走同一 echarts chunk。

## 6. 引申讨论：像原生 HTML 一样首帧即有完整页面

**本质**：Vue 白屏并非框架缺陷，而是 SPA 的 DOM 全部在浏览器内由 JS 现画、HTML 里只有空壳。要实现「首帧即完整页面」，唯一路径是**让 HTML 文件本身携带真实 DOM**（原生 HTML 即此模式）。可用方案分三类：

| 方案                                            | 原理                                                                                                     | 首帧效果                         | 适配本项目                                                     | 代价                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A. 构建期预渲染（SSG）：`vite-ssg` / 预渲染插件 | 构建时在 Node 中跑 Vue 各路由，将结果固化为每路由的静态 HTML；窗口直接加载该 HTML，随后 Vue hydrate 接管 | 页面结构与样式立刻可见           | 聊天页不现实：数据全来自 DB/IPC 异步查询，预渲染只能固化静态壳 | renderer 强依赖 preload/IPC（initWindow、主题、DB），预渲染环境无这些 API，需大量 mock/跳过；静态壳收益≈骨架屏。**不建议** |
| B. MPA 原生多页（无框架或框架只做局部增强）     | 每条路由/窗口 = 独立 HTML，HTML 直接写死完整结构（同 header 视图模式）                                   | 打开即是完整页面，无 JS 也可显示 | 适合结构静态页面；设置页整体结构固定，属此列                   | 若完全不用 Vue，十几张设置面板（表单/表格/弹窗）原生重写工作量很大                                                         |
| C. Vue 但「静态 HTML + 局部挂载」（务实折衷）   | 各窗口 HTML 先写好完整静态布局（真实结构/文字/样式），Vue 只负责挂载并填充动态数据                       | 首帧即完整页面、无白屏           | 设置窗口契合；聊天页仍以骨架 + 瘦身为主                        | 需为页面写静态首版布局，改动中等                                                                                           |

**关键认知**：

1. 「完整页面」≠「完整数据」：聊天记录、设置值等运行时从 DB/IPC 获取的内容，任何技术都只能后填；原生 HTML 能做到的是页面结构/样式/文字在 HTML 里即完整，数据到达前看到的是真实页面而非空白。
2. 聊天页不适合逃离 JS：消息流、工具卡片、Markdown 高亮等几乎全动态且强依赖 IPC，预渲染收益低、mock 成本高；其「原生感」用骨架 + 入口瘦身即可接近。
3. 设置窗口才是值得改造的对象：独立小窗口、结构静态，契合「首帧即完整页面」诉求。

**结论建议**：设置窗口采用上表 B/C 混合 —— 独立 HTML 入口 + HTML 内置完整静态布局，Vue 挂载只做局部填充（保留 Vue 写面板的效率，不必原生重写）；聊天首页维持 Vue + 骨架屏。（注：骨架屏方向 2026-09-09 已由用户否决，此句仅为原讨论结论留存。）

## 7. 实施状态与验证清单

已实施（按时间序）：

1. 设置窗口独立轻量入口（方案二）——设置窗口不再加载聊天 SPA。
2. echarts 按需加载（方案三第 1 条）——窗口首启 JS ≈ 4.0MB → 2.1MB。
3. 技能播种解耦 + 主进程启动分段打点（2026-09-09，见 §9）。

已决策不实施 / 已回退：

- 骨架屏（方案一）：用户明确不要。
- 设置窗口**常驻预载**方案：不采用（常驻 30–50MB 渲染进程内存，用户不接受）。
- 设置窗口显示策略：曾实施「内容就绪后再显示」（show:false + did-finish-load + 双兜底），并试过 paint 首帧 / 透明度方案消除残余“一瞬闪烁”，受 BaseWindow 隐藏不合成等限制收益不显，用户最终决定**回退为原始「窗口随建随显」**（尝试记录见 §9.4）。

可选后续：

- 评估后 voice/onnx、monaco、全部路由/视图均已按需加载；启动路径剩余约 2.1MB 为应用骨架与共享内核（`index-*` + `update-events-service`），继续拆分的收益有限。

验证清单（`pnpm run typecheck && pnpm exec electron-vite build && pnpm start` 后回归）：

- 消息中 ` ```echarts ` 代码块首次出现时才触发 echarts chunk 加载（devtools Network 可见），图表渲染 / 自动修复降级 / 「重新生成」/ 地图懒加载正常；
- 侧栏「上下文占用」弹层首次打开才加载 echarts，暗 / 亮主题下饼图正常、关闭后实例销毁；
- 设置页「用量」面板图表（UsagePanel）正常；
- 从聊天点设置按钮 / 托盘打开设置窗口（独立入口，tab 记忆与跳转）；
- 标题栏模式切换（`recreateAllWindows` 窗口重建，两类窗口加载分支均需覆盖）。

## 8. 决策记录与待办

- 2026-09-04：完成多轮讨论（根因分析、方案一~三、静态化可行性）；用户选择「**仅记录方案，暂不改代码**」。
- 2026-09（其后落地）：设置窗口采用「**独立轻量 Vue 入口**」形态实施（方案二，非 §6 静态布局）。
- 2026-09-09：用户**放弃骨架屏**（方案一）；确认并实施 **echarts 按需加载**（方案三第 1 条，§5），同步刷新本文构建数据。
- 2026-09-09（二）：经 CDP 实测渲染层冷启动后（结论见 §9），实施**技能播种不再阻塞窗口创建** + **主进程启动分段打点**（db openMs / 技能播种 / 窗口 loadMs / 恢复完成）。
- 2026-09-09（三）：**尝试并回退**设置窗口显示策略（记录见 §9.4）——先落地「内容就绪后再显示」（有限等待 + 双兜底），再试 paint 首帧 / 透明度方案；因残余闪烁与 BaseWindow 限制，最终回退为「窗口随建随显」。
- 待办 / 待决策：
  - [ ] （可选）如需彻底消除「空 HTML」白屏且不用骨架屏，评估 §6 设置窗口「静态 HTML + 局部挂载」方向；
  - [ ] 按 §7 清单做一轮完整回归。

## 9. 启动链路实测与观测打点（2026-09-09 补充）

> 触发：用户以 CDP + 浏览器性能工具实测「首启时间消耗在哪」，并指出设置窗口「先弹窗、后出内容」的体感与技能播种不应阻塞窗口。

### 9.1 渲染层冷启动实测（CDP 方法）

- 启动：`pnpm exec electron . --remote-debugging-port=9222`，再经 CDP（`/json/list` 找对应入口 target）连渲染进程。
- **不要用 reload 模拟冷启动**：同进程内 V8 会缓存模块编译结果，reload 是热数据（实测 reload 总 CPU 仅 ~90ms）；真冷启动须开全新进程且不 reload。
- 聊天窗口冷启动（本机 M 系，生产构建）：`load` 143ms、首帧 **212ms**（DOM 3453 节点 = 完整聊天 UI）；主线程 Task 累计 ~30–90ms，其余由 Chromium 在 worker 线程并行解析编译 JS（故主线程 CPU Profile 几乎空闲属正常）。
- 设置窗口冷打开：窗口创建 ≈120ms，渲染 `load` 105ms、首帧 176ms——内容约 0.2s 就绪，但窗口 `show: true` 随建随显（见 [window-manager.ts](file:///Users/hupengfei/Documents/my-app/src/main/infra/window-manager.ts#L286-L308)），这就是「先见空白窗」的来源。
- 局限：Electron（Chromium 136）下 Tracing 的 `v8.compile` 类别未采到事件，逐脚本 parse/编译拆分建议改用 GUI DevTools Performance 录一次冷启动查看。

### 9.2 主进程启动链路打点（已实施）

各段已带结构化耗时字段写 electron-log（macOS：`~/Library/Logs/desktop-agent/main.log`）：

| 打点                           | 代码位置                                                                                                 | 含义                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `数据库已打开 openMs`          | [database/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/database/index.ts#L95-L99)         | db 打开耗时（主模块 import 阶段，早于 app ready） |
| `应用启动`                     | main/index.ts whenReady                                                                                  | 主进程就绪                                        |
| `创建应用窗口`                 | window-manager.ts                                                                                        | 窗口随建随显（show: true，不等待内容）            |
| `内置技能播种完成 elapsedMs`   | [main/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/index.ts#L75-L87)                      | 补种耗时（不 await，与窗口创建并行）              |
| `内容视图加载完成 loadMs`      | [window-manager.ts](file:///Users/hupengfei/Documents/my-app/src/main/infra/window-manager.ts#L368-L371) | 窗口创建 → contentView `did-finish-load`          |
| `工作区窗口恢复完成 elapsedMs` | main/index.ts                                                                                            | `restoreStartupWindows` 全量完成                  |

实测一次：db 17ms → 应用启动 → 创建应用窗口 →（并行）技能播种 173ms 于窗口创建之后完成 → 内容视图 `loadMs` 254ms。技能播种从 `await` 改为启动即发起后，首窗创建不再被其磁盘 IO 卡住。

### 9.3 结论

1. **技能播种无需窗口等待**：其目的（技能管理页可见 / Agent 首轮可发现）均在用户操作后才触发，已解耦（skills-store 幂等、失败仅告警）。
2. **懒加载已无大头**：路由/视图、echarts（§5）、语音（onnx 在 ChatView 懒 chunk）、monaco 语法均已按需；启动路径剩余约 2.1MB 是应用骨架与共享内核（`index-*` + `update-events-service`），继续拆分收益低于成本。
3. **设置窗口显示策略：尝试后回退（§9.4）**——最终保持原始「窗口随建随显」；「常驻隐藏设置窗口」候选因常驻 30–50MB 渲染进程被否。

### 9.4 设置窗口显示策略：尝试记录（已回退，2026-09-09）

- 动机：设置窗口 `show: true` 随建随显 → 每次打开先见空白窗 ~0.2s（慢时更久），与其他应用「窗口与 UI 一起出现」体验差距大。
- 尝试一「内容就绪后再显示」（show:false + `did-finish-load` 后 `win.show()` + 双兜底）：
  - 效果：不再有空白页；但窗口显示后仍有一次明显的“闪烁”；
  - 原因：`did-finish-load` 只是脚本执行完，真实内容合成上屏还会晚 1~N 帧，窗口先露底色、随后内容补帧。
- 尝试二消除闪烁：等 contentView 首个 paint 再显示——探测发现 **BaseWindow 的 webContents 在窗口隐藏时不合成帧**，paint 事件不会触发；`paintWhenInitiallyHidden` / `ready-to-show` 只属于 BrowserWindow。改走「创建即 show + `setOpacity(0)` 透明 + 等 paint 后恢复可见」：需要常驻合成、且首次真正可见时机难以精确观测，复杂度上升。
- 结论：消除那一瞬要么把设置窗口 BrowserWindow 化（破坏 BaseWindow + 双 WebContentsView 架构，弹窗/标题栏行为变化），要么常驻预载（内存成本）。两者收益均不划算，用户决定**回退为原始「窗口随建随显」**，保持简单直接。
- 备注：若要彻底“首帧即完整 UI”，可行方向仍是 §6 的「静态 HTML + 局部挂载」（内容在 HTML 里即完整，不依赖 JS 首帧）。
