import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
// 仅关闭与格式化器（oxfmt）冲突的风格规则，不运行格式化检查
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  {
    // 根目录 index.js 是 electron-vite 主进程打包产物（未跟踪构建产物），不应被 lint；
    // .verify-dist 是浏览器验证用的临时构建目录（已在 .gitignore，eslint 不自动读它）。
    ignores: ['**/node_modules', '**/dist', '**/out', '**/.verify-dist', 'index.js']
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      // 下划线前缀=有意保留的未使用参数/变量（如服务骨架方法里用于声明推送签名的参数）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  eslintConfigPrettier
)
