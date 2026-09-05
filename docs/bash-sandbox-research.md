# Bash 沙箱调研与选型（Spike 前置文档）

> 调研日期：2026-09-04
> 状态：选型分析完成，待按本文档搭建 spike 验证
> 目标读者：后续负责搭建沙箱 spike 与落地实现的开发者

---

## 一、问题背景与目标

### 1.1 现状

- bash 工具以**用户全权限直跑**：持久 shell 由 `src/main/agent/bash-session.ts` 的 `ensureStarted()` 一处 spawn（后台任务由 `startBackground()` 另一处 spawn），命令以应用真实身份执行，可读写任何文件。
- 现有防线只有**应用层策略**（`src/main/agent/permission.ts`）：危险命令人工确认、只读命令自动放行、持久白名单、DENY_PATTERNS、计划模式拦截。**本质是「防呆」，不是「隔离」**——复合命令/变量/脚本可绕过词级匹配，恶意代码直接穿透。

### 1.2 核心认知（来自讨论的关键结论）

沙箱要拆成两个本质不同的问题，不要混为一谈：

| 问题 | 典型场景 | 能否靠代码内字符串规则解决 |
|---|---|---|
| **A. Agent 自身偶发误操作** | 自己写错 `git clean -fdx` 目录、`rm -rf` 打错路径 | 简单命令可覆盖大部分，成本低，但**只适用于直白形态** |
| **B. 执行不可信/复杂内容** | `bash run.sh`、npm install、下载的脚本、外部 skill 附带代码 | **不能**。脚本内容执行前不可知，静态分析是类别错误而非精度问题 |

**对 B 唯一可靠的拦截点是进程级 OS 沙箱**：运行时内核按系统调用逐条裁决，访问未授予路径直接拒绝，**不需要预知脚本内容**。参考实现：Claude Code sandbox-runtime、OpenAI Codex CLI、nono、arapuca。

**OS 沙箱也有边界**：必须授予工作区可写才能干活，因此脚本**在工作区内部仍可为所欲为**。沙箱真正防住的是「爆炸半径外溢」（系统目录、家目录密钥、其他项目）。工作区内部保护靠三样，不是沙箱：
1. 执行入口的人工确认（`bash xxx.sh`、可疑 npm install 的调用级确认）；
2. git / 版本管理作为恢复网；
3. 高风险运行用隔离副本（容器/临时克隆，只把批准的输出拷回）。

### 1.3 已确认的目标（用户拍板）

- 主要威胁模型：**防误删 / 防事故（日常防呆）**；
- 平台要求：**三端一致（macOS / Windows / Linux）**；
- 隔离形态：曾先考虑 **L1 策略沙箱先行**，后经讨论修正为「L1 降级为防呆辅助，把运行时沙箱后端（L2）作为核心」——见第四节。

---

## 二、架构分层结论

| 层 | 职责 | 技术形态 | 强度 |
|---|---|---|---|
| **L0** | 现状直跑 | 持久 shell 以用户全权限 spawn | 无 |
| **L1 策略层（辅助）** | 只拦「简单命令的明显越界」，作为 UX 兜底与 Agent 自纠错信号；**明示不兜底** | 扩展现有 permission 判定链：可配置可写根/保护路径/越界升级确认 | 弱（防呆） |
| **L2 进程级沙箱（核心）** | 不可信/脚本内容一律进程级隔离执行 | macOS `sandbox-exec`（Seatbelt）/ Linux Landlock 或 bubblewrap / Windows AppContainer；**fail-closed**（不可用即拒绝执行，不裸跑） | 强（真隔离） |
| **L3（可选）** | 高风险代码的隔离副本 | 容器 / 微VM（libkrun 等），输出经批准拷回 | 最强 |

### 2.1 执行入口分级（补充层）

在 L1/L2 之前先判断内容可信度（项目内手写 vs 外部下载/不可信），决定走哪条执行路径：对 `bash xxx.sh` / 安装类调用升级确认，必要时先读脚本内容做摘要展示给用户。

---

## 三、集成要点（与现有代码的对接）

1. **接入点集中在两处 spawn**：
   - `bash-session.ts` `PersistentShell.ensureStarted()`（持久 shell）；
   - `BashSessionManager.startBackground()`（后台任务）。
   spawn 目标从 `bash` 改为 `<沙箱包装器> run -v <可写根> -- bash --noprofile --norc -s`。
2. **沙箱包住整个持久 shell 进程**，而非逐命令：内部所有命令/脚本自动继承约束，cd/export 持久化语义、bash_input 交互、后台长驻命令天然保留。
3. **fail-closed**：沙箱不可用（缺二进制 / 平台不支持 / 预检失败）时报错拒绝执行，绝不静默降级裸跑。
4. **判定链关系**：L1 拦截插入 `permission.ts` 的 `evaluateBash()` 开头，优先级高于 allowlist/会话放行/自动放行；越界写不应因白名单或「本批全部允许」被放行。
5. **三端一致的含义**：统一的是**策略合约 + UI 明示强度分级**，不是同等隔离强度（Windows 无 sandbox-exec/bwrap 可依赖，见下表）。

---

## 四、候选库调研（2026-09-04 逐仓库核实）

> ⚠️ 名字大量撞车，网上各有多同名项目，使用前务必核对仓库地址。

### 4.1 候选一览

| 库 | 语言 | 仓库（核实） | 平台覆盖（实测/声称） | Windows 后端强度 | 维护/成熟度 | 许可证 |
|---|---|---|---|---|---|---|
| **Arapuca** | Rust | github.com/LeGambiArt/arapuca | Linux/macOS/Windows 原生 | **AppContainer**（路径级 deny-by-default，最强） | 活跃：408 commits、v0.2.7（2026-08-17）、cosign 签名发布 | Apache-2.0 |
| **agentbox** | Go | github.com/zhangyunhao116/agentbox | macOS/Linux/Windows 原生 | Restricted Token + Job Object + Low IL + ACL（弱于 AppContainer） | **Beta，16 commits，单人维护**，v1.0 前 API 不稳定 | MIT |
| **ai-sandbox** | Rust | github.com/Teckwin/sandbox（crate 名 ai-sandbox） | 最广：+ FreeBSD Capsicum / OpenBSD pledge | Restricted Token（弱） | **已停更 5 个月**（2026-04 后无提交），v0.2.x | 未确认 |
| **nanosandbox / "nanobox"** | Rust | github.com/nanosandboxai（org，仅 cli 等 5 仓库） | 微VM 级（libkrun），**无 Windows** | 无 | org 5 stars、Jun 2026 停更 | 未确认 |
| **nono** | Rust | github.com/nolabs-ai/nono | macOS/Linux 原生，**Windows 仅 WSL2** | 无原生 | 最成熟：1675+ commits、~3.9k stars、v0.75（2026-09-01）、Sigstore 团队 + Datadog/Okta 背书 | Apache-2.0 |

### 4.2 Arapuca 详述（首选候选）

功能（与需求对应关系）：

- **Linux**：Landlock（ABI v1–v5 路径级读写白名单）——走 **Landlock 而非 bubblewrap 的 userns**，绕开 Ubuntu 24.04+ AppArmor `apparmor_restrict_unprivileged_userns` 限制；seccomp BPF（strict/baseline 两档）；cgroups v2（内存/CPU/PID）；PID/网络 namespace。
- **macOS**：Seatbelt（`sandbox-exec`）deny-default profile，三档网络模式（允许 / proxy-only / 拒绝）。
- **Windows**：AppContainer（deny-by-default 文件/网络，路径显式授予）+ Job Object + restricted token + mitigation policies。**AppContainer 用 Win32 API 即可由普通进程创建，不要求 MSIX 应用**。
- **跨平台通用**：fail-closed（任一限制应用失败即拒绝启动）；结构化审计（`--audit-files`/`--audit-network`，seccomp USER_NOTIF 输出 NDJSON，覆盖文件访问/进程派生/网络连接）；环境硬化（过滤 `LD_*`/`DYLD_*` 等注入变量）；资源限制（`--timeout/--memory/--cpus/--pids`）；`--allow-host` 走 CONNECT 代理放行指定域名的 HTTPS（Linux）。

CLI 形态（`arapuca run`，示例）：

```bash
arapuca run -v /path/to/workspace \
  --timeout 600 --memory 2048 \
  -- python3 build.py
```

集成方式：CLI 二进制（发布物 300–550 KB，cosign 签名 + sha256）或 C 静态库/C FFI（需经 Node FFI 加载，涉及 Electron ABI 重建，不推荐首期）。

已知风险 / 待验证项：

1. **网络默认语义**：Linux run 模式默认禁直接网络（npm/git 需 `--allow-host` 或 baseline）；macOS 默认允许。平台默认不一致，需先实测再定产品默认档，否则**沙箱一开 npm install 全挂**。
2. **可写根不只工作区**：npm/pnpm 缓存（`~/.npm` 等）、`~/.config`、全局安装位置需一并授予（对应产品配置项 `writableRoots`）。
3. **Windows 尚未发布二进制**：v0.2.7 release 仅 darwin/linux 产物，Windows AppContainer 后端在源码中——需确认能否官方发布或自行编译（Rust 工具链）。
4. **项目年轻**：v0.2.x、单人主导（多贡献者），作为生产安全边界需 pin 版本 + 自测逃逸用例。
5. 违背项目「不引入二进制依赖」的既有取舍（当初弃 ripgrep 保纯 JS）：沙箱物理上做不到纯 JS，需明示打破，可只在沙箱开启时才随包携带。

### 4.3 其余候选排除理由（供备选）

- **agentbox**：三平台 + API 简洁 + 纯库无依赖是亮点，但 16 commits 单人 beta 不足以当安全边界；且 **Go 库无法被 Node 直接 import**，需自维护 Go 桥接二进制的构建链进发布流程，收益不成立。**借鉴价值**：classifier → filesystem → network → process hardening 分层（与本项目 permission.ts 判定链同构，可参考实现 L1 的命令分类器设计）。
- **ai-sandbox**：平台最广（FreeBSD/OpenBSD）但 Windows 后端弱（Restricted Token，无路径级文件模型），已停更 5 个月；Rust crate 无现成发布物。
- **nanosandbox**：与早期表格描述（「极简 Docker 替代品 + Rust 库 nanobox + Python 绑定」）**严重不符**：实际是 libkrun **微VM 级** agent runner CLI，需要 KVM/虚拟化、无 Windows；同名项目混淆（如 JanRocketMan/nanobox = bubblewrap+mitmproxy 的 shell 脚本封装）。
- **nono**：成熟度与能力最强（argv 策略 + L7 代理凭据注入 + Merkle 审计链 + 签名 profile registry + snapshot/rollback），但**无 Windows 原生后端**（仅 WSL2），且架构偏「跑终端 Agent 的 broker 生态」而非「给任意 bash 套壳」，嵌入 Electron 成本高。**借鉴价值**：per-command argv 策略 + 域名级 L7 代理白名单 + 凭据边界注入的设计，适合后续「按工具微隔离」的增强。

### 4.4 选型结论

**arapuca 是唯一满足「三端一致 + 原生 OS 级 + 可包持久 shell 进程」的候选。** 其余按平台分水岭全部出局（Windows 是硬约束）。nono / agentbox 仅作设计参考，不作为依赖。

---

## 五、Spike 计划（按本文档搭建）

### 5.1 目标与验收标准

验证 arapuca 是否能作为本产品 bash 沙箱后端：

- [ ] 三平台至少二平台（Windows 优先，macOS/Linux 至少一个）能跑通 `arapuca run` 包住一个**持久 bash**（stdin 驱动，哨兵协议不变）；
- [ ] 持久会话语义保留：`cd` / `export` 在沙箱内生效并保留；
- [ ] 越界写被拒：工作区内 `rm -rf file` 成功，工作区外（如 `rm -rf ~/xxx`）被 OS 级拒绝；
- [ ] 常用开发命令可用：npm/pnpm install、git、node、编译（验证网络与 HOME/缓存授权问题）；
- [ ] fail-closed 行为：删掉/禁用沙箱二进制后，执行被拒绝而非裸跑；
- [ ] 记录各平台差异结论（网络默认、路径授权模型、额外坑）。

### 5.2 待验证问题清单

1. Windows AppContainer 后端可用性：v0.2.7 无 Windows 发布物 → 实测能否自行 `cargo build` 出 Windows 产物？AppContainer 对 Git Bash / PowerShell 是否可用？
2. 网络默认语义逐平台实测：默认是否禁网？`--allow-host`/baseline 对 npm/pnpm/git clone 的覆盖效果。
3. 授权清单：持久 bash + npm install 到底需要哪些可写路径（工作区、`~/.npm`、`~/.cache`、`~/.config`、`/tmp`）。
4. 与现有 kill 链路兼容：`PersistentShell` 的 SIGTERM→SIGKILL 整组终止对 arapuca 包装进程是否仍有效（进程组归属）。
5. `--cwd` 与 bash tool 的 `cwd` 参数、`cdCmd` 注入的配合。
6. 后台任务 `startBackground`（含 `background=true` 长驻命令）在沙箱内的行为与终止。
7. 二进制供应链：下载产物 sha256/cosign 校验流程是否进得通（国内网络可达性）。
8. 审计输出（`--audit-files`）的形态，能否对接现有日志体系。

### 5.3 步骤草稿

1. 下载目标平台发布物（或从源码编译 Windows 版），验证 sha256/cosign；
2. 写最小 demo：`arapuca run -v <workdir> -- bash --noprofile --norc -s`，从 Node/脚本向 stdin 依次发 `cd / pwd`、`export FOO=1; echo $FOO`、`rm -rf <外部文件>` 等探测沙箱行为；
3. 复刻关键场景：npm install、git status/clone、长驻命令后台跑 + 终止；
4. 记录每平台结论，填写 5.1 验收表。

### 5.4 决策门

- **Go**：5.1 全部通过（Windows 至少以「自行编译」方式可行），pin 具体版本，进入 L2 后端设计与权限/配置模型细化。
- **No-Go / 缓行**：Windows AppContainer 不可用或编译成本过高 → 回退「macOS/Linux 上 arapuca、Windows 先 L1 策略层 + 明示强度差异」的双轨方案（不阻塞三端 L1 先行）。
- 无论走哪条路，**L1 判定器（可写根/保护路径/越界升级确认）都可独立先行落地**，不依赖 L2 选型。

---

## 六、参考链接

- arapuca：https://github.com/LeGambiArt/arapuca | releases：https://github.com/LeGambiArt/arapuca/releases
- agentbox：https://github.com/zhangyunhao116/agentbox
- ai-sandbox：https://github.com/Teckwin/sandbox
- nanosandboxai（org）：https://github.com/orgs/nanosandboxai/repositories
- nono：https://github.com/nolabs-ai/nono | https://nono.sh/ | crate 文档 https://docs.rs/crate/nono-cli/0.72.0
- 平台现状参考：Claude Code sandbox-runtime（Linux 依赖 bubblewrap）、cmagent（Linux Landlock 优先）、Ubuntu 24.04 AppArmor userns 限制相关文档
