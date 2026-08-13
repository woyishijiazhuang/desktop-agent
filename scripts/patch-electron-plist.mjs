// 开发态 macOS 品牌修正：dev 直接以 Electron.app 运行，macOS 菜单栏左上角应用名与
// Dock 悬浮名称取自该 bundle 的 Info.plist（运行时无法用 app.setName 覆盖）。
// 故在 postinstall 时改写 CFBundleDisplayName / CFBundleName 为品牌名。
// 打包产物由 electron-builder 生成的 .app（productName）提供正确名称，本脚本不影响发布包。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_NAME = '桌面助手'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const plist = join(process.cwd(), 'node_modules/electron/dist/Electron.app/Contents/Info.plist')
try {
  if (!existsSync(plist)) throw new Error('Electron.app Info.plist 不存在')
  let xml = readFileSync(plist, 'utf-8')
  for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
    xml = xml.replace(
      new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`),
      `$1${APP_NAME}$2`
    )
  }
  writeFileSync(plist, xml, 'utf-8')
  console.log(`[patch-electron-plist] Electron.app Info.plist → "${APP_NAME}"`)
} catch (err) {
  // 非致命：仅影响开发态菜单栏/Dock 显示名，打包态不受影响
  console.warn('[patch-electron-plist] 跳过:', err instanceof Error ? err.message : err)
}
