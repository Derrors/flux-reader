# Flux Reader for macOS

这里是 Flux Reader 原生 macOS 客户端。应用外壳使用 SwiftUI / AppKit，正文通过
WKWebView 复用 monorepo 内的 React 阅读器，不依赖 Electron 或第三方 Swift 包。

## 当前能力

- 原生 SwiftUI 窗口、菜单与导航栏
- 使用系统文件选择器打开 `.md`、`.markdown`、`.mdx`
- 同时打开多个文件夹，在侧边栏按目录树浏览 Markdown 文稿
- 文件名优先的工作区全文搜索，最多返回 100 条结果
- 使用 FSEvents 递归监听工作区，内容变化后自动刷新索引和当前预览
- 支持 Finder 文件关联启动，以及文件或文件夹拖放打开
- 最近文稿最多保留 12 项，可单项移除或清空
- 使用 security-scoped bookmarks 在重启后恢复最多 8 个文件夹与最近文稿授权
- App Sandbox 下的用户选择文件读写权限
- 原生 Markdown 编辑、原位保存与另存为；恢复版本另存为默认回到原文稿目录和文件名
- 文档内查找/替换，预览、编辑及左右分栏模式；分栏编辑器与 Web 预览同步滚动
- 最多 12 个文稿标签页、未保存标记，以及包含未保存草稿的安全会话恢复
- 未保存草稿的崩溃恢复，以及原文件被外部修改时的冲突提醒
- 原位保存保留被替换 inode 的恢复版本，防止其他进程通过旧文件句柄晚到写入时丢失内容
- 10 MiB 文件上限、普通文件检查和 UTF-8 校验
- GFM 表格、任务列表、KaTeX、Mermaid 与 Shiki 代码高亮
- 跟随系统深浅色主题，外部链接交给默认系统应用打开
- 原生剪贴板 bridge；Web 渲染器异常时自动降级到 `AttributedString`
- 自定义只读 URL scheme、严格 CSP 和非持久化 WebKit 数据存储
- 安全加载工作区内的相对路径图片，阻止目录穿越、符号链接逃逸与非图片资源
- 文件读取、文件夹索引、持久书签与渲染器资源边界单元测试
- XCUITest 覆盖启动、渲染、编辑保存、崩溃恢复、磁盘冲突和未保存切换/退出决策；完整 AppIcon 资源

## 编辑、保存与恢复

原位保存使用同目录替换事务，并把被替换的 inode 记录为恢复版本。每份文稿最多保留
5 个、全部文稿最多 50 个，总量最多 100 MiB。应用不会自动轮转或删除任何已保留版本。
达到任一配额时，保存会在创建替换文件和写入目标文稿前以 fail-closed 方式暂停；用户可
在左侧边栏查看恢复版本，待版本至少保留 24 小时后，点击垃圾桶并明确确认删除，再重试
保存。即使同一文稿已有更多更新版本，也不会绕过该最小保留期自动清理。

恢复版本删除采用持久化两阶段
状态：先把 manifest 标记为 `deleting`，再删除 sidecar，最后移除 manifest 记录；若进程
在中间退出，下一次启动或加载会继续对账，因此不会因“文件已删但记录仍在”永久阻断。

保存事务在创建 sidecar 前写入的 `pending` reservation 会被当前进程登记为 active，当前
进程的并发加载不会把它误判为崩溃残留；应用重启后，确实缺失 sidecar 的非 active
`pending` 才会被清理。打开恢复版本时只能阅读或另存为，保存面板默认使用原文稿所在
目录和可见文件名，并拒绝把目标指回 recovery sidecar 本身（包括符号链接别名）。

## 开发

要求 macOS 14+、支持 Swift 6 的 Xcode，以及 Node.js 20.19+。首次开发先安装共享
阅读器依赖：

```bash
npm run install:reader

open apps/macos/FluxReader.xcodeproj

npm run build:macos-renderer
npm run build:macos
npm run lint:macos
npm run test:macos
npm run test:macos-ui-build
npm run test:macos-ui
npm run pack:macos
```

Xcode 的 `Embed Shared Reader` 构建阶段会自动执行 `build:macos` 并把产物复制到
App Bundle 的 `Contents/Resources/Reader`，因此通常无需单独运行
`build:macos-renderer`；该命令主要用于只验证 Web 产物。

`test:macos-ui` 会启动真实应用，需要先在「系统设置 → 隐私与安全性 → 辅助功能」
允许执行测试的终端或 Xcode。发布 CI 会运行该真实 UI 套件；`test:macos-ui-build`
仅用于需要单独验证 UI 测试目标能否编译的场景。

`pack:macos` 默认构建 Intel + Apple Silicon Universal 应用，使用 ad-hoc 签名并在
`dist/release/` 生成文件名带 `unnotarized` 的 DMG。该产物没有 Developer ID
身份签名和 Apple 公证，只用于自用、测试或受控环境；Gatekeeper 警告属于预期。

### Developer ID 签名与公证

已安装 Developer ID Application 证书时，可以使用 App Store Connect API key 完成
正式分发构建：

```bash
MACOS_SIGNING_IDENTITY="Developer ID Application: Example (TEAMID)" \
APPLE_NOTARY_KEY_PATH="/secure/path/AuthKey_KEYID.p8" \
APPLE_NOTARY_KEY_ID="KEYID" \
APPLE_NOTARY_ISSUER_ID="ISSUER-UUID" \
npm run pack:macos
```

团队 API key 需要 `APPLE_NOTARY_ISSUER_ID`；Individual API key 可以省略它。脚本会
签名 `.app` 与 `.dmg`、等待 Apple 公证、装订并验证 ticket，再用 Gatekeeper 评估
产物。成功产物名为 `Flux-Reader-<version>-universal.dmg`。私钥与证书不得提交仓库。

GitHub 的 `Notarized macOS Release` 手动工作流使用以下 Actions secrets：

- `APPLE_DEVELOPER_ID_APPLICATION`：完整的 Developer ID Application identity
- `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`：`.p12` 文件的 Base64 内容
- `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD`：`.p12` 密码
- `APPLE_NOTARY_KEY_BASE64`：App Store Connect `.p8` 私钥的 Base64 内容
- `APPLE_NOTARY_KEY_ID`：API key ID
- `APPLE_NOTARY_ISSUER_ID`：团队 key 的 issuer UUID；Individual key 可留空

先等待标准 `Release` 工作流发布同版本 tag，再手动运行公证工作流。它不会覆盖已有
资产，而是把正式 DMG 与独立 `.sha256` 文件附加到同一 GitHub Release。

## 当前架构

- SwiftUI + AppKit：窗口、菜单、目录树、文件选择和系统集成
- WKWebView bridge：加载 `packages/reader-web` 的高级渲染产物并传递文稿、主题和剪贴板消息
- 原生 `AttributedString`：WebKit 或资源加载失败时的降级预览
- Swift 文件服务：在后台递归索引用户授权目录；跳过隐藏项、包和符号链接
- Security-scoped bookmarks：持久保存最多 8 个工作文件夹与最多 12 个最近文稿
- FSEvents + 搜索服务：防抖刷新多个目录，并在后台执行文件名和正文搜索

为保护性能，单次文件夹扫描最多遍历 10,000 个项目、最多深入 20 层。文件夹内容
变化会自动触发防抖重新索引，也可以点击侧边栏按钮手动刷新。相对图片只能读取已
授权工作区内的普通图片文件，单张上限 25 MB；越界路径和符号链接逃逸都会被拒绝。

目录布局：

```text
apps/macos/
├── FluxReader.xcodeproj
├── FluxReader/
│   ├── App/
│   ├── Features/Reader/
│   ├── Models/
│   ├── Services/
│   └── Resources/
├── FluxReaderTests/
└── FluxReaderUITests/
```

macOS 客户端不应复制共享阅读器源码；平台无关的渲染改动统一提交到
`packages/reader-web`。
