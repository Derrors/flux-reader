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
远程连接与脚本。Markdown 相对图片由 macOS bridge 改写为带文稿令牌的
`flux-reader-resource://` URL，再由原生端仅从当前授权工作区读取；fnOS 未提供该
resolver，因此不会意外暴露服务器本地路径。
