# IPC 视图能力模型铺路与渲染层容错守卫 —— 改动清单

> 记录时间：2026-09-04
> 状态：**方案已确认，尚未实施**
> 背景：为保证未来「设置窗口独立入口」拆分（见 [first-paint-strategy.md](first-paint-strategy.md) 方案二）不被 IPC 投递架构卡住，先行铺路：把 main 侧「内容视图=全量注册」的隐含假设收敛为可扩展的能力决策点，并给渲染层加容错守卫。本次**不拆设置窗口**。
> 前置上下文：render-client 推送目标已改为从 header 视图骨架类自动推导（见 [render-client.ts](../src/main/service/render-client.ts) 顶部注释），不再维护手写 VIEW_ROUTES。

---

## 目录

1. [问题背景与设计约束](#1-问题背景与设计约束)
2. [A. 渲染层容错守卫（本期独立项）](#2-a-渲染层容错守卫本期独立项)
3. [B. agent 事件投递收敛到工作区窗口（本期语义修正）](#3-b-agent-事件投递收敛到工作区窗口本期语义修正)
4. [C. 视图能力模型建缝（本期只加结构）](#4-c-视图能力模型建缝本期只加结构)
5. [D. 验证清单](#5-d-验证清单)
6. [非目标](#6-非目标)
7. [未来拆设置窗口时的增量清单（预览）](#7-未来拆设置窗口时的增量清单预览)

---

## 1. 问题背景与设计约束

- 现状：工作区窗口与设置窗口加载**同一个 SPA**（[service/index.ts](../src/renderer/src/service/index.ts) 注册全部 5 个渲染层服务），`IpcRendererServices` 类型即内容视图全量注册。main 侧投递模型：header 可达方法（骨架类推导）→ `'all'`；其余 → `'content'`，隐含前提「每个内容视图都注册了全部方法」。
- 库行为：渲染层收到推送时直接 `services[message.service][message.method](...)`，**无任何守卫**（见 `node_modules/electron-ipc-service/dist/renderer.js`）。消息发到未注册该 service 的视图即抛 TypeError。
- preload 接线（`dist/preload.js`）：`ipcRendererPreload(callback)` 仅把 `ipcRenderer.on(channel)` 收到的消息转发给 callback。**守卫可完全替换库的 `initializeIpcRendererServices` 自写 dispatcher**，无需改库；每视图 1:1 挂一个 listener，替换后计数不变。
- 拆出设置窗口后会出现两种内容视图（工作区=全量、设置=子集）。当前模型无法表达，必须先把决策收敛为可扩展结构。

## 2. A. 渲染层容错守卫（本期独立项）

**目标**：任何未来的路由/能力配置漂移，从「渲染层抛 TypeError 崩页面」降级为「console.warn 忽略」，把能力表从正确性来源降级为精准投递优化。

| # | 改动 | 位置 |
|---|---|---|
| A1 | 新增 `initializeSafeRendererServices(Services)`：与库同构构建 services 映射，自写 dispatcher——`services[service]?.[method]` 不存在时 `console.warn('[ipc] main 推送了本视图未注册的调用: service.method')` 后忽略；存在则照常调用 | 新增 `src/renderer/src/utils/ipc-guard.ts` |
| A2 | 内容视图切换到守卫注册（行为不变，`ipcRendererServices` 导出与类型推导保持原样） | `src/renderer/src/service/index.ts` |
| A3 | 标题栏视图切换到守卫注册 | `src/renderer/header/index.ts` |
| A4 | 常量镜像：`__ELECTRON_IPC_SERVICE_RENDERER_SERVICE_FN__` 需本地硬编码（库不导出，与 render-client 中 channel 常量处理一致） | A1 内 |

**技术要点**：A1 参数/返回类型用结构类型复刻库（`IpcServiceConstructor` 结构 + `IpcServices<T>` 映射形状），保证 `IpcRendererServices = typeof ipcRendererServices` 与现状完全一致，main 侧类型零改动；必须过 typecheck（node + web 双 tsconfig 均覆盖该目录）。

## 3. B. agent 事件投递收敛到工作区窗口（本期语义修正）

**目标**：agent 事件本就属于工作区窗口。现在无会话归属时兜底 `broadcastToViews` 会把它们**冗余广播到设置窗口**（今天因设置窗口也注册了 AgentEventService 而不崩，纯浪费；拆分后不收敛即崩）。

| # | 改动 | 位置 |
|---|---|---|
| B1 | `deliver` 中 `service === 'agentEvent'` 的兜底分支（sessionId 解析不到时）改为只遍历工作区窗口的 content 投递，不再发设置窗口 | `src/main/service/render-client.ts` `deliver` |
| B2 | 提取 `broadcastToWorkspaceViews(channel, message, target)`，让 B1 与已有 `deliverBackgroundSessions`（[render-client.ts](../src/main/service/render-client.ts)）共用，避免两处各写一套遍历 | `src/main/service/window-manager.ts`（或 render-client 内部） |

## 4. C. 视图能力模型建缝（本期只加结构）

**目标**：把「哪些窗口的内容视图该收到某条推送」收敛到**单一决策点**，今后拆设置窗口只改这一处。

| # | 改动 | 位置 |
|---|---|---|
| C1 | 新增 `collectContentTargets(service, method): AppWindow[]`：默认返回全部应用窗口；`agentEvent.*` 返回工作区窗口（服务化 B1 收敛逻辑）；header 可达性（`headerReachableMethods`）判定保留不动 | `src/main/service/render-client.ts` |
| C2 | `deliver` 兜底分支与相关广播改走 C1，消除散落的窗口集合判断 | 同上 |
| C3 | 在 C1 上方注释写明契约：**拆设置窗口时唯一增量 = 给设置入口加能力骨架（仿 [header-view-services.ts](../src/renderer/src/service/header-view-services.ts)）并在 `collectContentTargets` 追加「settings 内容视图只收 X 集合」过滤**；本期 settings==full SPA，无需任何枚举 | 同上 |

## 5. D. 验证清单

1. `npm run typecheck`（node + web 双项目）。
2. `npm run build`。
3. 运行后回归：
   - 多工作区并发生成 + 设置窗口打开：设置窗口 console 无 agent 事件、无 `[ipc] main 推送了本视图未注册的调用` warn（B 生效）；
   - 标题栏窗口状态同步、主题色变更仍正常（header 推导未受影响）；
   - 设置变更 / 模型配置变更仍同步到两类窗口；
   - 托盘动作、设置 tab 跳转、`recreateAllWindows` 重建正常。

## 6. 非目标

- 设置窗口独立 HTML 入口拆分（future）；
- 骨架屏、入口 JS 瘦身（属 [first-paint-strategy.md](first-paint-strategy.md) 第 7 节）。

## 7. 未来拆设置窗口时的增量清单（预览）

验证 C 的缝是否够用，届时按此执行：

1. 设置入口注册裁剪为子集（settings-sync / theme-sync / model-config-sync / ui，按 first-paint-strategy.md 第 4 节盘点各面板引用）；
2. 新增 settings 侧能力骨架模块（仿 header-view-services.ts），设置入口以子类注入实现；
3. `collectContentTargets` 追加 settings 过滤；A 的守卫兜底保留作保险。

---

## 决策记录与待办

- 2026-09-04：确认「渲染层容错守卫 + agent 事件收敛 + 能力决策点建缝」为铺路范围，拆分设置窗口明确排除在本期之外。
- 待办：
  - [ ] A1–A4 守卫实施；
  - [ ] B1–B2 agent 事件收敛；
  - [ ] C1–C3 能力决策点；
  - [ ] D 验证清单逐项回归。
