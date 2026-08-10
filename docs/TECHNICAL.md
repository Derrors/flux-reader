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
- [编辑保存与恢复](#编辑保存与恢复)
- [性能保护](#性能保护)
- [常见问题](#常见问题)
- [已知工程限制](#已知工程限制)

## 架构概览

Flux Reader 是一个 Node.js + Swift 多语言 monorepo。平台无关的 Markdown 渲染器由
React 实现，fnOS 使用 React 应用与 Express 后端，macOS 使用 SwiftUI 原生外壳并通过
WKWebView 复用同一渲染器。

| 平台 | 应用层 | 文件与系统集成 | Markdown 渲染 |
|---|---|---|---|
| fnOS | React / Vite | Express、fnOS OpenAPI、统一网关 | 共享 `reader-web` |
| macOS | SwiftUI / AppKit | 原生文件服务、FSEvents、安全书签 | WKWebView 中的共享 `reader-web` |

Node 子项目分别保留 lockfile，根目录脚本负责统一调度。这样既能共享渲染、编辑和组件，
又不会破坏 fnOS 独立安装生产依赖及 Xcode 嵌入 Web 产物的流程。

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
│   └── macos/
│       ├── FluxReader.xcodeproj        Xcode 工程
│       ├── FluxReader/                 SwiftUI / AppKit / WebKit bridge 源码
│       ├── FluxReaderTests/            原生单元测试
│       └── FluxReaderUITests/          XCUITest UI 回归
├── packages/
│   └── reader-web/                     Vite + React 共享阅读器
│       └── src/
│           ├── markdown/               Markdown 渲染核心
│           ├── components/             标签页、查找、目录与工作区组件
│           ├── macos-main.jsx          macOS 独立渲染入口
│           └── macos/                  原生 payload bridge
├── scripts/                            构建、版本同步与发布测试
├── VERSION                             发布版本唯一来源
└── package.json                        monorepo 调度脚本
```

平台专属细节分别见：

- [fnOS 平台说明](../apps/fnos/README.md)
- [macOS 平台说明](../apps/macos/README.md)
- [共享 Web 阅读器说明](../packages/reader-web/README.md)

## 本地开发

### 环境要求

- Node.js 20.19 或更高版本；CI 使用 Node.js 22
- npm
- macOS 客户端开发需要 macOS 14+ 与支持 Swift 6 的 Xcode
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

## 自动化测试

```bash
npm test                              # 发布脚本 + fnOS 后端 + reader-web
npm run test:fnos                     # fnOS 后端安全与 API 测试
npm run test:reader                   # React / 渲染 / 状态测试
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

GitHub Actions 分为：

- `fnOS CI`：Ubuntu + Node.js 22，执行版本校验、全部 Node 测试和 fnOS 生产构建。
- `macOS CI`：macOS 26，执行共享阅读器测试、Swift lint、原生测试与 UI 自动化。
- `Release`：在 `main` 上构建 `.fpk` 与未公证 Universal `.dmg` 并创建 Release。
- `Notarized macOS Release`：配置 Apple 凭据后手动构建签名、公证的 DMG。

## 构建与打包

```bash
npm run version:check                # 校验各平台版本一致
npm run build:fnos                   # 生成 fnOS package/app
npm run build:macos-renderer         # 构建 WKWebView 共享阅读器
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

根目录 `VERSION` 是 fnOS manifest 与 macOS `MARKETING_VERSION` 的唯一版本来源。
准备新版本时：

```bash
# 修改 VERSION 后
npm run version:sync
npm run test:all
```

代码合入 `main` 后，`Release` 工作流会：

1. 校验版本与 tag 状态。
2. 并行构建 `flux-reader-<version>.fpk` 和
   `Flux-Reader-<version>-unnotarized-universal.dmg`。
3. 生成 `SHA256SUMS`。
4. 创建 `v<version>` GitHub Release。

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

## 性能保护

NAS 与桌面环境都设置了明确边界：

- Shiki 在 Web Worker 中运行；8 秒超时后保留纯文本。
- 代码超过 50,000 字符或单行超过 2,000 字符时跳过高亮。
- 普通可编辑文稿上限 2 MB；本地图片上限 25 MB。
- 最多 8 个工作区、12 个文稿标签页。
- 递归扫描最多 10,000 个条目、20 层目录。
- 搜索最多返回 100 条；fnOS 单次正文扫描最多 1,000 个文件、64 MB。
- 最近文稿和轮询优先使用轻量元数据接口，不为探测变化下载正文。
- 页面隐藏、文件选择器或状态决策打开时暂停刷新，避免重叠请求覆盖新状态。
- Mermaid、KaTeX 与 Shiki 独立懒加载，降低普通文稿首屏成本。

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
- 高级 macOS 渲染依赖 WKWebView；资源加载失败时会降级为原生 `AttributedString` 预览，
  部分交互能力不可用。

## 依赖许可

项目本身使用 [MIT License](../LICENSE)。主要渲染依赖许可：marked、Mermaid、KaTeX、
Shiki、html-react-parser 为 MIT；DOMPurify 为 Apache-2.0 / MPL-2.0 双许可。
