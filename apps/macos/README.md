# Flux Reader for macOS

这里是 Flux Reader 原生 macOS 客户端的应用目录。目前 monorepo 的平台边界已经
建立，SwiftUI / AppKit 工程将在这里实现。

## 计划架构

- SwiftUI + AppKit：窗口、菜单、目录树、文件选择和系统集成
- WKWebView：加载 `packages/reader-web` 的本地构建产物
- Swift 文件服务：读取用户授权的文件和目录
- Security-scoped bookmarks：在 App Sandbox 中持久保存目录授权

开始实现前，需要把 `packages/reader-web` 中现有的 fnOS API / SDK 调用抽象为平台
bridge。macOS 端由 Swift 注入 bridge，Markdown 渲染核心保持共享。

计划中的目录布局：

```text
apps/macos/
├── FluxReader.xcodeproj
├── FluxReader/
│   ├── App/
│   ├── Features/
│   ├── Services/
│   └── Resources/Reader/   # packages/reader-web 的构建产物
└── FluxReaderTests/
```

macOS 客户端不应复制共享阅读器源码；平台无关的渲染改动统一提交到
`packages/reader-web`。
