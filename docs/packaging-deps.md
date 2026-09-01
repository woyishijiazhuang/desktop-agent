# 打包产物依赖说明

> 本文档说明「桌面助手」打包产物（electron-builder 生成的 app.asar）里依赖的进入与排除策略：
> 哪些依赖会进入产物、哪些不会、为什么，以及验证方法。配合 [electron-builder.yml](../electron-builder.yml) 阅读。

---

## 1. 两条依赖路径

打包产物中的「代码」来自两个完全不同的入口，理解这一点是排查所有打包依赖问题的前提：

| 路径 | 依赖归属 | 进入产物的方式 | 运行时解析 |
|---|---|---|---|
| **Bundle 路径** | `devDependencies` | electron-vite 的 Rollup 在构建时把代码**打进** `out/main`、`out/renderer` 的 JS chunk | 无需 node_modules，代码已在产物里 |
| **node_modules 路径** | `dependencies` | electron-builder 把生产依赖（含其传递依赖）**收集进** `app.asar/node_modules` | 主进程 `require()` 从 asar 内解析 |

判断规则：

- **主进程 / preload 里被 `import` 的包**：若在 `dependencies`，electron-vite 默认会把它 externalize（bundle 里留 `require('xxx')`，运行时从 node_modules 解析）；若在 `devDependencies`，则被打进 bundle。
- **渲染进程里被 `import` 的包**（vue、naive-ui 等）：无论归属，都由 vite 打进渲染 bundle，**不需要**进入产物 node_modules。
- **仅静态类型依赖**（`@types/*`）：编译期使用，打包时明确排除。

---

## 2. files 规则：白名单 / 黑名单机制

`electron-builder.yml` 的 `files` 段以 `**/*` 全量为基础，再逐条排除。对 node_modules 的处理：

```yaml
files:
  - '**/*'
  # 开发内容：源码映射 / 类型声明，运行时均不需要
  - '!**/*.map'
  - '!**/*.{d.ts,d.mts,d.cts}'
  # 纯类型声明包（含经 protobufjs → @types/node 带入的 undici-types），运行时绝不 require
  - '!node_modules/@types/**'
  - '!node_modules/undici-types/**'
  # 语音 VAD：JS 已由 vite 打进渲染产物，运行时仅需 wasm / onnx 资源
  - '!node_modules/onnxruntime-web/**'
  - 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs,jsep.mjs,jspi.mjs,asyncify.mjs}'
  - '!node_modules/@ricky0123/vad-web/**'
  - 'node_modules/@ricky0123/vad-web/dist/silero_vad_{legacy,v5}.onnx'
  - 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'
```

关键点：

- **onnxruntime-web 全量 ~133MB，只保留运行时实际加载的 5 个文件**（`appasset://` 协议会把一切 wasm 请求回退到 `ort-wasm-simd-threaded.wasm`，其余 jsep/jspi/asyncify 变体不需要）。
- **vad-web 保留 3 个文件**：2 个 onnx 模型（Silero VAD 推理）+ `vad.worklet.bundle.min.js`（MicVAD 以 AudioWorklet 模式运行时经 `appasset://voice/vad.worklet.bundle.min.js` addModule 加载的模块，独立 webpack bundle，自包含）。若漏掉 worklet 文件，打包后语音会报「语音引擎初始化失败：Unable to load a worklet's module」（dev 下 node_modules 完整不报，打包产物才暴露）。
- 添加/调整这些规则时，务必用第 4 节的验证命令核对白名单文件仍存在。

---

## 3. 本次修复记录的坑（2026-09）

以下问题曾导致「开发正常、打包产物 / 解析特定文件时报错」，均已修复，记录原因与处置：

### 3.1 `Cannot find module '@mixmark-io/domino'`

- **现象**：read_file 解析 HTML/文档时主进程报 `Cannot find module '@mixmark-io/domino'`。
- **原因**：`mdize`（devDependencies）被 Rollup 打进 bundle，但其传递依赖 `turndown` 对 `@mixmark-io/domino` 的 `require` 未被静态打包，以运行时 `require('@mixmark-io/domino')` 留在 bundle 里。pnpm 隔离布局下该包是**传递依赖**，顶层 `node_modules/@mixmark-io` 无符号链接，从 `out/main/` 解析不到。
- **为什么开发模式不报**：dev 下主进程依赖直接从 node_modules 解析，Node 能沿 pnpm 嵌套布局找到 domino；只有构建产物路径才踩坑。
- **处置**：`@mixmark-io/domino` 显式加入 `dependencies`（与 turndown 锁定的 2.2.0 一致），pnpm 建立顶层符号链接、electron-builder 收集进产物。

### 3.2 `DOMMatrix is not defined`

- **现象**：read_file 解析 **PDF** 时主进程报 `DOMMatrix is not defined`。
- **原因**：`mdize` 解析 PDF 依赖 `pdfjs-dist`，其在 Node 主进程环境里于模块作用域 `new DOMMatrix()`（浏览器几何 API，Node 无此全局）；pdfjs 自带的 polyfill 依赖 node-canvas（未安装），故直接抛错。dev / 打包都会触发，只取决于是否解析 PDF。
- **处置**：`src/main/index.ts` 启动时注入 `@thednp/dommatrix`（保持其在 devDependencies，由 Rollup 打进 bundle，不占产物 node_modules）：

  ```ts
  import DOMMatrixPolyfill from '@thednp/dommatrix'
  if (!('DOMMatrix' in globalThis)) {
    ;(globalThis as Record<string, unknown>).DOMMatrix = DOMMatrixPolyfill
  }
  ```

> 经验：**凡是在 bundle 外遗留运行时 `require` 的传递依赖，必须显式放进 `dependencies`**（否则 dev 正常、打包产物报 Module not found）。排查手段：构建后对 `out/main/*.js` 搜 `require("` 的外部包名，逐个确认可在产物 node_modules 解析。

---

## 4. 验证方法

### 4.1 打包 unpacked 产物

```bash
npm run build && npx electron-builder --dir
```

### 4.2 核对 asar 内依赖

```bash
APP="dist/mac-arm64/桌面助手.app/Contents/Resources/app.asar"
# 顶层 node_modules 包名清单
npx asar list "$APP" | grep -E "^/node_modules/[^/]+$" | sort
# 检查某包是否在产物里
npx asar list "$APP" | grep -q "^/node_modules/<包名>" && echo "在产物中" || echo "未打包"
# 检查白名单资源是否齐全
npx asar list "$APP" | grep "onnxruntime-web/dist"     # 应恰好 5 个文件 + 1 目录
npx asar list "$APP" | grep "vad-web/dist"             # 应恰好 2 个模型 + 1 目录
# 类型包泄漏检查（应为 0）
npx asar list "$APP" | grep -cE "@types|undici-types"
```

---

## 5. 产物依赖清单（验证结果）

以下为 2026-09 实测 `app.asar` 的 node_modules 状态：

**直接依赖（dependencies）**：`@electron-toolkit/preload`、`@electron-toolkit/utils`、`@mixmark-io/domino`、`@modelcontextprotocol/sdk`、`@ricky0123/vad-web`（仅模型）、`adm-zip`、`electron-ipc-service`、`electron-log`、`onnxruntime-web`（仅 5 个文件）、`picomatch`

**运行必需的传递依赖**：`express` 全家桶、`@hono/node-server`/`hono`、`protobufjs` 系、`eventsource`/`eventsource-parser`、`zod` 系、`cross-spawn`、`jose`、`debug`、`onnxruntime-common` 等（均为主进程运行时实际 require 的包）

**明确排除**：`vue`、`naive-ui`、`mdize`、`pdfjs-dist`、`turndown`、`vite`、`electron-vite`、`rollup`、`typescript`、`echarts`、`pinia`、`@thednp/dommatrix`、`@types/*`、`undici-types` —— 全部为 devDependencies（已打进 out bundle）或纯类型包，产物 node_modules 中无一残留

---

## 6. 新增依赖注意事项

1. **主进程运行时需要、且无法被打进 bundle 的包**（含其关键传递依赖）→ 放 `dependencies`，并确认 electron-builder 能收集（第 4 节验证）。
2. **渲染进程 / 纯类型 / 会被 Rollup 正常内联的包** → 放 `devDependencies`，避免膨胀产物 node_modules。
3. **修改 `files` 白名单**（onnxruntime-web / vad-web 等）→ 改完必须重新 `--dir` 打包并核对资源仍在，否则运行时 appasset:// 加载 404。
4. **pnpm 隔离布局**：传递依赖无顶层符号链接，dev 模式靠 Node 解析能工作，但**打包产物里只有 dependencies 及其传递依赖**——任何「dev 正常、打包报 Cannot find module」的问题，先查该包是否应进 dependencies。

---

## 7. 产物体积分析（2026-09，macOS arm64）

| 产物 | 大小 |
|---|---|
| `desktop-agent-1.1.0.dmg`（安装包） | 119M |
| `桌面助手-1.1.0-arm64-mac.zip`（增量更新） | 115M |
| unpacked 应用 `桌面助手.app` | 293M |
| ├─ `app.asar`（应用代码 + node_modules + 白名单资源） | 63M |
| └─ `Electron Framework.framework`（Electron 43 运行时） | 228M |

**结论**：

- 体积大头是 **Electron 运行时本身（228M，占 unpacked 的 78%）**，为框架固定成本，无法通过依赖管理裁剪。
- 应用自身内容 `app.asar` 仅 **63M**：其中 `out/` 构建产物（主进程 + 渲染 bundle）约 40M+，产物 node_modules（裁剪后的生产依赖 + 白名单资源）约 15M，`resources/` 少量。
- 依赖裁剪（onnxruntime-web 全量 133MB → 仅 5 个运行时文件；排除类型包）已在 asar 层面见效；若要继续压缩整体体积，方向是 Electron 运行时（换更小的发行版/二进制剥离）而非依赖层。

**体积自查命令**：

```bash
# 各产物大小
ls -lh dist/*.dmg dist/*.zip
# unpacked 内部构成
du -sh "dist/mac-arm64/桌面助手.app/Contents/Resources/app.asar"
du -sh "dist/mac-arm64/桌面助手.app/Contents/Frameworks/Electron Framework.framework"
```

---

## 8. 框架无法静态解析的包清单（bundle 外运行时 require）

Rollup 打包时若无法把某包的 `require` 静态内联（包用了动态/条件 require、或无法 CJS→ESM 转换等），会在 bundle 里**保留为运行时 `require("pkg")`**。这类包必须能在运行时（打包后的 `app.asar/node_modules`）解析到，否则 dev 正常、打包后对应功能报 `Cannot find module`。

### 8.1 扫描方法

```bash
# 列出 out/main + out/preload 中所有非 Node 内置的运行时 require 模块（去重）
grep -ohE 'require\(["'"'"'][^"'"'"']+["'"'"']\)' out/main/*.js out/preload/*.js \
  | sed -E 's/require\(["'"'"']([^"'"'"']+)["'"'"']\)/\1/' | sort -u \
  | grep -vE '^(node:|fs|path|stream|buffer|events|util|url|http|https|zlib|os|net|tls|crypto|child_process|assert|querystring|string_decoder|module|worker_threads|perf_hooks|async_hooks|diagnostics_channel|timers|dns|console|sqlite)$' \
  | grep -vE '^\./|^/'
# 对每个结果核对是否在产物 node_modules（应存在）
npx asar list "dist/mac-arm64/桌面助手.app/Contents/Resources/app.asar" | grep -E "^/node_modules/<pkg>"
```

### 8.2 清单（2026-09 实测）

**A. 运行时需解析、已随 `dependencies` 进入产物（正常）**

| 包 | bundle 位置 | 说明 |
|---|---|---|
| `@electron-toolkit/preload` | out/preload | preload 运行时 |
| `@electron-toolkit/utils` | out/main | 主进程工具 |
| `@modelcontextprotocol/sdk/client/{index,stdio,streamableHttp}` | out/main | MCP SDK 子路径 |
| `adm-zip` | out/main | 附件/解压 |
| `electron` | out/main | Electron 运行时自身提供 |
| `electron-ipc-service`、`electron-ipc-service/preload` | out/main + out/preload | IPC 基础设施 |
| `electron-log/main` | out/main | 日志 |
| `picomatch` | out/main | 路径匹配 |
| `@mixmark-io/domino` | out/main | 见 §3.1，已修复进 dependencies |

**B. 运行时需解析、但**不在 `dependencies`**（潜在打包后报错）**

| 包 | bundle 位置 | 来源链 | 触发路径 | 处置 |
|---|---|---|---|---|
| `google-auth-library` | `google-shared-*.js`（pi-ai Google provider 共享块） | pi-ai → @google/genai → google-auth-library | 配置/调用 Google（Gemini）模型，走 OAuth/服务账号认证 | 未修复：建议按 domino 同法加入 `dependencies`；若 Google 模型不作为发布功能，可忽略 |
| `encoding` | `index-*.js` | pi-ai → @google/genai → google-auth-library → gaxios → encoding | gaxios 响应解码（与上同路径） | 同上 |

> 注：`google-auth-library`/`encoding` 均来自 devDependencies（pi-ai）被打包后其内部无法内联的传递依赖。dev 下经 pnpm 嵌套布局可解析，打包产物中没有 → 属**潜在**问题，仅在触发对应路径时报错，未触发不影响现有功能。

**C. 已确认无需产物的包**：`vue`/`naive-ui`/`mdize`/`pdfjs-dist`/`turndown`/`@thednp/dommatrix` 等 devDependencies —— 已被 Rollup 完全内联进 bundle，无运行时 require。

### 8.3 处理规则

新增依赖时，对 §8.1 扫描结果逐个分类：

1. **在 `dependencies` 里** → 已进产物，正常。
2. **不在 `dependencies`、但 bundle 里有它的运行时 `require`** → 必须加入 `dependencies`（否则打包后对应功能报 Module not found）。
3. **bundle 里没有它的 require**（被内联）→ 保持 devDependencies，不占产物。

