<p align="center">
  <img src="apps/fnos/package/ICON_256.PNG" width="128" height="128" alt="Flux Reader 图标">
</p>

<h1 align="center">Flux Reader</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  为 fnOS 与 macOS 打造的本地优先 Markdown 阅读与编辑器。
  <br>
  从快速阅读，到多文档编辑、查找替换与安全恢复，都在一个干净的工作空间里完成。
</p>

<p align="center">
  <a href="https://github.com/Derrors/flux-reader/actions/workflows/fnos.yml"><img src="https://github.com/Derrors/flux-reader/actions/workflows/fnos.yml/badge.svg" alt="fnOS CI"></a>
  <a href="https://github.com/Derrors/flux-reader/actions/workflows/macos.yml"><img src="https://github.com/Derrors/flux-reader/actions/workflows/macos.yml/badge.svg" alt="macOS CI"></a>
  <a href="https://github.com/Derrors/flux-reader/releases/latest"><img src="https://img.shields.io/github/v/release/Derrors/flux-reader?display_name=tag&sort=semver" alt="Latest Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

## 一款真正适合日常使用的 Markdown 工具

Flux Reader 不只是渲染 Markdown。它可以管理文件夹、搜索文稿、并排编辑与预览，
也会在多标签页、应用重启或保存冲突时保护你的工作进度。

- **舒服地阅读**：GFM 表格、任务列表、代码高亮、KaTeX 公式、Mermaid 图表和文档目录。
- **专注地编辑**：预览、编辑、左右分栏三种视图，编辑区与预览区同步滚动。
- **高效地查找**：文档内查找与替换，支持上一个、下一个、单次替换和全部替换。
- **同时处理多份文稿**：最多 12 个标签页，清楚显示未保存状态并恢复上次会话。
- **管理你的知识目录**：打开多个工作区，浏览目录树，按文件名与正文全文搜索。
- **保护每一次修改**：草稿恢复、外部修改检测、安全保存和可选择的恢复版本。
- **适应你的环境**：浅色、深色与系统外观，fnOS 和 macOS 共享一致的渲染体验。

## 平台支持

| | fnOS | macOS |
|---|---|---|
| 应用形态 | 原生 fnOS 应用包 | SwiftUI 原生应用 |
| 打开方式 | 文件、文件夹、文件关联 | 文件、文件夹、Finder 关联、拖放 |
| 工作区 | 最多 8 个会话工作区 | 最多 8 个持久工作区 |
| 文稿标签 | 最多 12 个，可恢复会话 | 最多 12 个，可恢复会话与草稿 |
| 编辑与保存 | 保存已授权的现有文件 | 原位保存与另存为 |
| 文件变化 | 自动轮询更新 | FSEvents 自动更新 |
| 访问控制 | fnOS 应用授权 + 当前用户 ACL | App Sandbox + Security-scoped bookmarks |

支持 `.md`、`.markdown` 和 `.mdx` 文件；单份可编辑文稿上限为 2 MB，文本编码需要为 UTF-8。

## 安装

前往 [GitHub Releases](https://github.com/Derrors/flux-reader/releases/latest) 下载最新版本。

### fnOS

1. 下载 `flux-reader-<version>.fpk`。
2. 在 fnOS 应用中心选择离线安装。
3. 在「系统设置 → 应用 → Flux Reader → 应用设置 → 访问权限」中添加允许访问的目录。
4. 从桌面打开 Flux Reader，选择文件或文件夹开始使用。

系统要求：**fnOS 1.2.0401 或更高版本**，飞牛 App 1.34.0 或更高版本。

### macOS

1. 下载 `Flux-Reader-<version>-universal.dmg`；若当前 Release 只有名称中带
   `unnotarized` 的构建，也可以用于自用和测试。
2. 打开 DMG，将 Flux Reader 拖入 Applications。
3. 首次打开文件或文件夹时，由系统选择器授予访问权限。

macOS 客户端要求 **macOS 14 或更高版本**，同时支持 Apple Silicon 与 Intel Mac。
未公证构建可能被 Gatekeeper 警告或阻止；正式公证资产可用时应优先选择正式版本。

## 快速上手

1. 点击「打开文件」立即阅读单份 Markdown，或点击「打开文件夹」建立工作区。
2. 使用顶部视图切换器选择预览、编辑或左右分栏。
3. 点击查找按钮，或使用快捷键查找和替换当前文稿。
4. 继续打开其他文稿；标签页会显示未保存标记，并在下次启动时恢复。

| 操作 | fnOS | macOS |
|---|---|---|
| 查找 | `⌘/Ctrl + F` | `⌘ + F` |
| 查找并替换 | `⌘/Ctrl + H` | `⌘ + Option + F` |
| 保存 | `⌘/Ctrl + S` | `⌘ + S` |

## 数据与安全

Flux Reader 直接读取你选择的 Mac 文件或 fnOS 授权目录，不会要求把文稿上传到第三方
服务。fnOS 会同时检查应用授权范围和当前登录用户权限；macOS 使用系统沙盒与安全书签。
保存前会检查磁盘版本，避免静默覆盖外部修改；未保存草稿和恢复版本用于处理意外退出或
写入中断。

更完整的安全边界、恢复事务与性能限制见
[技术与开发文档](docs/TECHNICAL.md)。

## 项目文档

- [技术架构、本地开发、测试与发布](docs/TECHNICAL.md)
- [fnOS 平台说明](apps/fnos/README.md)
- [macOS 平台说明](apps/macos/README.md)
- [共享 Web 阅读器说明](packages/reader-web/README.md)

## 参与项目

欢迎通过 [Issues](https://github.com/Derrors/flux-reader/issues) 提交问题、体验建议和功能想法。
准备贡献代码前，请先阅读[技术与开发文档](docs/TECHNICAL.md)，并在提交前运行相关测试。

## License

Flux Reader 使用 [MIT License](LICENSE)。
