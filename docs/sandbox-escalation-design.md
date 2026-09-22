# 沙箱权限申请（Sandbox Escalation）设计

> 状态：**已实施（阶段 0/1/2 全部落地，见第七节实施记录）**
> 日期：2026-09-18
> 前置：[bash-sandbox-research.md](file:///Users/hupengfei/Documents/my-app/docs/bash-sandbox-research.md)（L2 沙箱落地与 srt 选型）、[tool-permission-system.md](file:///Users/hupengfei/Documents/my-app/docs/tool-permission-system.md)（五层权限模型）
> v2 变更：新增第五节「工具调用结局语义」，修复「用户拒绝被 agent 理解为执行失败导致重复尝试」。
> v3 变更：锁定 8 项决策（见第八节）。关键调整 —— 「本会话允许」改为**点一次即自动重建默认持久 shell**（不做二次确认）；env 快照**不做差异过滤**、与上一个 shell 完全一致；**移除**「已拒绝动作记忆」机制，抑制重试只靠失败原因文本。

---

## 一、问题

### 1.1 现状：两条越界路径都是死路

沙箱开启后，任何越界写都只能靠用户离开对话去改配置：

| 场景                 | 当前行为                                                  | 代码位置                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文件工具写可写根之外 | 硬拒 + 引导文案（去设置加目录 / 关沙箱），**不弹确认**    | [permission.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/permission.ts#L259-L271)、[tools/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/index.ts#L310-L321) |
| bash 写可写根之外    | OS 层 `Operation not permitted`，agent 只看到一条沙箱报错 | [sandbox.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L400-L441)（wrapper 只捕获「包装期」错误，运行期拒绝直接透传）                                                       |
| 读取命中 denyRead    | 硬拒 + 引导文案                                           | [tools/index.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/index.ts#L316-L320)                                                                                                           |

两条路径的共同后果：任务在跑到一半时**硬停**，用户必须切到设置页操作；bash 侧 agent 甚至拿不到「哪个路径被拒」的可操作信息。

### 1.2 为什么现在是硬拒（本设计的前提）

不是「不想让 agent 问」，而是**问了也生效不了**：

- 沙箱在 **spawn 时刻一次性施加**于整个 shell 进程（含其后所有命令与子进程），且对已在运行的会话不追溯 —— 见 [sandbox.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L40-L43)；
- 因此 [permission.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/permission.ts#L260-L262) 的注释才写「避免『确认允许 → 执行层又硬拒』的假确认」。

**所以本设计的核心不是加一个弹窗，而是让批准能真正作用到执行层。**

---

## 二、业界调研（2026-09-18 核实）

### 2.1 横向对比

| 产品            | 边界定义                                                               | 越界 / 需扩权时的行为                                                                                                                                                                                 | 批准粒度              | 通道可否关闭                                                                            |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| **Codex CLI**   | `sandbox_mode`：`read-only` / `workspace-write` / `danger-full-access` | `approval_policy` 在「**离开沙箱** / 用网络 / 写工作区外」时暂停询问，批准后以该权限执行该动作；默认 `workspace-write + on-request`                                                                   | 单次 / 会话（取最窄） | 可用 `read-only + on-request`，或 managed policy 收紧                                   |
| **Claude Code** | sandboxed bash，默认可写 cwd / 会话临时目录 / `additionalDirectories`  | ① 沙箱内失败 → **unsandboxed retry 逃生通道**（`dangerouslyDisableSandbox`），确认框标题显式改为 `Bash command (unsandboxed)`；② 首次访问新域名 → **逐个域名弹批准**；③ `/add-dir` 运行期追加可写目录 | 单命令 / 单域名       | 组织可设 `allowUnsandboxedCommands: false` 关掉逃生通道；另有 `excludedCommands` 白名单 |
| **Gemini CLI**  | macOS Seatbelt / Docker 等，默认只可写工作区                           | **Sandbox Expansion**：检测到沙箱拒绝，**或主动识别**（如 `npm install`）→ 弹窗说明需要哪些额外权限（**具体目录 / 网络**）→ 批准后「**该次运行**」带扩展权限执行                                      | **该次运行**          | 未提供开关（是默认交互）                                                                |
| **Cursor**      | shell 命令沙箱 + allowlist                                             | 无法在沙箱内执行的命令（如写工作区外）交给 **Auto-review 分类器**；被拦后 agent 可换方案，仍要跑则弹批准                                                                                              | 单次                  | Run Modes（Auto-review / Allowlist / Run Everything）                                   |
| **Windsurf**    | 无 OS 沙箱，仅 allow / deny list                                       | 不在允许列表的命令 → 弹批准                                                                                                                                                                           | 单次                  | 自动执行级别（Disabled / Allowlist Only / Auto / Turbo），deny 优先                     |

### 2.2 提炼出的六条通用模式

1. **「边界 + 越界必过人工」是标配**，没有一家是「边界 + 硬拒且无出口」。
2. **越界的实现方式是「用扩展后的权限重新执行这一次动作」，而不是去修改运行中的沙箱。** Gemini CLI 的 Sandbox Expansion 明确如此；Claude Code 的 unsandboxed retry 也是重跑。只有 Codex 走「换 sandbox_mode 再跑」。
3. **默认粒度是「这一次」**，会话级 / 永久级必须用户显式选择，且「永久」通常是管理员可禁的（Gemini 的 `enablePermanentToolApproval`、Claude 的组织策略）。
4. **越界执行必须被显式标注**（Claude Code 把标题改成 `Bash command (unsandboxed)`），不能让用户误以为仍在沙箱内运行。
5. **deny 优先于 allow**（Cursor / Windsurf 均明确）。
6. **整条通道可被组织级关闭**（Claude / Cursor / Windsurf 都有）。

### 2.3 与本项目既有结论的对照

[mcp-sandbox-discussion.md](file:///Users/hupengfei/Documents/my-app/docs/mcp-sandbox-discussion.md) 结论是「MCP server 沙箱业界无先例，暂不实施」。**沙箱提权不能套用这个结论**：五家里四家（Codex / Claude / Gemini / Cursor）都有，且是默认交互。因此本项**建议做**，优先于 MCP 沙箱。

---

## 三、本项目特有约束（决定方案形态）

| #   | 约束                                                                                                                | 出处                                                                                                                                                                                                               | 对设计的影响                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | 沙箱在 spawn 时刻施加，**不可追溯**                                                                                 | [sandbox.ts L40-43](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L40-L43)                                                                                                            | 采用「**重跑**」而非「改运行中的沙箱」                                         |
| 2   | 文件域是**应用层判定、每次调用现读**策略                                                                            | [tools/index.ts L310](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/index.ts#L310)                                                                                                                 | **文件工具提权可立即生效，无需重跑** —— 最省事，先做                           |
| 3   | macOS 网络白名单由「**宿主侧共享代理**」全局执行，**逐调用覆盖不生效**（需 `updateConfig`）                         | [bash-sandbox-research.md 5.6 发现 2](file:///Users/hupengfei/Documents/my-app/docs/bash-sandbox-research.md#L233)                                                                                                 | **网络提权做不了 per-command**：要么做成全局态（+会话重启），要么本期不做      |
| 4   | 持久 shell 的 cwd 由**每次调用显式传入**（`cdCmd` 前缀）；env 只在**启动时**注入一次，之后由 shell 内 `export` 决定 | [bash-session.ts L201-L272](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/bash-session.ts#L201-L272)、[bash.ts L183](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/bash.ts#L183) | cwd **可免费精确继承**；env 需**回放**（见 4.3）                               |
| 5   | srt 已提供违规归因 API，**当前未使用**                                                                              | `getViolationsForCommand(key)` / `annotateStderrWithSandboxFailures(key, stderr)`                                                                                                                                  | 被动检测「哪个路径被拒」可直接用现成 API，无需自己解析 stderr                  |
| 6   | fail-closed：沙箱不可用即拒绝执行，绝不静默裸跑                                                                     | [sandbox.ts L36-L39](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L36-L39)                                                                                                           | 提权路径同样 fail-closed：提权执行体包装失败必须拒绝，不得降级直跑             |
| 7   | 审批边界（`getSessionWriteBoundary`）与沙箱边界（`getSessionFsPolicy`）**共用同一可写根**                           | [sandbox.ts L125-L145](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L125-L145)                                                                                                       | 签发提权授权时**必须同时写入两者**，否则会再次出现「假确认」（方向相反的那种） |
| 8   | `beforeToolCall` 的 block 与 execute 抛错，在模型侧是**同一种形状**（`isError: true` 的纯文本）                     | [agent-loop.js L426-L436](file:///Users/hupengfei/Documents/my-app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L426-L436)                                                                        | 必须靠**文本约定**承载失败分类，见第五节                                       |

---

## 四、方案设计

### 4.1 核心模型：不提权改运行中的沙箱，而是让「新的执行体」带上扩展权限

**已运行的 shell 无法被追加沙箱路径**（OS 层在 spawn 时就封好了），所以任何提权都必须通过「起一个新的、带扩展权限的执行体」来实现 —— 这也是业界的一致做法（Gemini CLI 的 Sandbox Expansion、Claude Code 的 unsandboxed retry 都是重跑）。

```
检测到越界（被动：sandbox 拒绝 / 主动：路径预检、agent 显式申请）
        │
        ├─ 文件工具 → 签发授权（策略层每次调用现读）→ 立即生效，无需重跑
        │
        └─ bash ─┬─ 仅本次      → 一次性沙箱 shell 跑这一条命令（env 从当前 shell 快照回放）
                 └─ 本会话允许  → 重建该会话的默认持久 shell（扩展可写根 + 环境快照）
                                  → 一次确认即生效；后台任务不受影响
```

### 4.2 文件工具（阶段一，先做）

命中沙箱区外时，把「直接 block」改为「发起提权请求」。**两档粒度都要提供**：

| 用户选择       | 行为                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **仅本次**     | 在本次调用内追加一次性可写根 → 放行，用完即弃                                                                                                          |
| **本会话允许** | 追加到**会话级提权授权**（`sessionSandboxGrants`，与 `sessionBashAllow` 同生命周期）→ **点一次即生效**：文件工具的策略是每次调用现读，无需重建任何东西 |
| 拒绝           | 按第五节的 `sandbox_denied` 结局返回（不是泛化的「执行失败」）                                                                                         |

要点：

- 授权必须**同时**进入 `getSessionFsPolicy`（沙箱执行层）与 `getSessionWriteBoundary`（审批层），见约束 7；
- 读取类（denyRead）**不提供提权入口**（见第六节红线）。

### 4.3 bash（阶段二）

**检测**（两条来源）：

- 被动：命令因沙箱被拒后，用 srt 的 `getViolationsForCommand(commandId)` 取违规明细（被拒路径）构造提权请求；需在 [sandbox.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L416-L435) 的包装处补下发 `commandId`（推荐用 tool-call id，见 srt README「Violation attribution」）；
- 主动：agent 显式声明本命令需要额外可写目录。

**执行**：两档分别处理，见下方「两档的具体行为」。

**状态继承（决策 2/8：与上一个 shell 保持一致）**

| 状态                           | 能否继承    | 做法                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cwd**                        | ✅ 精确     | 每次调用都显式传 `cwd`（[bash.ts L183](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/bash.ts#L183)），提权执行体直接复用同一个值，**零额外成本**                                                                                                                                                            |
| **已导出的环境变量**           | ✅ 完整     | 提权前向当前持久 shell 探一次 `env -0`（PowerShell `Get-ChildItem env:`），**原样**作为提权 shell 的启动环境，**不做差异过滤** —— 结果就是「和上一个 shell 一样」（决策 8）                                                                                                                                                 |
| shell 函数 / 别名 / 未导出变量 | ❌          | 无法回放，**必须如实标注**，不可假装完整继承                                                                                                                                                                                                                                                                                |
| 后台任务                       | ✅ 不受影响 | 后台 shell 存在 `backgrounds`，与默认持久 shell 分属两个 Map；重建默认 shell 不会动它们（[bash-session.ts L967-972](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/bash-session.ts#L967-L972)、[L1088-1093](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/bash-session.ts#L1088-L1093)） |

安全提示（写入实现注释）：env 快照会包含 shell 内导出的敏感变量（token 等）。二者同为用户身份，不构成提权泄露，但**不要把快照内容打进日志**。

**两档的具体行为**

- **仅本次**：起一个一次性沙箱 shell（`allowWrite = 现有可写根 + 该目录`），用上面的 env 快照与本次调用的 `cwd`，执行这一条命令后释放；当前持久 shell 不动。
- **本会话允许（决策 6：点一次就生效，不要二次确认）**：签发会话级授权后，**自动重建该会话的默认持久 shell** —— 新 shell 启动时就带上扩展可写根与 env 快照。用户只确认一次，当前会话立刻就能写该目录，不需要再点任何东西。

重建是安全且低成本的（这一点已核实）：`disposeSession` 只 dispose `defaults`，后台任务不受影响；且重建发生在两条命令之间（默认 shell 空闲时），不会打断正在跑的前台命令。

**必须如实标注的代价**：重建后默认 shell 内的 **shell 函数 / 别名 / 未导出变量会丢失**（cwd 与已导出变量已通过快照保住）。这一限制要在工具结果与 UI 里说明，不要让 agent 以为一切如常。

### 4.4 网络提权：本期不做

原因见约束 3：macOS 下 srt 的域名白名单是**宿主侧共享代理的全局态**，逐调用覆盖实测不生效。要做只能走全局 `updateConfig` + 强制重建会话，影响面覆盖所有会话，与「这一次」的粒度不匹配。若后续确有需求，单独立项（或改造成「按会话的网络档位」）。

### 4.5 交互与复用

复用现有统一交互通道，新增一个 `kind`：

| 项        | 复用点                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 挂起/回执 | `beginInteraction` / `respondInteraction`（[interaction.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/interaction.ts)），含超时与中断语义（默认拒绝） |
| 前端卡片  | 参照现有 `tool_permission` 卡片，新增「提权」形态                                                                                                                           |
| 放行记录  | 参照 `resolvePermission` 的 `once` / `session` 作用域模型                                                                                                                   |

**UI 必须做到**（对应业界模式 4）：

- 明确展示将扩展的**具体目录**（或未来的具体域名）；
- 明确标注「将在**沙箱之外**执行本次操作」，批准按钮不用中性的「允许」；
- 明确展示**继承情况**（见 4.3）；
- 超时 / 中断一律拒绝，并给出原因。

**允许多次发起（决策 4）**：不设发起次数上限，也不强制「同一会话同一目录只弹一次」——agent 可以基于新信息反复申请。抑制刷屏靠**修好失败语义**（第五节）让 agent 不再盲目重试，而不是靠限制用户可见的请求次数；**不做**任何「已拒绝动作记忆」类抑制机制（决策 7）。

### 4.6 应用级总开关（决策 3）

新增设置项（settings 表 + 沙箱设置页），面向高安全 / 企业场景，**一键关闭整条提权通道**：

| key                         | 含义                                                 | 默认 |
| --------------------------- | ---------------------------------------------------- | ---- |
| `sandbox.escalationEnabled` | 沙箱提权通道总开关；关闭时越界一律硬拒（= 当前行为） | true |

关闭后的行为必须与现状完全一致（越界直接硬拒 + 引导文案），只是不再提供提权入口。对齐业界模式 6（Claude 的 `allowUnsandboxedCommands`、Cursor/Windsurf 的组织级控制）。

### 4.7 生命周期

会话级提权授权为内存 Map，`sessionId` 为键，随 `clearSessionPermissions(sessionId)`（会话 / 工作区删除）一并清理，避免随历史会话累积。

---

## 五、工具调用结局语义（决策 5：不同失败给不同响应）

### 5.1 现状核查（代码级定位）

pi-agent-core 对 `beforeToolCall` 返回的处理（[agent-loop.js L426-L436](file:///Users/hupengfei/Documents/my-app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L426-L436)）：

```js
if (beforeResult?.block) {
  const result = createErrorToolResult(beforeResult.reason || 'Tool execution was blocked')
  if (beforeResult.terminate === true) result.terminate = true
  return { kind: 'immediate', result, isError: true }
}
```

而 execute 抛错走的是同一个构造函数（[L515-L518](file:///Users/hupengfei/Documents/my-app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L515-L518)）：

```js
catch (error) {
  result = createErrorToolResult(error instanceof Error ? error.message : String(error))
  isError = true
}
```

`createErrorToolResult` 只产出 `{ content: [{ type: 'text', text: message }], details: {} }`。

**根因**：在模型侧，「**被策略拦截**」与「**执行失败了**」是**完全相同的形状**——一个 `isError: true` 的纯文本 toolResult，正文只有那段 reason 文本。模型拿到 `isError` 的默认解读就是「这次没成功，改一下再试」，于是形成重复尝试。

连带的三个具体问题：

1. **当前所有 block 点都没有 `terminate`**（[permission.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/permission.ts#L249-L252) ×3、[subagent.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/subagent.ts#L113-L116) ×1），没有任何机制阻止立即重试。
2. **不同原因被压成同一种形状**：用户拒绝 / 确认超时 / 用户中断 / 计划模式 / 沙箱越界 / 子代理只读限制 —— 全是 `isError: true` + 一句话。
3. **工具被停用反而是「成功」**：[wrapGate](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/index.ts#L261-L283) 返回的「已停用」是普通结果（非 error），模型可能当成执行成功。

### 5.2 结局分类与响应要求

`details` 字段不会随 toolResult 进入 provider 报文，**模型只能看到 `content` 文本**。所以分类信息必须以**稳定的文本前缀**承载（同时保留在 `details` 里供 UI / 日志用）。

| 结局                | 触发                          | 面向 agent 的响应要点                                                          | `terminate` |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------ | ----------- |
| `user_denied`       | 用户点拒绝                    | **明确是用户拒绝，不是失败**；禁止重试同一动作或等价写法；请说明替代方案或请示 | 否          |
| `approval_timeout`  | 确认超时                      | 明确「用户未在时限内响应，按拒绝处理」；禁止重试                               | 否          |
| `aborted`           | 用户中断本轮                  | 明确「任务已被用户中断，立即停止一切后续动作」                                 | **是**      |
| `plan_mode`         | 计划模式拦截                  | 引导调用 `exit_plan_mode` 提交计划                                             | 否          |
| `sandbox_denied`    | 沙箱越界（含提权被拒）        | 给出**被拒的具体路径** + 可提权 / 可改配置；**不要当成命令失败去换写法重试**   | 否          |
| `tool_disabled`     | 工具被用户关闭 / 域总开关关闭 | 明确「该工具当前已停用」，换路径或告知用户；**改为 error 结果**                | 否          |
| `subagent_readonly` | 只读子代理执行非只读命令      | 说明能力边界，换只读手段                                                       | 否          |
| `tool_error`        | execute 抛错（真实执行失败）  | 保留现状，可按常规错误自纠重试                                                 | 否          |

`terminate` 的使用策略：**只对 `aborted` 置 true**（用户已要求停止，不该再让模型说话）。`user_denied` 不置 true —— 需要给模型一次回应 / 换方案的机会，抑制重试**完全靠明确的文本指令**（决策 2：不做额外的记忆 / 抑制机制）。注意 pi-agent-core 的语义：同一批全部 `terminate` 才会提前结束（见其 README）。

### 5.3 响应格式约定

固定「分类标记 + 事实 + 明确指令」三段式，示例：

```
[权限：用户手动拒绝 · 请勿重试] 用户手动拒绝了 bash 命令「rm -rf dist」。
请勿重试该命令或其等价写法（换参数、换路径、拆成多条都视为重试）。
如需继续，请说明理由征求用户重新批准，或改用不需要该权限的方案。
```

```
[沙箱：越界被拒 · 可申请提权] 写入路径「/Users/x/.npm/...」不在可写范围内。
这不是命令执行失败。你可以调用 sandbox_request_escalation 申请该目录的写权限，或改用工作区内的路径。
```

```
[已中断] 用户中断了本轮任务，请立即停止后续动作并等待用户指示。
```

同时约定：**分类标记文本必须稳定可枚举**（放在一个常量表里，禁止各处手写散落），便于后续做统计与自动化。

---

## 六、不可提权清单（红线）

| 红线                                              | 理由                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `denyReadRoots` **不可提权**                      | 隐私边界；提权只开「写」的口子，不开「读」的口子                                          |
| 命中 `DENY_PATTERNS`（hardAsk）**不可提权**       | 与现有口径一致：破坏性操作永不被任何机制覆盖                                              |
| 「跳过工具确认」/ 计划已批准 **不得自动批准提权** | 否则沙箱全局可绕过，等于沙箱失效（对齐 Claude 的 `allowUnsandboxedCommands: false` 语义） |
| 提权**不得静默持久化**                            | 必须用户显式选「本会话允许」，默认「仅本次」                                              |
| 提权执行**必须显式标注**                          | 不能让用户误以为仍在沙箱内                                                                |
| 提权失败 / 沙箱不可用**不得降级直跑**             | fail-closed 一以贯之                                                                      |

---

## 七、落地拆解

| 阶段       | 范围                                                                                              | 预期改动点                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **阶段 0** | **工具调用结局语义**（第五节）——独立可先行，也是提权的前置                                        | 新增结局常量表 + 统一响应构造器；[permission.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/permission.ts#L249-L332) 四个 block 点改为按分类返回；[subagent.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/subagent.ts#L113-L116) 同步；[wrapGate](file:///Users/hupengfei/Documents/my-app/src/main/agent/tools/index.ts#L261-L283) 改为 error 结果；`aborted` 置 `terminate` |
| **阶段一** | **文件工具提权**（两档）+ 应用级总开关 + 越界引导改进                                             | [permission.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/permission.ts#L259-L272) 沙箱预检分支改为可提权；[sandbox.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L94-L145) 新增会话级授权读写（同时供策略层与审批层）；settings + 沙箱设置页加总开关；interaction 新增 kind + 前端卡片                                                                   |
| **阶段二** | **bash 提权**（仅本次 = 一次性 shell；本会话允许 = 重建默认持久 shell，含 env 快照）+ 被动检测    | [sandbox.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts#L400-L441) wrapper 支持 per-call 额外可写根与 `commandId`；[bash-session.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/bash-session.ts#L70-L90) 一次性执行入口 + env 快照探测（`env -0`）+ 默认 shell 重建；接入 srt 违规归因                                                                      |
| **不做**   | 网络提权（见 4.4）、修改已在运行的沙箱边界（OS 层做不到）、重建后台任务 shell（不受影响且不该动） | —                                                                                                                                                                                                                                                                                                                                                                                                                |

### 7.1 实施记录（2026-09-18）

阶段 0/1/2 全部落地；`npm run typecheck`（node+web）、`npm run lint`、`npm run build` 均通过。实施中发现并处理的三个非文档预期问题：

1. **srt 的违规监控默认关闭** → `SandboxManager.initialize(config)` 的第三个参数 `enableLogMonitor` 默认 `false`，不开则 `sandboxViolationStore` 恒为空，bash 侧的「被动检测 → 提权」**永远不会触发**（且 `annotateStderr` 也失效）。已在 [sandbox.ts](file:///Users/hupengfei/Documents/my-app/src/main/agent/runtime/sandbox.ts) 显式传 `true`（macOS 下会拉 `log stream --predicate` 子进程）。
2. **违规到达有延迟** → 违规来自异步内核日志流，可能晚于命令结束。故检测处做了短轮询（最多约 250ms），且只在「命令已失败 + 沙箱确实生效」时才会走到，正常路径零开销。
3. **「仅本次」授权需要跨包装器传递** → 审批在 `beforeToolCall`、边界复查在工具执行层 `wrapSandboxFsPolicy`，两者互不可见。故引入按 `toolCallId` 绑定的临时授权（执行结束即清），否则会出现「确认允许 → 执行层又硬拒」。

已知残留（有意保留，非缺陷）：

- `download` 不在 `DANGEROUS_TOOLS` 中，因此它仍走 execution 层硬拒、无提权入口。若要覆盖需先把它纳入确认体系（会改变现有「下载无需确认」的行为），属产品决策，本次未动。
- 文件工具的「本会话允许」只放宽文件工具与新建的 bash shell；**当前正在运行的 bash 持久 shell 不会因此自动重建**（避免用户批准一次文件写入就重启 shell）。若随后 bash 也写到该目录，会再弹一次提权 —— 符合「允许多次发起」的决策，但会多一次交互。
- 同一批并行工具调用里对同一目录的多个越界写会各弹一次（授权按 `toolCallId` 绑定），见上条同理。

---

## 八、决策记录

| #   | 决策                                                                                     | 落地位置 |
| --- | ---------------------------------------------------------------------------------------- | -------- |
| 1   | 文件工具提权提供「仅本次」与「本会话允许」两档                                           | 4.2      |
| 2   | bash 提权尽量继承 shell 状态（cwd 精确继承 + env 快照）                                  | 4.3      |
| 3   | 提供应用级总开关，可一键关闭整条提权通道                                                 | 4.6      |
| 4   | 允许多次发起提权请求，不设次数上限                                                       | 4.5      |
| 5   | 为不同失败设置不同响应（8 类结局，分类信息由文本承载）                                   | 第五节   |
| 6   | 「本会话允许」必须**点一次即生效**，不做二次确认 —— bash 通过自动重建默认持久 shell 实现 | 4.3      |
| 7   | **不做**「已拒绝动作的记忆」机制，只在失败原因里写明「用户手动拒绝」                     | 5.2/5.3  |
| 8   | env 回放**不做差异过滤**，原样复制当前 shell 的全部导出变量（= 和上一个 shell 一样）     | 4.3      |

**残留限制（无法消除，只能如实标注）**：重建 shell 后，shell 函数 / 别名 / 未导出变量会丢失。

---

## 九、验证清单（实施时用）

- [ ] 沙箱开启 + 写区外 → 弹提权 → 选「仅本次」→ 该条命令执行成功，且其他会话不受影响
- [ ] 选「本会话允许」→ **只确认这一次**，当前会话立刻可写该目录（bash 默认 shell 已自动重建，无第二次弹窗）
- [ ] 「本会话允许」后的新命令，env 与重建前一致（`env -0` 快照生效）；shell 函数 / 别名丢失有标注
- [ ] 重建默认 shell 时，正在跑的后台任务存活
- [ ] 拒绝提权 → agent 收到 `sandbox_denied`（含被拒路径），**不会换写法反复重试**
- [ ] 用户手动拒绝 → agent 收到 `user_denied`，明确「不是执行失败、请勿重试」
- [ ] 用户中断 → 该轮以 `terminate` 提前结束，agent 无后续动作
- [ ] 计划模式下 → agent 收到 `plan_mode` 并去提交计划
- [ ] 工具被关闭 → agent 收到 `tool_disabled`（error 结果，而非「成功」）
- [ ] 提权目录落入 `denyReadRoots` → 提权被拒（红线）
- [ ] `sudo` / `rm -rf` 等 hardAsk → 提权不得绕过强制确认
- [ ] 打开「跳过工具确认」→ 提权**仍然弹窗**
- [ ] 关闭应用级总开关 → 越界恢复为直接硬拒，无提权入口
- [ ] 沙箱初始化失败时，提权路径同样拒绝（fail-closed）
- [ ] 会话 / 工作区删除后，会话级授权被清理

---

## 十、参考

- Codex：Agent approvals & security — https://www.codex-docs.com/en/docs/agent-approvals-security ；Sandbox — https://www.codex-docs.com/en/docs/sandboxing
- Claude Code：Configure the sandboxed Bash tool — https://code.claude.com/docs/en/sandboxing （unsandboxed retry escape hatch、per-command allowed domains、`allowUnsandboxedCommands`）
- Gemini CLI：Sandboxing（含 **Sandbox expansion**）— https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/sandbox.md ；Trusted Folders — https://google-gemini.github.io/gemini-cli/docs/cli/trusted-folders.html
- Cursor：Run Modes — https://cursor.com/docs/agent/security/run-modes ；permissions.json — https://cursor.com/docs/reference/permissions.md
- Windsurf：Terminal（自动执行级别 / allow、deny list）— https://docs.windsurf.com/windsurf/terminal
- pi-agent-core：`beforeToolCall` 与 `terminate` 语义 — 本仓库 `node_modules/@earendil-works/pi-agent-core/README.md`；block 处理实现见 `dist/agent-loop.js`
- srt 违规归因 API：`@anthropic-ai/sandbox-runtime` README「Violation attribution」（本仓库 `node_modules/@anthropic-ai/sandbox-runtime/README.md`）
