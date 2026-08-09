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
