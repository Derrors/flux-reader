# Flux Reader for fnOS

fnOS 平台实现由两部分组成：

- `backend/`：Express 服务、fnOS OpenAPI 适配和文件访问安全边界
- `package/`：`fnpack` 所需的 manifest、生命周期脚本、权限与 UI 配置

共享的 React 阅读器位于 `../../packages/reader-web`，不在平台目录中复制。

从仓库根目录运行：

```bash
npm run dev:fnos
npm run test:fnos
npm run build:fnos
npm run pack:fnos
```

`package/app/server/` 和 `.fpk` 文件是生成物，不提交到 Git。
