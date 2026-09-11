/* eslint-disable */ // spike 脚本：不纳入项目 lint 规则
// srt spike v3（最终）：库形态验证 —— SandboxManager 包住持久 bash（stdin 驱动）
// 验证项对应 docs/bash-sandbox-research.md 5.5 验收标准 A/B/C
// 运行：node scripts/spike-srt.mjs
import { spawn } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, pass, detail = '') =>
  results.push({ name, pass: !!pass, detail: String(detail) })

// 一次性执行一条「已包装」命令，返回 { code, out, err }
function runWrapped(wrapped, cwd) {
  return new Promise((resolve) => {
    const c = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd,
      env: { ...process.env, ...wrapped.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let o = '',
      e = ''
    c.stdout.on('data', (d) => (o += d))
    c.stderr.on('data', (d) => (e += d))
    c.on('close', (code) => resolve({ code, out: o, err: e }))
  })
}

const main = async () => {
  const root = mkdtempSync(join(tmpdir(), 'srt-spike-'))
  const work = join(root, 'work')
  const secretDir = join(root, 'secret')
  mkdirSync(work)
  mkdirSync(secretDir)
  writeFileSync(join(secretDir, 'token.txt'), 'TOPSECRET\n')
  const outsideFile = join(homedir(), 'srt-spike-outside.txt')
  rmSync(outsideFile, { force: true })

  const baseConfig = {
    filesystem: { denyRead: [secretDir], allowWrite: [work, '/tmp'], denyWrite: [] },
    // macOS：域名 allowlist 由「宿主侧共享代理」执行（全局态）；逐调用 customConfig
    // 覆盖不生效（实测返回 403）。因此这里直接在初始化配置中带白名单，
    // C-1/C-2 用「白名单内放行 / 白名单外拒绝」对照验证。
    network: { allowedDomains: ['example.com'], deniedDomains: [], allowLocalBinding: true }
  }
  await SandboxManager.initialize(baseConfig)

  try {
    // ===== A/B：持久 bash（stdin 驱动，哨兵协议） =====
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      'bash --noprofile --norc -s',
      undefined,
      undefined,
      undefined,
      work
    )
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: work,
      env: { ...process.env, ...wrapped.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const spawnT0 = Date.now()
    let outBuf = '',
      errBuf = ''
    let firstByteAt = null
    child.stdout.on('data', (d) => {
      if (firstByteAt === null) firstByteAt = Date.now()
      outBuf += d.toString()
    })
    child.stderr.on('data', (d) => {
      errBuf += d.toString()
    })
    const exited = new Promise((r) => child.on('exit', r))

    const send = (line) => {
      child.stdin.write(`${line}\necho __SRT_DONE__\n`)
    }
    const waitChunk = async (timeoutMs = 15000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        const i = outBuf.indexOf('__SRT_DONE__')
        if (i !== -1) {
          const chunk = outBuf.slice(0, i)
          outBuf = outBuf.slice(i + 12)
          return chunk
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          return (
            outBuf + `\n[进程已退出 code=${child.exitCode}]` + (errBuf ? `\nstderr: ${errBuf}` : '')
          )
        }
        await sleep(40)
      }
      return null
    }

    const out1 = await (send('cd ' + work + ' && pwd'), waitChunk())
    record(
      'A 持久 bash 启动且首条命令即时返回',
      out1 !== null && out1.includes(work),
      `首字节延迟 ${firstByteAt ? firstByteAt - spawnT0 : '?'}ms，out=${JSON.stringify(out1)}`
    )
    record(
      'A 首字节延迟 <= 2s（无异常启动慢）',
      firstByteAt !== null && firstByteAt - spawnT0 <= 2000,
      `延迟 ${firstByteAt ? firstByteAt - spawnT0 : '无输出'}ms`
    )

    send('export SRT_FOO=42; echo "FOO=$SRT_FOO"')
    const out2 = await waitChunk()
    record('B-export 在会话内生效', out2 !== null && out2.includes('FOO=42'), JSON.stringify(out2))

    send('pwd')
    const out3 = await waitChunk()
    record('B-cd 状态跨命令保留', out3 !== null && out3.includes(work), JSON.stringify(out3))

    send('echo aaa > in-work.txt && cat in-work.txt && ls in-work.txt')
    const out4 = await waitChunk()
    record('B 工作区内写/读/列出成功', out4 !== null && out4.includes('aaa'), JSON.stringify(out4))

    send(`echo bbb > ${outsideFile}; echo "exit=$?"`)
    const out5 = await waitChunk()
    record(
      'B 工作区外（HOME）写被 OS 级拒绝',
      out5 !== null &&
        /exit=[1-9]/.test(out5) &&
        /Operation not permitted|denied/i.test(out5 + errBuf),
      `out=${JSON.stringify(out5)} err=${errBuf}`
    )

    send(`cat ${join(secretDir, 'token.txt')}; echo "exit=$?"`)
    const out6 = await waitChunk()
    record(
      'B denyRead 路径读取被拒',
      out6 !== null &&
        /exit=[1-9]/.test(out6) &&
        /Operation not permitted|denied/i.test(out6 + errBuf),
      `out=${JSON.stringify(out6)} err=${errBuf}`
    )

    const hostSecret = readFileSync(join(secretDir, 'token.txt'), 'utf8').trim()
    record('对照 host 进程不受沙箱影响（仍可读 secret）', hostSecret === 'TOPSECRET', hostSecret)

    // ===== C：网络（一次性命令；白名单 example.com） =====
    const denied = await SandboxManager.wrapWithSandboxArgv(
      'curl -sS -m 10 https://example.org/',
      undefined,
      undefined,
      undefined,
      work
    )
    const n1 = await runWrapped(denied, work)
    record(
      'C-1 非白名单域名被拒（example.org）',
      n1.code !== 0 || /blocked|denied|not permitted|403/i.test(n1.out + n1.err),
      `code=${n1.code} out=${n1.out.trim().slice(0, 80)} err=${n1.err.trim().slice(0, 120)}`
    )

    const allowed = await SandboxManager.wrapWithSandboxArgv(
      'curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com/',
      undefined,
      undefined,
      undefined,
      work
    )
    const n2 = await runWrapped(allowed, work)
    record(
      'C-2 allowlist 域名放行（example.com=200）',
      n2.code === 0 && /200/.test(n2.out),
      `code=${n2.code} out=${n2.out.trim()} err=${n2.err.trim().slice(0, 120)}`
    )

    // 收尾
    send('exit 0')
    await Promise.race([exited, sleep(3000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(outsideFile, { force: true })
  } finally {
    await SandboxManager.reset()
  }

  console.log('\n===== srt spike 结果 =====')
  let failed = 0
  for (const r of results) {
    if (!r.pass) failed += 1
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`)
    if (!r.pass) console.log('      ' + r.detail.replace(/\n/g, '\n      '))
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('spike 异常退出:', e)
  process.exit(2)
})
