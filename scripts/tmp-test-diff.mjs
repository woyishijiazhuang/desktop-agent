// 临时验证脚本：edit_file unified diff 正确性（git apply 回放比对，验证后删除）
// 用法：node --experimental-strip-types scripts/tmp-test-diff.mjs
import { register } from 'node:module'
import { writeFile, copyFile, mkdir } from 'node:fs/promises'
register(new URL('./tmp-resolver.mjs', import.meta.url))
const { editFileTool } = await import('../src/main/agent/tools/edit-file.ts')

await mkdir('/tmp/difftest', { recursive: true })
const SRC = `line-1
line-2
const a = 1
line-4
line-5
line-6
line-7
line-8
line-9
function tail() {}
line-11
`
// 原始内容备份 → 工具编辑 → 期望文件
await writeFile('/tmp/difftest/a.txt', SRC, 'utf-8')
await copyFile('/tmp/difftest/a.txt', '/tmp/difftest/a-backup.txt')

const r = await editFileTool.execute(
  't1',
  {
    path: 'a.txt',
    edits: [
      { oldText: 'const a = 1', newText: 'const a = 2\nconst b = 3' },
      { oldText: 'line-6', newText: '' },
      { oldText: 'function tail() {}', newText: 'function tail() { return 42 }' }
    ]
  },
  undefined
)
console.log('--- diff ---')
console.log(r.details.diff)
await writeFile('/tmp/difftest/diff.patch', r.details.diff + '\n', 'utf-8')
await copyFile('/tmp/difftest/a.txt', '/tmp/difftest/expected.txt')
console.log('--- expected written ---')
