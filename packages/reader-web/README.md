# @flux-reader/reader-web

Flux Reader 的 React / Vite 阅读器。Markdown 解析、净化、代码高亮、公式和 Mermaid
渲染集中在 `src/markdown/`，供不同平台复用。

当前应用入口仍通过 `src/api.js` 和 `src/trim-sdk.js` 对接 fnOS。接入 macOS 时应先把
文件选择、文件读取和窗口标题抽象为平台 bridge；渲染核心不应依赖具体宿主。

```bash
npm run dev
npm test
npm run build
```
