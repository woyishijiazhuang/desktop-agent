/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * 图标生成脚本（一次性工具，可重复运行以微调设计）。
 * 产出：
 * - resources/icon.png            512×512 运行时图标（Dock 设置 + Linux/Win 窗口图标）
 * - build/icon.png                1024×1024 electron-builder 打包源（缺省时自动转 icns/ico）
 * - resources/tray-icon.png       32×32 彩色徽章（Windows/Linux 托盘：渐变方块 + 白色镂空星）
 * - resources/tray-icon-template.png 36×36 白块镂空星模板（macOS 菜单栏，系统自动着色）
 *
 * 设计：纯紫渐变圆角方块 + 白色四角星光（Sparkle）。
 * 品牌色：#8b5cf6 → #5b21b6（violet-500 → violet-800）。
 */
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 真正的 Squircle 路径：五次超椭圆 |x/hw|^5 + |y/hh|^5 = 1（Apple 同款连续曲率圆角，
 * 优于 arcTo 拼接的普通圆角矩形）。逐象限采样连成平滑闭合曲线。
 */
function squircle(ctx, x, y, w, h) {
  const hw = w / 2
  const hh = h / 2
  const cx = x + hw
  const cy = y + hh
  const n = 5
  const samples = 120
  ctx.beginPath()
  for (let q = 0; q < 4; q++) {
    for (let i = 0; i <= samples; i++) {
      const t = i / samples
      const ft = Math.pow(1 - Math.pow(t, n), 1 / n)
      let px
      let py
      if (q === 0) {
        px = cx + hw * t
        py = cy - hh * ft
      } else if (q === 1) {
        px = cx + hw * ft
        py = cy + hh * t
      } else if (q === 2) {
        px = cx - hw * t
        py = cy + hh * ft
      } else {
        px = cx - hw * ft
        py = cy - hh * t
      }
      if (i === 0 && q === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
  }
  ctx.closePath()
}

/**
 * 四角星光路径：外点位于上/右/下/左，内点位于四个对角线，
 * 用二次曲线把相邻外点经内点连起来，形成标准 sparkle 凹弧。
 * @param ratio 内径/外径（凹刻深度，越大越接近圆润的菱形）
 */
function sparkle(ctx, cx, cy, R, ratio = 0.32) {
  const r = R * ratio
  const pt = (q, rad) => ({
    x: cx + rad * Math.cos(q * Math.PI),
    y: cy + rad * Math.sin(q * Math.PI)
  })
  // 外点：右、下、左、上（屏幕坐标顺时针）
  const outer = [0, 0.5, 1, 1.5].map((q) => pt(q, R))
  // 内点：右下、左下、左上、右上
  const inner = [0.25, 0.75, 1.25, 1.75].map((q) => pt(q, r))
  ctx.beginPath()
  ctx.moveTo(outer[0].x, outer[0].y)
  for (let i = 0; i < 4; i++) {
    ctx.quadraticCurveTo(inner[i].x, inner[i].y, outer[(i + 1) % 4].x, outer[(i + 1) % 4].y)
  }
  ctx.closePath()
}

/**
 * 应用主图标：Squircle 底 + 层次渐变 + 星光光晕 + 点缀星。
 * 四周 10% 透明留白（主体占 80% 画布）：对齐 Apple macOS 图标网格标准
 *（Dock 按 alpha 形状直接显示、不统一遮罩，留白比例决定了与其他图标的视觉大小一致性）。
 */
function drawAppIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const pad = size * 0.1
  const w = size - pad * 2
  const cx = size / 2

  // 背景 Squircle：对角三段渐变（亮紫 → 主紫 → 深紫）
  squircle(ctx, pad, pad, w, w)
  const grad = ctx.createLinearGradient(pad, pad, pad + w, pad + w)
  grad.addColorStop(0, '#a78bfa')
  grad.addColorStop(0.45, '#7c3aed')
  grad.addColorStop(1, '#4c1d95')
  ctx.fillStyle = grad
  ctx.fill()

  // 主星光背后的柔光晕
  const glow = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.34)
  glow.addColorStop(0, 'rgba(255,255,255,0.18)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  // 主星光（白）
  sparkle(ctx, cx, cx, w * 0.31, 0.24)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // 两颗小点缀星（右上/左下，低透明度，与主星呼应不抢戏）
  ctx.globalAlpha = 0.72
  sparkle(ctx, size * 0.73, size * 0.31, size * 0.05, 0.35)
  ctx.fill()
  sparkle(ctx, size * 0.27, size * 0.69, size * 0.036, 0.35)
  ctx.fill()
  ctx.globalAlpha = 1

  return canvas.toBuffer('image/png')
}

/**
 * macOS 菜单栏托盘：白色 Squircle 块 + 中间镂空星光（destination-out 把星从块里挖掉）。
 * 模板图源色为黑，系统按菜单栏深浅色自动着色（深色栏显白块、浅色栏显黑块），星洞透出菜单栏底色。
 */
function drawMacTemplateBadge(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const t = size * 0.92
  squircle(ctx, (size - t) / 2, (size - t) / 2, t, t)
  ctx.fillStyle = '#000000'
  ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  sparkle(ctx, size / 2, size / 2, size * 0.3, 0.45)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  return canvas.toBuffer('image/png')
}

/**
 * Windows/Linux 托盘徽章：迷你版应用图标（紫色渐变 Squircle + 白色镂空星光）。
 * 托盘图标可顶满画布（不同于 Dock 图标的留白规范）。
 */
function drawTrayBadge(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  squircle(ctx, 0, 0, size, size)
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#a78bfa')
  grad.addColorStop(0.45, '#7c3aed')
  grad.addColorStop(1, '#4c1d95')
  ctx.fillStyle = grad
  ctx.fill()
  // 白色镂空星光（只描边不填充）
  sparkle(ctx, size / 2, size / 2, size * 0.32, 0.42)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(1.5, size * 0.075)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
  return canvas.toBuffer('image/png')
}

function main() {
  // ---- 主图标（两处：resources 供运行时 Dock/窗口图标，build 供 electron-builder 打包源） ----
  // build/icon.icns、icon.ico 不单独生成：electron-builder 缺省时自动从 build/icon.png 转换。
  writeFileSync(resolve(root, 'resources/icon.png'), drawAppIcon(512))
  writeFileSync(resolve(root, 'build/icon.png'), drawAppIcon(1024))
  console.log('✓ resources/icon.png (512), build/icon.png (1024)')

  // ---- 托盘图标 ----
  // Windows/Linux：彩色徽章（渐变圆角方块 + 白色镂空星光）；macOS：白色圆角块 + 镂空星光模板。
  // @1x 不单独生成：tray-service 运行时从 @2x 缩放派生。
  writeFileSync(resolve(root, 'resources/tray-icon.png'), drawTrayBadge(32))
  writeFileSync(resolve(root, 'resources/tray-icon-template.png'), drawMacTemplateBadge(36))
  console.log('✓ resources/tray-icon.png（win 彩色徽章）, tray-icon-template.png（mac 白块镂空）')
}

main()
