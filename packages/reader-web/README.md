# @flux-reader/reader-web

Flux Reader 的 React / Vite 阅读器。Markdown 解析、净化、代码高亮、公式和 Mermaid
渲染集中在 `src/markdown/`，供不同平台复用。

fnOS 入口通过 `src/api.js` 和 `src/trim-sdk.js` 对接统一网关；macOS 入口为
`macos.html` / `src/macos-main.jsx`，只接收 Swift 注入的文稿、标题与主题，不包含
fnOS API。两端共同复用 `MarkdownView` 和 `src/markdown/` 渲染管线。

```bash
npm run dev
npm test
npm run build
npm run build:macos
```

`build:macos` 使用相对资源路径输出到忽略提交的 `dist-macos/`。Xcode 构建会把该目录
嵌入 App Bundle，再由受限的 `flux-reader://app/` scheme 加载；页面自身的 CSP 禁止
远程连接与脚本。Markdown 相对图片由平台 resolver 接管：macOS bridge 将其改写为
带文稿令牌的 `flux-reader-resource://` URL；fnOS 则生成绑定当前文稿与可选工作区的
同源 `/api/resource` URL。两端最终都只从已授权资源根读取安全位图，不把服务器本地
路径直接交给 Web 渲染器。

fnOS 入口支持编辑/预览切换和 `⌘/Ctrl+S` 原文件保存。保存使用文件 revision 做
compare-and-swap，检测到外部修改时必须由用户选择重新加载或保留草稿；轮询不会覆盖
未保存内容。未保存草稿按 fnOS uid 与后端规范路径隔离并节流写入浏览器本地存储，
用于页面意外关闭后的恢复。后端保存事务还会在应用私有目录保留不透明的恢复日志；若
服务中断或磁盘并发写入导致保存无法确认，重新打开文稿时可选择保存前版本或待保存版本，
恢复时先读取当前 revision，再由服务端专用 commit 接口直接提交不透明恢复版本；恢复正文
不会经过浏览器 JSON，也不会绕过路径、权限、inode 与 revision 校验。恢复后的磁盘正文
若仍超过阅读上限或不是有效 UTF-8，本地草稿会继续保留，并以 commit 返回的新 revision
恢复编辑和保存。恢复记录对应的 inode 已被替换时，前端只允许清理记录，不能读取旧正文。
fnOS 文件选择器目前只返回已有授权文件，因此不提供伪造的“另存为”；需要新文件时请先
在文件管理器中创建，再用 Flux Reader 打开编辑。
