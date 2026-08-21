// 概念验证：持久化 shell 协议（与 bash-session.ts 的 PersistentShell 同构）。
// 验证 macOS /bin/bash 3.2 非交互 -s 模式：
//   1) 哨兵 + $? 退出码框架可用
//   2) cd 跨命令持久化
//   3) SIGINT 进程组后 shell 是否存活
// 用法：node scripts/tmp-bash-session-test.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const child = spawn('bash', ['--noprofile', '--norc', '-s'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  env: process.env,
  cwd: '/Users/hupengfei/Documents/my-app'
})

let buf = ''
let lineBuf = ''
const sentinelRe = /^__PI_BASH_DONE_([0-9a-f-]{36})__:(-?\d+)\r?$/

child.stdout.setEncoding('utf-8')
child.stderr.setEncoding('utf-8')
child.stdout.on('data', (c) => {
  buf += c
  lineBuf += c
  let idx
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx)
    lineBuf = lineBuf.slice(idx + 1)
    const m = sentinelRe.exec(line)
    if (m) {
      // 与 PersistentShell 一致：从累计输出中剔除哨兵行（lastIndexOf 命中末尾）
      const at = buf.lastIndexOf(line + '\n')
      if (at >= 0) buf = buf.slice(0, at)
      resolvePending(m[1], Number(m[2]))
    }
  }
})
child.stderr.on('data', () => {})

// shell 意外退出（如命令里执行 exit/kill $$）：与 PersistentShell.failAll 一致，兜底结算
child.on('close', (code) => {
  for (const [id, r] of pending) {
    pending.delete(id)
    r({ output: buf + `\n[shell 已退出，exitCode=${code}]`, exitCode: null })
  }
})

let pending = new Map()
function run(cmd, { waitFor = null } = {}) {
  const id = randomUUID()
  return new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(`${cmd}\nprintf '__PI_BASH_DONE_${id}__:%d\\n' "$?"\n`)
    if (waitFor) {
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          resolve({ output: buf, exitCode: 'TIMEOUT-NO-SENTINEL', timeout: true })
        }
      }, waitFor)
    }
  })
}
function resolvePending(id, code) {
  const r = pending.get(id)
  if (!r) return
  pending.delete(id)
  r({ output: buf, exitCode: code })
}
const assert = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

// 1) 基本输出 + 退出码
let r = await run("echo hello; pwd")
assert('echo+pwd 输出与退出码', r.exitCode === 0 && /hello/.test(r.output), JSON.stringify(r))
const cwdAfter = (r.output.match(/hello\n(.+)/) || [])[1]?.trim()
const startBuf = buf.length

// 2) cd 持久化
r = await run('cd /tmp')
assert('cd 退出码 0', r.exitCode === 0, String(r.exitCode))
r = await run('pwd')
assert('cd 持久化：pwd=/tmp', r.exitCode === 0 && /\/tmp/.test(r.output), r.output.trim())

// 3) 非零退出码（子 shell 退出，不杀持久 shell）
r = await run("bash -c 'exit 7'")
assert('exit 7 哨兵退出码', r.exitCode === 7, String(r.exitCode))

// 4) 哨兵行不进入输出（剔除校验：buf 相对起点不含哨兵）
r = await run('echo after')
const frag = buf.slice(startBuf)
assert('哨兵行未混入输出', !/__PI_BASH_DONE_/.test(frag), frag.split('\n').slice(0, 4).join('|'))

// 5) 超时中断：SIGTERM 终止整个进程组（非交互 bash 无法只杀命令），会话重置
r = await run('sleep 30', { waitFor: 2000 })
assert('sleep 30 超时未完成（预期）', r.timeout === true, String(r.exitCode))
if (child.pid) {
  try {
    process.kill(-child.pid, 'SIGTERM')
    console.log('     已向进程组发 SIGTERM')
  } catch (e) {
    console.log('     SIGTERM 失败:', e.message)
  }
}
await new Promise((s) => setTimeout(s, 800))
const shellGone = child.exitCode !== null || child.signalCode !== null
assert('SIGTERM 后 shell 整体终止（会话重置）', shellGone, `exitCode=${child.exitCode} signalCode=${child.signalCode}`)

// 6) 会话重建：新 shell 立即可用（模拟下次 bash 调用）
const child2 = spawn('bash', ['--noprofile', '--norc', '-s'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  env: process.env,
  cwd: '/Users/hupengfei/Documents/my-app'
})
let buf2 = ''
let lineBuf2 = ''
let pending2 = new Map()
child2.stdout.setEncoding('utf-8')
child2.stdout.on('data', (c) => {
  buf2 += c
  lineBuf2 += c
  let i
  while ((i = lineBuf2.indexOf('\n')) >= 0) {
    const line = lineBuf2.slice(0, i)
    lineBuf2 = lineBuf2.slice(i + 1)
    const m = sentinelRe.exec(line)
    if (m) {
      const rr = pending2.get(m[1])
      if (rr) {
        pending2.delete(m[1])
        rr(Number(m[2]))
      }
    }
  }
})
const run2 = (cmd) => {
  const id = randomUUID()
  return new Promise((res) => {
    pending2.set(id, res)
    child2.stdin.write(`${cmd}\nprintf '__PI_BASH_DONE_${id}__:%d\\n' "$?"\n`)
    setTimeout(() => {
      if (pending2.has(id)) {
        pending2.delete(id)
        res('HANG')
      }
    }, 3000)
  })
}
r = await run2('echo recreated-shell')
assert('重建 shell 立即可用', r === 0 && /recreated-shell/.test(buf2), `exit=${r}`)
child2.kill('SIGKILL')

console.log(process.exitCode === 0 || process.exitCode === undefined ? '\n全部通过' : '\n存在失败项')
