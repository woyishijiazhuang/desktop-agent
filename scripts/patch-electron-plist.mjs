// 开发态 macOS 品牌修正：dev 直接以 Electron.app 运行，macOS 菜单栏左上角应用名与
// Dock 悬浮名称取自该 bundle 的 Info.plist（运行时无法用 app.setName 覆盖）。
// 故在 postinstall 时改写 CFBundleDisplayName / CFBundleName 为品牌名。
// 打包产物由 electron-builder 生成的 .app（productName）提供正确名称，本脚本不影响发布包。
// 另注入 NSMicrophoneUsageDescription：dev 态没有 usage description 时 macOS 会静默拒绝麦克风。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_NAME = '桌面助手'
const MIC_USAGE = '桌面助手需要使用麦克风进行语音对话。'

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
  if (xml.includes('NSMicrophoneUsageDescription')) {
    // Electron 出厂自带默认描述，替换为品牌文案
    xml = xml.replace(
      /(<key>NSMicrophoneUsageDescription<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${MIC_USAGE}$2`
    )
  } else {
    xml = xml.replace(
      '<dict>',
      '<dict>\n\t<key>NSMicrophoneUsageDescription</key>\n\t<string>' + MIC_USAGE + '</string>'
    )
  }
  writeFileSync(plist, xml, 'utf-8')
  console.log(`[patch-electron-plist] Electron.app Info.plist → "${APP_NAME}"（含麦克风权限描述）`)
} catch (err) {
  // 非致命：仅影响开发态菜单栏/Dock 显示名，打包态不受影响
  console.warn('[patch-electron-plist] 跳过:', err instanceof Error ? err.message : err)
}
