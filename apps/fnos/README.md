# Flux Reader for fnOS

fnOS 平台实现由两部分组成：

- `backend/`：Express 服务、fnOS OpenAPI 适配和文件访问安全边界
- `package/`：`fnpack` 所需的 manifest、生命周期脚本、权限与 UI 配置

共享的 React 阅读器位于 `../../packages/reader-web`，不在平台目录中复制。

## 当前能力

- 直接打开 `.md`、`.markdown`、`.mdx`，或同时浏览最多 8 个会话级工作区
- 跨已打开工作区搜索文件名与正文，文件名结果优先并显示正文摘要
- 按当前 fnOS 用户隔离最多 12 条最近文稿；展示前通过轻量元数据接口重新鉴权
- 顺序轮询工作区 revision 与当前文稿，自动更新目录树、正文和本地图片
- 安全加载文稿相对图片，支持工作区根路径与上级相对路径
- GFM、KaTeX、Mermaid、Shiki、文档目录、代码复制与深浅主题

搜索、轮询和图片接口不会绕过现有文件访问层：每个真实目标仍需同时通过应用共享
授权、当前用户 ACL、稳定文件描述符和打开后的 inode/范围复验。递归扫描最多 10000
个条目和 20 层；正文搜索最多读取 1000 个文件、64 MB，图片上限为 25 MB。

从仓库根目录运行：

```bash
npm run dev:fnos
npm run test:fnos
npm run build:fnos
npm run pack:fnos
```

`package/app/server/` 和 `.fpk` 文件是生成物，不提交到 Git。
