# Flux Reader for Windows

Windows 桌面端使用 Tauri 2 + WebView2，渲染层直接复用
`packages/reader-web/src/App.jsx`。Rust 进程只承载原生窗口、用户选择器和本地文件
IPC，不启动 HTTP 服务，也不上传遥测或文稿正文。

## 开发

需要 Windows 10/11、WebView2、Rust stable、Node.js 20+ 与 Tauri CLI 2：

```powershell
cd apps/windows
cargo tauri dev
```

仅构建复用的 React 渲染层：

```powershell
npm --prefix ../../packages/reader-web run build:windows
```

生产构建：

```powershell
cd apps/windows
cargo tauri build
```

生产构建仅生成 NSIS EXE 安装程序，产物位于
`src-tauri/target/release/bundle/nsis/`。正式 GitHub Release 会将其统一命名为
`flux-reader-<version>-windows-x64.exe`；不生成或发布 MSI。

当前实现包括原生选择器、目录树、全文搜索、工作区状态，以及按
`contracts/safe-save/v1` 执行的原子保存与显式恢复 sidecar 生命周期。本地图片通过
`flux-reader-resource` 自定义协议读取；文件变化由 `notify` 的原生 Windows
`ReadDirectoryChangesW` 后端推送到发起授权的 WebView，不启动 fnOS 的 15 秒轮询。

恢复 sidecar 与用户文稿位于同一目录，只能通过 UI 的明确恢复/清理操作删除；IPC 和
日志只暴露不透明 recovery ID，不返回 sidecar 的真实路径。Windows 专用的
`ReplaceFileW`、WebView2 协议映射、原生监听与安装包仍应在 Windows CI/实机验证。
