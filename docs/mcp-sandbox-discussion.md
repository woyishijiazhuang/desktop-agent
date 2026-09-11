# MCP Server 沙箱隔离：讨论记录

> 状态：**设计讨论（暂不实施）**
> 日期：2026-09-09
> 结论：业界均未对 MCP server 做 OS 级沙箱隔离，当前优先级不高，先记录方案备查。

---

## 1. 问题背景

当前权限系统修复了 MCP 工具调用的确认盲区（`mcp_call` 加入 `DANGEROUS_TOOLS`），但存在一个更深层的问题：**即使用户批准了 `mcp_call`，如果 MCP server 暴露了文件读写或命令执行工具，沙箱无法拦截其实际行为**。

原因：沙箱文件策略（`wrapSandboxFsPolicy`）只包装了内置工具（write_file / edit_file / read_file / download），MCP 工具走 `mcp_call` → `mcpManager.invokeTool()` → MCP SDK，完全绕过沙箱。

---

## 2. 业界现状

| 产品        | MCP 沙箱策略                                    |
| ----------- | ----------------------------------------------- |
| Claude Code | 无 OS 级沙箱，靠 `allowedTools` 配置 + 用户确认 |
| Cursor      | 工作区信任分级 + MCP 工具确认，无 OS 沙箱       |
| Windsurf    | MCP 工具需审批，无文件系统沙箱                  |
| Zed         | MCP 支持较轻量，工具调用需确认                  |

**结论**：目前没有产品对 MCP server 做 OS 级进程沙箱隔离。

---

## 3. 可行方案（备查）

### 3.1 方案：自定义 Transport + SandboxManager

针对 **stdio 传输**的本地 MCP server，可通过自定义 `StdioClientTransport` 包装，在 `start()` 方法中先调用 `SandboxManager.wrapWithSandboxArgv()` 套入 OS 沙箱，再 spawn 子进程。

**实现路径**：

1. 在 `src/main/agent/mcp/client.ts` 的 `buildTransport` 中，不直接 `new StdioClientTransport(...)`，改为创建自定义 Transport。
2. 自定义 Transport 的 `start()` 中：
   - 调用 `SandboxManager.wrapWithSandboxArgv(command, args, fsPolicy, network, cwd)` 获得沙箱包装后的 argv
   - 用包装后的 argv 启动子进程
   - 保留 MCP 协议的 stdin/stdout 管道通信
3. 复用 `sandbox.ts` 中已有的基础设施（`ensureSandboxManager`、`readSandboxSettings`、`platformTempPaths`）。

**涉及文件**：

| 文件                           | 改动                                          |
| ------------------------------ | --------------------------------------------- |
| `src/main/agent/mcp/client.ts` | `buildTransport` 改为创建沙箱包装的 Transport |
| `src/main/agent/mcp/types.ts`  | `McpServerRow` 可能需扩展 `cwd` 字段          |
| `src/main/agent/sandbox.ts`    | 可能需新增 `wrapMcpTransport` 辅助函数        |
| `src/main/database/schema.ts`  | `mcp_servers` 表可能需加 `cwd` 列             |

### 3.2 未解决的问题

| 问题          | 说明                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------- |
| cwd 来源      | DB 的 `McpServerRow` 无 `cwd` 字段，MCP server 工作目录应如何确定？                            |
| HTTP 远程 MCP | 远程 MCP 的计算在服务端，本地沙箱无意义，需区分处理                                            |
| 网络白名单    | MCP server 可能需访问外部 API（npm registry、GitHub 等），是否复用 bash 沙箱的同一套白名单？   |
| 连接超时      | `SandboxManager.wrapWithSandboxArgv` 是异步操作，首次调用还需初始化，可能影响 MCP 8 秒连接超时 |
| fail-closed   | 沙箱包装失败时 MCP server 不启动（与 bash 行为一致），但影响范围更大（整个 MCP server 不可用） |

---

## 4. 不实施的理由

1. **业界无先例**：Claude Code、Cursor、Windsurf 均未对 MCP 做 OS 级沙箱隔离。
2. **复杂度收益比**：需自定义 Transport + 解决 cwd / 超时 / 网络白名单等多个边界问题，改动面较大。
3. **已有替代防御**：权限确认（`mcp_call` 加入 `DANGEROUS_TOOLS`）+ 用户可按 server 禁用 + 会话放行机制，已覆盖主要场景。
4. **MCP server 自身安全**：大多数 MCP server 是开源工具（如 filesystem、github、sqlite），其自身行为已知；恶意 MCP server 是用户主动安装的，属于信任边界问题。

---

## 5. 后续触发条件

如以下任一条件成立，可重新评估此方案：

- 用户反馈具体的安全事件（MCP server 越权文件访问等）
- 业界出现对 MCP 做沙箱隔离的标杆产品
- 应用面向企业/高安全场景，有合规要求
