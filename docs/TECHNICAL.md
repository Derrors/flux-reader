# Flux Reader 技术与开发文档

本文面向 Flux Reader 的开发者与维护者，集中说明架构、开发环境、测试、打包发布、
权限模型与工程限制。产品能力、安装和日常使用请先阅读[项目 README](../README.md)。

## 目录

- [架构概览](#架构概览)
- [技术选型](#技术选型)
- [仓库结构](#仓库结构)
- [本地开发](#本地开发)
- [自动化测试](#自动化测试)
- [构建与打包](#构建与打包)
- [版本与 GitHub Release](#版本与-github-release)
- [fnOS 网关与权限模型](#fnos-网关与权限模型)
- [Windows Tauri 权限与 IPC](#windows-tauri-权限与-ipc)
- [编辑保存与恢复](#编辑保存与恢复)
- [性能保护](#性能保护)
- [常见问题](#常见问题)
- [已知工程限制](#已知工程限制)

## 架构概览

Flux Reader 是一个 Node.js + Swift + Rust 多语言 monorepo。平台无关的 Markdown 渲染器
由 React 实现：fnOS 使用完整 React App 与 Express 后端；Windows 使用同一个完整 React
App，并以 Tauri IPC 替换 HTTP transport；macOS 使用 SwiftUI 原生外壳并通过 WKWebView
复用渲染器。

| 平台 | 应用层 | 文件与系统集成 | Markdown 渲染 |
|---|---|---|---|
| fnOS | React / Vite | Express、fnOS OpenAPI、统一网关 | 共享 `reader-web` |
| Windows | React / Vite 完整 App | Tauri 2、Rust、WebView2 | 共享 `reader-web` |
| macOS | SwiftUI / AppKit | 原生文件服务、FSEvents、安全书签 | WKWebView 中的共享 `reader-web` |

Node 子项目分别保留 lockfile，根目录脚本负责统一调度。共享边界只覆盖 Markdown 语义、
渲染组件、跨平台保存结果契约和可复用状态机；窗口、授权、文件系统、菜单、恢复存储与
平台 UI 由各客户端自行组合。平台能力通过版本化 `/env` 契约注入，而不是在共享组件中
根据 User-Agent 或平台名称猜测。

### 架构原则

1. **共享能力，不共享宿主体验**：`reader-web` 提供渲染内核和 Web 工作流，但 macOS 保持
   SwiftUI/AppKit 优先；fnOS 与 Windows 也通过各自组合入口注入平台文案和能力。
2. **Capability 驱动**：宿主通过 `capabilitySchemaVersion`、`capabilities` 和 `policy` 声明
   安全保存、文件监听、授权周期、文档大小与工作区/标签上限。
3. **平台独立发布**：三个版本源、Tag 和 Release 互不绑定；共享改动只在 CI 中扇出验证，
   不强迫所有平台同时发版。
4. **契约优先**：保存结果、渲染 corpus、transport 形状先形成契约，再由各平台实现。

## 技术选型

| 环节 | 选型 | 说明 |
|---|---|---|
| 解析 | marked 18 | 原生支持 GFM 表格、任务列表与删除线 |
| HTML → React | html-react-parser 6 | 在 React 层替换代码、公式、图表和资源节点 |
| 公式 | KaTeX 0.18 | 使用 `output: mathml`、`trust: false` |
| 图表 | Mermaid 11 | 深浅双主题，懒加载，可导出 SVG |
| 代码高亮 | Shiki 4 + Web Worker | 先显示纯文本，再异步回填高亮 |
| HTML 净化 | DOMPurify 3 | 浏览器渲染默认开启 |
| fnOS 服务 | Express 5 | Unix Socket / 本地端口双模式 |
| Windows 外壳 | Tauri 2 + Rust + WebView2 | 原生窗口、菜单、dialog 与白名单 IPC |
| macOS 外壳 | SwiftUI + AppKit | 原生窗口、菜单、编辑器和系统文件能力 |

选择 marked + html-react-parser，而不是 react-markdown，是因为代码块、Mermaid、KaTeX、
本地资源和平台 bridge 都需要定制节点。当前方案可以直接在 React 层替换节点，不必为每类
能力维护额外的 rehype 插件。

## 仓库结构

```text
flux-reader/
├── apps/
│   ├── fnos/
│   │   ├── backend/                    Express 服务与 fnOS OpenAPI 适配
│   │   │   └── src/
│   │   │       ├── server.js           HTTP / Unix Socket 监听和 API
│   │   │       ├── trim-api.js         fnOS OpenAPI 客户端
│   │   │       └── file-access.js      文件访问、保存与恢复安全边界
│   │   └── package/                    fnpack 应用包目录
│   │       ├── manifest                应用元数据与统一网关配置
│   │       ├── config/                 权限与 OpenAPI scopes
│   │       └── cmd/main                生命周期脚本
│   ├── macos/
│   │   ├── FluxReader.xcodeproj        Xcode 工程
│   │   ├── FluxReader/                 SwiftUI / AppKit / WebKit bridge 源码
│   │   ├── FluxReaderTests/            原生单元测试
│   │   └── FluxReaderUITests/          XCUITest UI 回归
│   └── windows/
│       ├── README.md                   Windows 开发与平台能力说明
│       └── src-tauri/
│           ├── tauri.conf.json         WebView2 窗口、CSP 与打包配置
│           └── src/                    IPC、授权表与 Rust 文件服务
├── packages/
│   └── reader-web/                     Vite + React 共享阅读器
│       └── src/
│           ├── markdown/               Markdown 渲染核心
│           ├── components/             标签页、查找、目录与工作区组件
│           ├── apps/                    fnOS / Windows 组合入口
│           ├── windows-main.jsx         Windows Bootstrap
│           ├── platform/                capability、策略、HTTP / Tauri transport
│           ├── macos-main.jsx          macOS 独立渲染入口
│           └── macos/                  原生 payload bridge
├── scripts/                            构建、版本同步与发布测试
├── versions/                           fnos / macos / windows 独立版本源
└── package.json                        monorepo 调度脚本
```

平台专属细节分别见：

- [fnOS 平台说明](../apps/fnos/README.md)
- [Windows 平台说明](../apps/windows/README.md)
- [macOS 平台说明](../apps/macos/README.md)
- [共享 Web 阅读器说明](../packages/reader-web/README.md)

## 本地开发

### 环境要求

- Node.js 20.19 或更高版本；CI 使用 Node.js 22
- npm
- macOS 客户端开发需要 macOS 14+ 与支持 Swift 6 的 Xcode
- Windows 客户端开发需要 Windows 10/11、WebView2、Rust stable 与 Tauri CLI 2
- fnOS 打包需要飞牛官方 `fnpack`

### 安装依赖

```bash
npm run install:all
```

也可以只安装某一部分：

```bash
npm run install:fnos
npm run install:reader
```

### 启动开发环境

```bash
npm run dev              # 共享阅读器 :5177，并自动拉起 fnOS 后端 :5178
npm run dev:backend      # 仅启动 fnOS 后端
npm run dev:reader       # 仅启动共享阅读器
```

浏览器访问 <http://127.0.0.1:5177/app/flux-reader/>。

本地开发仍使用生产路径前缀 `/app/flux-reader`，用于提前验证统一网关下的路由行为。
没有 fnOS 宿主时，真实文件接口会返回 `LOCAL_DEV_NO_GATEWAY`；Markdown 渲染与前端状态
可以通过自动化测试或渲染示例验证。

macOS 开发：

```bash
open apps/macos/FluxReader.xcodeproj
npm run build:macos-renderer
npm run build:macos
```

Xcode 的 `Embed Shared Reader` 构建阶段会自动生成并嵌入 `reader-web` 的 macOS 产物。

Windows 开发（必须在安装 Rust 工具链的 Windows 环境执行原生编译）：

```powershell
cd apps/windows
cargo tauri dev
```

`tauri.conf.json` 的开发命令会启动 `vite --mode windows`；生产产物从
`packages/reader-web/dist-windows/windows.html` 加载。`withGlobalTauri` 只用于统一
transport 的 `core.invoke`；文件变化只开放当前 `WebviewWindow.listen`，capability 不向
WebView 暴露通用文件系统或 dialog 权限。

## 自动化测试

```bash
npm test                              # 发布脚本 + fnOS 后端 + reader-web
npm run test:fnos                     # fnOS 后端安全与 API 测试
npm run test:reader                   # React / 渲染 / 状态测试
npm run build:windows-renderer        # 验证 Windows 完整 React App 产物
npm run test:render-contract          # 两个真实构建入口的 Chromium 契约
npm run lint:macos                    # Swift 格式检查
npm run test:macos                    # macOS 原生单元测试
npm run test:macos-ui-build           # 只编译 macOS UI 测试目标
npm run test:macos-ui                 # 运行真实 XCUITest
npm run test:all                      # 版本校验及当前机器支持的完整测试
npm --prefix packages/reader-web run test:watch
```

`test:macos-ui` 会启动真实应用，需要先在「系统设置 → 隐私与安全性 → 辅助功能」中允许
执行测试的终端或 Xcode。若测试在 `Timed out while enabling automation mode` 阶段失败，
表示 XCTest 没有成功启用宿主自动化模式，测试用例尚未开始执行。

前端使用 Vitest、jsdom 与 Testing Library，覆盖文件选择、工作区、标签页、查找替换、
分栏滚动同步、会话恢复、权限回程、保存冲突、latest-wins 竞态、API 编码和 Markdown
安全渲染。fnOS 后端测试覆盖路径范围、ACL、稳定文件描述符、保存事务、恢复记录、配额、
请求取消与优雅退出。macOS 另有 Swift 单元测试及真实 XCUITest。

Windows Rust 模块内含授权隔离、符号链接逃逸、UTF-8/大小限制、搜索返回形状、IPC 白名单、
跨 WebView 取消隔离、图片协议、文件监听过滤及 safe-save 共享契约测试；在 Windows 或配置
Rust 的 CI 中运行 `cargo test --manifest-path apps/windows/src-tauri/Cargo.toml`。

共享 Markdown corpus 位于 `packages/reader-web/test/fixtures/render-contract/`。快速测试、
fnOS contract 构建、macOS contract 构建、Chromium 和真实 WKWebView 均读取同一份
`manifest.json`；KaTeX 断言 MathML，Mermaid 与 Shiki 使用显式完成状态，不依赖固定 sleep。

GitHub Actions 由中央 `CI` 先计算受影响项目，再调用三个可复用质量工作流：

- 共享阅读器、保存契约或全局构建脚本变化：扇出 fnOS、macOS、Windows。
- `apps/<platform>`、`versions/<platform>` 或平台构建脚本变化：只验证对应平台。
- 纯文档变化：不消耗平台 runner。

三个 `Release <platform>` 工作流均只允许从 `main` 手动触发，并先复用对应质量门禁。
`Notarized macOS Release` 仍是独立的 Apple Developer ID 签名与公证流程。

## 构建与打包

```bash
npm run version:check                # 校验三个独立版本源与平台清单
npm run version:check:fnos           # 只校验 fnOS
npm run version:check:macos          # 只校验 macOS
npm run version:check:windows        # 只校验 Windows
npm run build:fnos                   # 生成 fnOS package/app
npm run build:macos-renderer         # 构建 WKWebView 共享阅读器
npm run build:windows-renderer       # 构建 WebView2 完整 React App
npm run pack:fnos                    # 构建 .fpk
npm run pack:macos                   # 构建 Universal .dmg
```

`fnpack` 是飞牛官方独立二进制，不是 npm 包。请按开发机架构从
[官方文档](https://developer.fnnas.com/docs/cli/fnpack) 下载。

fnOS 构建输出位于 `apps/fnos/package/app/`。不要把文件放进
`apps/fnos/package/target/`：fnpack 只会把 `app/` 压缩为 `app.tgz`，安装后才由系统
展开到 `/var/apps/{appname}/target/`。

`npm run pack:macos` 默认生成 Intel + Apple Silicon Universal 2 应用。没有配置 Apple
开发者凭据时使用 ad-hoc 签名，产物名包含 `unnotarized`，仅适合自用、测试或受控环境。
Developer ID 签名、公证需要的变量与 GitHub secrets 见
[macOS 平台说明](../apps/macos/README.md#developer-id-签名与公证)。

## 版本与 GitHub Release

`versions/fnos`、`versions/macos`、`versions/windows` 分别是三个发布版本的唯一来源。
准备某个平台的新版本时：

```bash
# 例如发布 macOS：修改 versions/macos 后
npm run version:sync:macos
# 编写 docs/releases/macos/<version>.md 中文更新摘要
npm run version:check:macos
npm run test:reader
npm run test:macos
```

代码合入 `main` 后，手动运行对应的 `Release <platform>` 工作流。它会：

1. 校验该平台版本、中文摘要、Tag 与 Release 状态。
2. 重新执行该平台完整质量门禁。
3. 只构建该平台资产并生成 `SHA256SUMS`。
4. 创建 `<platform>/v<version>` GitHub Release。

版本摘要必须存在、非空并包含中文；历史 `docs/releases/<version>.md` 保留作为旧统一版本
发布记录，新版本统一放在 `docs/releases/<platform>/<version>.md`。
发布正文不会调用 GitHub 的英文自动说明，而是保留维护者编写的中文概括，并统一追加下载
文件说明与未公证 macOS 构建警告。

工作流不会移动或覆盖已经发布的 tag。仓库 Actions 必须允许 `GITHUB_TOKEN` 使用
`contents: write` 才能创建 tag 和 Release。

## fnOS 网关与权限模型

### 统一网关

fnOS 服务监听 Unix Socket，由 `gatewayPrefix` 转发。网关负责校验登录态并注入
`x-trim-userid`，后端据此执行多用户隔离。项目没有采用每次请求启动进程的 CGI 模式，
因为常驻服务更适合流式读取、轮询和并发状态管理。

### 双层权限检查

任何文件访问都必须同时通过两层权限：

1. 管理员在 fnOS「应用设置 → 访问权限」中给应用账号配置共享目录；后端通过
   `getSharedAccessibleFolders` 获取范围。
2. 后端使用当前 `x-trim-userid` 调用 `checkUserACL`，确认当前登录用户对目标的权限。

网关只证明用户已登录，不代表用户有权读取任意文件。路径还会经过真实路径边界、防目录
穿越、稳定文件描述符、打开后 inode 和授权快照复验，防止检查与使用之间被替换。

Flux Reader 的文件和文件夹选择器只调用 `pickFile`，不会通过 `pickUserFile` 或
`pickSharedFile` 在应用内修改授权。授权目录只能在系统应用设置中维护。

相对图片、全文搜索和工作区 revision 复用相同权限边界。图片必须由已授权 Markdown
引用且仍位于允许范围，只接受受支持的位图格式；SVG、符号链接逃逸与路径穿越会被拒绝。

## Windows Tauri 权限与 IPC

Windows 沿用 fnOS 的“Web 即完整 App”形态，但 `api.js` 只依赖 transport：普通浏览器与
fnOS 使用 HTTP，检测到 `window.__TAURI__.core.invoke` 后自动使用 Tauri IPC。网页不能
传入 Rust 命令名；`reader_transport_request` 只分派固定的 method/path 组合，未知路径、
错误方法和未知路径均返回 `message/error/status` 结构化错误。

用户通过原生 dialog 明确选择文件或文件夹后，Rust 才把 canonical path 登记到当前
WebView 的内存授权表。文件授权只覆盖该文件；文件夹授权覆盖其真实子树。每次访问都会
重新 canonicalize，并使用 `Path` 组件前缀校验，目录树不跟随符号链接；指向授权根外的
链接、`..` 穿越、未授权兄弟路径和窗口间复用授权都会被拒绝。窗口销毁时同步撤销授权并
取消其活动任务。

平台能力由 `/env.capabilities` 表达，避免在 `App.jsx` 按平台名分叉：

| capability | fnOS | Windows | macOS |
|---|---:|---:|---:|
| 完整 Web App | 是 | 是 | 否，Web 仅承载共享渲染器 |
| `sessionScopedAuthorization` | 否 | 是，按 WebView 隔离 | 否，使用安全书签 |
| `workspaceSearch` | 是 | 是 | 由原生服务提供 |
| `requestCancellation` | HTTP 连接取消 | IPC request id | 由原生任务管理 |
| `safeSave` | 是 | 是，`atomicReplace` + sidecar | 是 |
| `localResources` | 是 | 是，自定义协议 | 是 |
| `fileWatching` | 轮询 | 是，`notify` 原生事件 | FSEvents |

Tauri capability 本身不授予 WebView 通用文件系统或 dialog plugin 权限；所有文件能力只
能经过上述应用命令。授权表、请求表和搜索缓冲都只驻留内存，不新增正文缓存或遥测。

## 编辑保存与恢复

### fnOS

- GET 文稿返回内容 revision；PUT 保存必须携带 `expectedRevision`，使用乐观并发控制。
- 当前用户 ACL 与应用账号访问能力都会重新检查。
- 为保留原 inode 上的 Windows ACL、owner 与扩展属性，保存采用可恢复的原 inode 写回。
- Flux Reader 自身对同 inode 的读写会串行，硬链接别名也使用相同事务门。
- 写入前在应用私有 0700 目录创建 0600 baseline、attempted 与持久 journal。
- mutation 开始后发生异常不会自动覆盖目标；UI 通过不透明 recovery ID 和最新 revision
  选择恢复版本，再由专用 commit API 完成恢复。
- 浏览器草稿按 fnOS uid 与规范路径隔离；服务端恢复记录不向浏览器暴露私有路径。
- 进程收到 SIGTERM / SIGINT 时会停止接收请求并等待活动保存安全收敛。
- 跨端可观察保存语义定义在 `contracts/safe-save/v1/`；HTTP 响应的 `saveOutcome`
  使用该契约，底层 inode 事务算法不受 adapter 影响。

fnOS 文件选择器只返回已存在的授权文件，因此当前只保存现有文件，不提供伪造的
「另存为」。需要新文件时，应先在文件管理器中创建。

### macOS

- App Sandbox 与 security-scoped bookmarks 控制长期文件访问。
- 保存使用同目录事务和 `RENAME_SWAP`；原 inode 作为可见恢复版本保留，不在保存事务中删除。
- 恢复版本有每文稿、全局条数与总字节上限，达到上限时 fail closed。
- 恢复版本至少保留 24 小时，只能由用户明确确认删除。
- 未保存草稿和最多 12 个标签页的会话记录保存在 Application Support 私有目录。
- 恢复版本以只读文稿打开，可以另存为，但不能原地编辑覆盖 recovery sidecar。
- 保存冲突、切换文稿、关闭标签页和退出应用均使用显式保存/放弃/取消决策。
- Web renderer 只有在当前 generation 回传 `contentDidPaint` 后才接管原生占位；
  WebContent 退出只重试一次，失败或 10 秒首帧超时后继续显示原生正文。

### Windows

- GET 文稿、目录、元数据、全文搜索与工作区 revision 映射为同形 IPC 响应。
- PUT 先校验正文、授权和 `expectedRevision`，在首次 pathname mutation 前把 baseline、
  attempted、replacement 与 manifest 同步到同目录 sidecar；Windows 发布使用
  `ReplaceFileW` 并保留 displaced 文件；macOS 测试路径使用 `RENAME_SWAP`，其余通用目标
  使用同目录原子 rename。
- 发布后的目标 identity、正文和 displaced baseline 会再次核验；无法证明最终状态时返回
  `recoveryRequired(commitState=unknown)`，不自动回滚或删除外部版本。
- 恢复引用只暴露 48 字符不透明 ID；GET/POST/DELETE 恢复端点分别列举、CAS 提交和执行
  用户明确清理。Windows capability 将恢复清理声明为 `explicit`，因此 committed sidecar
  也不会被 UI 隐式删除。
- `/file-state` 对超过 10 MiB 或非法 UTF-8 的当前目标仍提供流式正文摘要 revision；恢复
  写入会先保全当前版本，使用独立的 16 MiB 恢复基线上限，普通阅读/编辑上限仍为 10 MiB。
- Rust 契约 adapter 直接读取 `contracts/safe-save/v1/scenarios.json`，共享 13 个场景与拒绝
  原因 schema；恢复配额为每文稿 8 个事务、320 MiB。capability 声明 30 天保留策略，当前
  `automaticExpiry=false`，不会后台自动删除；只能由 UI 的显式恢复生命周期清理。
- `flux-reader-resource` 协议复用授权文稿/工作区边界，只读取签名匹配且不超过 25 MiB 的
  图片，响应为 `no-store`，错误正文不含本地路径。
- `notify` 对目录递归监听、对单文件父目录监听；Windows 后端使用
  `ReadDirectoryChangesW`。事件按 WebView 定向且只携带序号，恢复 sidecar 被过滤；
  `fileWatching=true` 时 React 复用刷新路径并停止 15 秒轮询。

## 性能保护

NAS 与桌面环境都设置了明确边界：

- Shiki 在 Web Worker 中运行；8 秒超时后保留纯文本。
- Worker 使用文稿 session 取消、进行中去重和 8 MiB 有界内存 LRU；视口外代码先显示纯文本。
- 代码超过 100,000 字符或单行超过 4,000 字符时跳过高亮。
- 普通可编辑文稿上限 10 MiB；本地图片上限 25 MiB。
- 最多 8 个工作区、12 个文稿标签页。
- 递归扫描最多 10,000 个条目、20 层目录。
- 搜索最多返回 100 条；fnOS 与 Windows 单次正文扫描最多 1,000 个文件、64 MiB。
- 最近文稿和轮询优先使用轻量元数据接口，不为探测变化下载正文。
- 页面隐藏、文件选择器或状态决策打开时暂停刷新，避免重叠请求覆盖新状态。
- Mermaid、KaTeX 与 Shiki 独立懒加载，降低普通文稿首屏成本。
- 正文 HTML 与 TOC 共享一次 marked token snapshot；查找活动项、主题和图片 revision
  不再触发完整 HTML→React 重建。
- fnOS 与 macOS 的分栏预览都以 120 ms latest-wins 合并连续输入，保存和退出分栏立即 flush。
- 浏览器支持时对顶层 block 启用 `content-visibility`；该优化不改变 DOM 数量，也不作为
  放宽 10 MiB 上限的依据。

渲染开关可在构建时独立关闭：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `VITE_FLUX_VIEWPORT_HIGHLIGHTING` | `true` | 代码块接近视口后再提交 Shiki |
| `VITE_FLUX_HIGHLIGHT_CACHE` | `true` | 启用有界内存高亮 LRU |
| `VITE_FLUX_CONTENT_VISIBILITY` | `true` | 启用受浏览器能力检测保护的 CSS 跳过 |
| `FLUX_READER_DISABLE_WEB_HANDOFF` | 未设置 | 设为 `1` 时关闭 macOS 原生/Web 淡入交接 |

Web 调试环境也可在入口执行前设置 `globalThis.__FLUX_READER_FEATURES__`，用布尔值覆盖前三项。
生产版不提供面向普通用户的复杂开关界面。完整块级虚拟化的当前决策与重新评审条件见
[`优化实施记录`](optimization-refactor-implementation.md#m6-gono-go-记录)。

## 常见问题

### `vite: command not found`

前端依赖没有安装完整。执行：

```bash
npm run install:all
```

### `npm ci` 或 `npm install` 返回 404

通常是当前 registry 尚未同步 lockfile 中的版本。可以切换到 npm 官方源：

```bash
npm run install:all --registry=https://registry.npmjs.org
```

lockfile 中的 `resolved` 域名不决定实际安装源；npm 会按本地 registry 配置请求固定版本。

### `.fpk` 体积很小或安装后无法启动

确认构建产物位于 `apps/fnos/package/app/`，并在该目录生成后再运行 `fnpack build`。
`target/` 不是 fnpack 的输入目录。

### macOS UI 测试无法启动

先确认运行 Xcode 或终端已获得辅助功能权限。如果失败发生在
`Timed out while enabling automation mode`，XCTest runner 尚未进入测试用例；可重新授权、
退出残留测试进程或重启测试宿主后再运行。

## 已知工程限制

- fnOS 需要 1.2.0401+ 的共享访问、用户 ACL 与路径 OpenAPI；其他系统版本应在安装后
  验证文件选择、目录访问和 ACL。
- Mermaid 分包体积较大，第一次打开包含图表的文稿会有额外加载时间。
- fnOS 为保留 inode 元数据采用可恢复原地写回。应用内读取有事务屏障，但 SMB 等外部
  进程可能在极短窗口观察到中间内容。
- macOS 标准自动 Release 的 DMG 未做 Developer ID 签名与 Apple 公证；正式分发应运行
  notarized workflow。
- Windows 专用的 `ReplaceFileW`、WebView2 自定义协议、`ReadDirectoryChangesW` 行为及
  NSIS EXE 安装包仍需 Windows CI/实机验证；macOS arm64 只能覆盖通用 Rust 代码与契约。
- 高级 macOS 渲染依赖 WKWebView；资源加载失败时会降级为原生 `AttributedString` 预览，
  部分交互能力不可用。

## 依赖许可

项目本身使用 [MIT License](../LICENSE)。主要渲染依赖许可：marked、Mermaid、KaTeX、
Shiki、html-react-parser 为 MIT；DOMPurify 为 Apache-2.0 / MPL-2.0 双许可。
