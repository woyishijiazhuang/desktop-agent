import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import { resolve } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

const alias = {
  '@main': resolve('src/main'),
  '@preload': resolve('src/preload'),
  '@renderer': resolve('src/renderer/src')
}

/**
 * pdfjs-dist 的 Node 假 worker 是运行时 `import("./pdf.worker.mjs")`（相对主 chunk 解析，
 * 带 @vite-ignore 无法被 Rollup 静态打包），必须在构建产物里放一个同名 worker 文件。
 * worker 文件是自包含的 webpack bundle，无外部 import，直接原样复制即可。
 * 通过 mdize 的 realpath 解析 pdfjs-dist，兼容 pnpm 布局。
 */
function copyPdfJsWorker(): Plugin {
  return {
    name: 'copy-pdfjs-worker',
    generateBundle() {
      const req = createRequire(realpathSync(resolve('node_modules/mdize/package.json')))
      const workerPath = req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      this.emitFile({
        type: 'asset',
        fileName: 'pdf.worker.mjs',
        source: readFileSync(workerPath)
      })
    }
  }
}

const rendererInput = {
  // 应用本体（Vue 全家桶）
  index: resolve(process.cwd(), 'src/renderer/index.html'),
  // 自定义标题栏视图（独立 webContents，纯 HTML/CSS/JS，轻量无框架）
  header: resolve(process.cwd(), 'src/renderer/header/index.html')
}

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [copyPdfJsWorker()]
    // @earendil-works/pi-agent-core 和 pi-ai 是纯 ESM 包（exports 仅定义 import 条件，无 require
    // 条件），已放在 devDependencies，由 Rollup 打进主进程 bundle（ESM→CJS 转换），不会被
    // electron-vite externalize，也避免 electron-builder 把其 node_modules 拷贝塞进安装包。
  },
  preload: {
    resolve: { alias }
  },
  renderer: {
    plugins: [
      vue(),
      // Naive UI 按需引入：N* 组件自动注册（useMessage/useDialog 等 API 仍手动 import）。
      // dirs:[] 关闭本地组件目录扫描——本项目一律显式 import 本地组件，避免全局注册引发的歧义与过期 d.ts。
      Components({ resolvers: [NaiveUiResolver()], dirs: [] })
    ],
    resolve: { alias },
    optimizeDeps: {
      // stream-diffs 是 markstream-vue 代码块节点（彩色高亮）的运行时动态 import 依赖，
      // 不在入口 import 图中，vite 依赖预构建扫不到它 → 需显式 include。
      include: ['stream-diffs'],
      // markstream-vue 必须排除预构建：electron-vite 的渲染根目录在 src/renderer，
      // node_modules 位于根外、经 /@fs/ 提供服务；预构建产物内部的动态
      // import("./CodeBlockNode.js") 会被 vite 改写成绝对 /node_modules/.vite/deps/...，
      // 该路径在此布局下取不到 JS（SPA fallback 回退成 index.html），导致代码块高亮
      // 永远走 <pre> 回退。改为源码逐文件转换后，相对/裸导入均正确经 @fs 解析。
      exclude: ['markstream-vue']
    },
    build: {
      rollupOptions: {
        input: rendererInput
      }
    }
  }
})
