import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import type { McpServerRow } from '../../database'
import { withTimeout, mcpResultToContent, buildMcpSpawnEnv } from './utils'

/**
 * 连接超时（毫秒）。stdio server 常用 `npx -y pkg` 启动，首次运行需联网下载包，
 * 冷启动可能耗时数十秒，过短的超时会把实际能连上的 server 误判失败。
 */
export const CONNECT_TIMEOUT_MS = 30_000
/** 拉取工具列表超时（握手成功后通常很快）。 */
export const LIST_TOOLS_TIMEOUT_MS = 10_000
/** stderr 诊断缓冲保留的尾部字符数。 */
const STDERR_TAIL_LIMIT = 4_000

export interface McpTool {
  name: string
  description: string
  inputSchema: unknown
}

/** 单个 server 的连接 + 已拉取的工具。 */
export interface McpConnection {
  client: Client
  tools: McpTool[]
  /** stdio server 的子进程 pid（http 传输无子进程，为 null）；应用退出时据此终止进程树。 */
  pid: number | null
}

/** 构造对应传输方式的 transport。 */
export async function buildTransport(row: McpServerRow): Promise<Transport> {
  if (row.transport === 'http') {
    const url = row.url ?? ''
    if (!url) throw new Error('HTTP 传输需要填写 server URL')
    return new StreamableHTTPClientTransport(new URL(url))
  }
  const command = row.command ?? ''
  if (!command) throw new Error('stdio 传输需要填写命令')
  let args: string[] = []
  try {
    args = row.args ? (JSON.parse(row.args) as string[]) : []
  } catch {
    args = []
  }
  let env: Record<string, string> = {}
  try {
    env = row.env ? (JSON.parse(row.env) as Record<string, string>) : {}
  } catch {
    env = {}
  }
  // 打包后的 GUI 应用 PATH 不含终端登录 shell 的目录（npx/node 常装在 Homebrew/nvm
  // 目录），用解析后的增强 PATH 启动子进程；stderr 改 pipe 以便失败时回传诊断输出。
  return new StdioClientTransport({
    command,
    args,
    env: await buildMcpSpawnEnv(env),
    stderr: 'pipe'
  })
}

/**
 * 连接单个 server 并拉取工具（含超时）。
 * 失败时关闭 client 并抛出，由调用方决定记录错误或返回失败结果。
 */
export async function connectMcpServer(row: McpServerRow): Promise<McpConnection> {
  const client = new Client({ name: 'my-app', version: '1.0.0' }, { capabilities: {} })
  // 收集 server stderr 尾部：打包应用无终端，npx/npm 的报错只能靠这里回传给设置页。
  let stderrTail = ''
  try {
    const transport = await buildTransport(row)
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT)
      })
    }
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 MCP「${row.name}」`)
    const { tools } = await withTimeout(
      client.listTools(),
      LIST_TOOLS_TIMEOUT_MS,
      `拉取 MCP「${row.name}」工具`
    )
    return {
      client,
      // 只有 stdio 传输才有子进程；该 pid 供应用退出时同步终止整棵进程树
      pid: transport instanceof StdioClientTransport ? transport.pid : null,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as unknown) ?? {}
      }))
    }
  } catch (err) {
    const enriched = enrichConnectError(err, row, stderrTail)
    try {
      await client.close()
    } catch {
      // 忽略关闭失败
    }
    throw enriched
  }
}

/** 把底层错误转成可操作的中文提示（命令缺失/超时附上原因与修复建议、stderr 诊断）。 */
function enrichConnectError(err: unknown, row: McpServerRow, stderrTail: string): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  const stderrHint = formatStderrHint(stderrTail)
  if (row.transport === 'stdio') {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || /enoent|not found|找不到|no such file/i.test(original.message)) {
      return new Error(
        `启动命令「${row.command ?? ''}」失败：系统找不到该可执行文件。请确认已安装对应工具` +
          '（npx 随 Node.js 安装）；打包应用不继承终端 PATH，如已安装仍报错，请把命令改成绝对路径' +
          `（如 /opt/homebrew/bin/npx、~/.nvm/versions/node/<版本>/bin/npx）。${stderrHint}`
      )
    }
    if (/超时/.test(original.message)) {
      return new Error(
        `${original.message}。stdio server 首次经 npx 启动需联网下载包，弱网下可能耗时较久，请检查网络后重试。` +
          stderrHint
      )
    }
  }
  return new Error(original.message + stderrHint)
}

/** stderr 尾部非空时拼接为错误信息的诊断片段。 */
function formatStderrHint(stderrTail: string): string {
  const tail = stderrTail.trim()
  if (!tail) return ''
  return `\n进程输出：${tail.slice(-1_000)}`
}

/** 经连接调用 MCP server 的 tools/call，结果转 pi-ai content blocks。 */
export async function callMcpTool(
  client: Client,
  name: string,
  params: unknown
): Promise<(TextContent | ImageContent)[]> {
  const result = await client.callTool({
    name,
    arguments: (params ?? {}) as Record<string, unknown>
  })
  return mcpResultToContent(result.content)
}
