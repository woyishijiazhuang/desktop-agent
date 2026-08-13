import { ElectronAPI } from '@electron-toolkit/preload'

/**
 * 渲染进程全局类型（原 index.d.ts，改名为 globals.d.ts 避免与 index.ts 同名被 TS 遮蔽）。
 * tsconfig.node.json 用 src/preload/** 同时收录 index.ts 与同名 d.ts 时，d.ts 会被丢弃，
 * 导致共享 store 在 node 检查下拿不到 window.electron 类型；改名后两套 tsconfig 均能生效。
 */
declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
  }
}

export {}
