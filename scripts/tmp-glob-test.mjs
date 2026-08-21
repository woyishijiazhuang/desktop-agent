// 验证 createGlobMatcher（picomatch）的匹配行为
// 用法：node --experimental-strip-types scripts/tmp-glob-test.mjs
import { createGlobMatcher } from '../src/main/agent/tools/fs-walk.ts'

const cases = [
  // [pattern, 相对路径, 期望命中]
  ['**/*.tsx', 'src/a.tsx', true],
  ['**/*.tsx', 'a.tsx', true],
  ['src/**/*.test.ts', 'src/a/b.test.ts', true],
  ['src/**/*.test.ts', 'src/a.test.ts', true],
  ['*.{ts,js}', 'src/foo.ts', true], // 不含 /：按 basename 匹配
  ['*.{ts,js}', 'src/foo.js', true],
  ['*.{ts,js}', 'src/foo.jsx', false],
  ['[a-c].txt', 'b.txt', true],
  ['[a-c].txt', 'd.txt', false],
  ['src/*.ts', 'src/foo.ts', true],
  ['src/*.ts', 'src/sub/foo.ts', false],
  ['src/**', 'src/a.ts', true],
  ['src/**', 'src/a/b/c.ts', true],
  ['**/foo*', 'src/foo.txt', true],
  ['{a,b}/x', 'a/x', true],
  ['{a,b}/x', 'c/x', false],
  ['*.ts', '.hidden.ts', false], // 隐藏文件不匹配（dot:false，本次修复核心）
  ['*.ts', '.hidden/foo.ts', true], // 隐藏目录由 walkFiles 跳过（不遍历）；此处匹配器按 basename 如实返回
  ['*', '.gitignore', false],
  ['*', 'src/index.ts', true],
  ['src/**/x', 'src/x', true],
  ['src/**/x', 'src/a/x', true],
  ['src/**/x', 'src/a/b/x', true],
  ['.env*', '.env.local', true], // 显式写点号 → 匹配隐藏
  ['.*', '.gitignore', true]
]

let pass = 0
let fail = 0
for (const [pattern, rel, expected] of cases) {
  const matcher = createGlobMatcher(pattern)
  const got = matcher(rel)
  const ok = got === expected
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${pattern.padEnd(16)}  ${rel.padEnd(22)} → ${got}（期望 ${expected}）`)
}
console.log(`\n匹配器：${pass} 通过 / ${fail} 失败`)

// walkFiles 跳过隐藏目录（真实文件系统验证）
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkFiles } from '../src/main/agent/tools/fs-walk.ts'

const dir = await mkdtemp(join(tmpdir(), 'glob-test-'))
await mkdir(join(dir, 'visible'))
await mkdir(join(dir, '.hidden-dir'))
await writeFile(join(dir, 'visible', 'a.ts'), '')
await writeFile(join(dir, 'visible', 'b.js'), '')
await writeFile(join(dir, '.hidden-dir', 'c.ts'), '')
await writeFile(join(dir, '.hidden-file.ts'), '')
const walked = await walkFiles(dir, 1000)
const names = walked.files.map((f) => f.replace(dir + '/', '')).sort()
const okWalk =
  names.includes('visible/a.ts') &&
  names.includes('visible/b.js') &&
  names.includes('.hidden-file.ts') && // 隐藏文件仍列出
  !names.includes('.hidden-dir/c.ts') // 隐藏目录不遍历
console.log(`${okWalk ? 'PASS' : 'FAIL'}  walkFiles 跳过隐藏目录`, JSON.stringify(names))
if (okWalk) pass++
else fail++
await rm(dir, { recursive: true, force: true })

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)

