/** @type {import('lint-staged').Config} */
export default {
  // 代码文件：先 oxfmt 格式化，再过 ESLint（--fix 自动修复；剩余错误/警告阻断提交）
  '*.{js,mjs,cjs,ts,mts,cts,tsx,vue}': ['oxfmt', 'eslint --fix --max-warnings=0'],
  // 其余 oxfmt 支持的文件类型：只格式化
  '*.{json,jsonc,yaml,yml,html,css,scss,less,md,mdx}': ['oxfmt']
}
