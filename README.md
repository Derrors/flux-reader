# flux-reader

Flux Reader 是一个多平台 Markdown 阅读器 monorepo。共享阅读器支持 GFM 表格、
代码高亮、数学公式与 Mermaid 图表，默认浅色并可手动切换主题。

| 平台 | 状态 | 实现 |
|---|---|---|
| fnOS | 可用 | React 阅读器 + Express 服务 + fnOS 统一网关 |
| macOS | 可用（原生） | SwiftUI 原生应用 + WKWebView 共享高级渲染器 |

fnOS 应用可直接选择 Markdown 文件，同时打开最多 8 个本次会话选择的工作区，跨目录
搜索文件名与正文，并按当前登录用户保存最近文稿；页面会轮询工作区与当前文稿变化，
也能在权限边界内加载本地相对图片。fnOS 与 macOS 均支持文档内查找/替换、编辑与预览左右
分栏及同步滚动、多标签页、未保存标记和会话恢复，并继续提供安全保存、外部修改冲突检测和
未保存草稿恢复。macOS 应用同样支持多工作区、全文搜索和最近文稿，并使用安全书签恢复最多
8 个授权文件夹；FSEvents 会在内容变化后自动刷新索引与预览。

## 技术选型

| 环节 | 选型 | 说明 |
|---|---|---|
| 解析 | marked 18 | GFM 表格/任务列表/删除线原生支持 |
| HTML → React | html-react-parser 6 | 便于在 React 层替换节点 |
| 公式 | KaTeX 0.18（`output:mathml`、`trust:false`） | 禁用可引入外部资源的命令 |
| 图表 | Mermaid 11 | 深浅双主题，独立分包懒加载，可导出 SVG |
| 高亮 | shiki 4 + Web Worker | 纯文本先上屏，再回填高亮 |
| 净化 | dompurify 3 | 默认开启，浏览器版（不含 jsdom） |

**为什么不用 react-markdown**：它走 unified/rehype 管线，接入自定义代码块与
图表渲染需要写 rehype 插件。marked + html-react-parser 可以直接在 React 层
替换节点，扩展成本更低。

## Monorepo 结构

```
flux-reader/
├── apps/
│   ├── fnos/
│   │   ├── backend/                    Express 服务
│   │   │   └── src/
│   │   │       ├── server.js           端口/Socket 双模式监听
│   │   │       ├── trim-api.js         fnOS 开放 API 客户端
│   │   │       └── file-access.js      双层权限检查 + 防目录穿越
│   │   └── package/                    fnOS 应用包
│   │       ├── manifest                应用元数据与统一网关配置
│   │       ├── config/                 权限与 API scope
│   │       └── cmd/main                生命周期脚本
│   └── macos/                          原生 macOS 客户端
│       ├── FluxReader.xcodeproj        Xcode 工程
│       ├── FluxReader/                 SwiftUI / WebKit bridge 应用源码
│       ├── FluxReaderTests/            原生单元测试
│       └── FluxReaderUITests/          XCUITest UI 冒烟测试
├── packages/
│   └── reader-web/                     Vite + React 共享阅读器
│       └── src/
│           ├── markdown/               渲染核心
│           ├── macos-main.jsx          macOS 独立渲染入口
│           ├── macos/                  原生 payload bridge
│           └── components/             FileTree、Toc
└── scripts/build-fnos.js               合并 fnOS 前后端产物
```

这是一个 Node.js + Swift 的多语言 monorepo。Node 子项目分别保留 lockfile，根目录
脚本负责统一调度；这样既能共享阅读器，又不会破坏 fnOS 独立安装生产依赖的流程。

## 本地开发

```bash
npm run install:all      # 安装 fnOS 后端与共享阅读器依赖

npm run dev              # 共享阅读器 :5177，并自动拉起 fnOS 后端 :5178
npm run dev:backend      # 仅启动 fnOS 后端
npm run dev:reader       # 启动共享阅读器（兼容命令：dev:frontend）
```

访问 http://127.0.0.1:5177/app/flux-reader/

本地无 fnOS 宿主环境时，文件接口会返回
`LOCAL_DEV_NO_GATEWAY` 提示。Markdown 渲染能力通过前端自动化测试验证。

**注意**：本地开发就用生产路径前缀 `/app/flux-reader`，提前模拟统一网关下的
访问路径，避免上线才发现路由问题。

## 自动化测试

```bash
npm test                         # 后端安全测试 + 前端回归测试
npm run test:fnos                # 仅运行 fnOS 后端测试
npm run test:reader              # 仅运行共享阅读器测试
npm run test:macos               # 构建并运行 macOS 原生单元测试
npm run test:macos-ui-build      # 编译 macOS UI 自动化套件
npm run test:macos-ui            # 在已授予辅助功能权限的 Mac 上运行 UI 测试
npm run test:all                 # 运行当前机器支持的全部测试
npm --prefix packages/reader-web run test:watch  # 阅读器监听模式
```

fnOS GitHub Actions 会在相关平台或共享阅读器路径发生变化时，使用 Node.js 22
执行测试和生产构建。macOS 使用独立的 macOS 26 runner 构建 Xcode 工程并运行
共享阅读器测试与原生单元测试。修改 `packages/reader-web` 时两个平台的工作流都会
运行。

前端测试使用 Vitest、jsdom 与 Testing Library，覆盖文件/文件夹选择、取消与
失败保留状态、文件关联启动、403 回程重试、latest-wins 竞态、空文件、API URL
编码，以及右侧目录折叠样式。宿主 SDK 与后端接口均在测试中隔离 mock，不依赖
真实 fnOS 环境。

## 打包与发布

```bash
npm run install:all                  # 先装依赖（构建依赖它）
npm run version:check                # 校验 fnOS / macOS 发布版本一致
npm run build:fnos                   # 合并到 apps/fnos/package/app
npm run build:macos-renderer         # 单独构建供 WKWebView 使用的共享阅读器
npm run pack:fnos                    # 构建并调用 fnpack 生成 .fpk
npm run pack:macos                   # macOS 上生成未公证的 Universal .dmg
```

然后在 fnOS 应用中心离线安装 `.fpk`。

系统要求：**fnOS ≥ 1.2.0401**（开放 API 门槛）、飞牛 App ≥ 1.34.0。

`fnpack` 是飞牛官方独立二进制（非 npm 包），需按开发机架构从
[官方文档](https://developer.fnnas.com/docs/cli/fnpack) 下载安装。

### GitHub Release

根目录 `VERSION` 是 fnOS 与 macOS 的唯一发布版本源。准备下一个版本时，先修改
`VERSION`，再执行：

```bash
npm run version:sync
npm run test:all
```

代码合入 `main` 后，`Release` 工作流会自动运行全部校验，并行构建
`flux-reader-<version>.fpk` 与 `Flux-Reader-<version>-unnotarized-universal.dmg`，
生成 `SHA256SUMS`，最后创建 `v<version>` GitHub Release。相同 tag 不会被移动或
覆盖；如果新提交没有使用新的 `VERSION` / tag，工作流会明确失败，避免误覆盖旧版本。

macOS 产物是 Universal 2（Intel + Apple Silicon），仅做 ad-hoc 签名，**没有
Developer ID 签名，也没有经过 Apple 公证**。它适合自用、测试或受控环境；首次
打开时 Gatekeeper 仍可能警告或阻止启动。仓库的 GitHub Actions 必须允许工作流
使用 `contents: write`，才能创建 tag 和 Release。

仓库还提供手动的 `Notarized macOS Release` 工作流。配置 Developer ID 证书和
App Store Connect API key 后，它会构建 `Flux-Reader-<version>-universal.dmg`，
完成 hardened runtime 签名、Apple 公证、ticket stapling 与 Gatekeeper 校验，再把
DMG 和独立 SHA-256 文件附加到已经发布的同版本 GitHub Release。所需 secrets 与
本地签名方式见 [`apps/macos/README.md`](apps/macos/README.md)。

### 常见问题

**`vite: command not found`** —— 前端依赖未安装或安装中断，先跑 `npm run install:all`。

**`npm ci` / `install` 报 404** —— 多见于 registry 版本同步滞后（lock 锁定的
版本在当前源上不存在）。加公网源重试：

```bash
npm run install:all --registry=https://registry.npmjs.org
```

注意：lock 中 `resolved` 写的域名不决定能否安装 —— npm 会用本地配置的
registry 替换域名，只保留包名与版本号。因此关键是「版本号在你用的源上是否存在」。

**产物位置** —— 构建输出到 `apps/fnos/package/app/`，而非
`apps/fnos/package/target/`。
fnpack 只把应用包的 `app/` 压成 `app.tgz`，安装后展开为 `/var/apps/{appname}/target/`；
放到 `target/` 不会被收进 `.fpk`（表现为 fpk 体积异常小、装上去起不来）。

## fnOS 架构要点

### 访问模型：统一网关

选它的原因是需要拿到当前登录用户身份做多用户隔离。
`index.cgi` 每请求起一个进程、不支持流式与长连接，不适合常驻服务。

服务监听 Unix Socket（`gatewaySocket`），网关按 `gatewayPrefix` 转发，
并在转发前校验登录态、注入 `x-trim-userid` Header。

### 安全：双层权限检查

这是**必须**的，缺任何一层都是安全缺陷：

1. **第一层** — 管理员在 fnOS「应用设置 → 访问权限」中把固定目录授权给
   「应用用户」，应用通过 `getSharedAccessibleFolders` 得知共享授权范围。
2. **第二层** — 应用自己按「当前登录用户」权限判断（`checkUserACL`）。

网关只保证「有人登录了」，不保证「这个人能读这份文件」。

一个易错点：`checkUserACL` 在**路径不存在时三个权限位同样返回 false**。
`file-access.js` 中区分了「无权限(403)」与「文件不存在(404)」，
否则打开不存在的文件会被误报成权限问题。

此外还有防目录穿越与路径替换保护：`isInside` 用真实路径和 `path.sep`
校验边界；文件或目录打开后，再根据稳定文件描述符确认实际目标仍在共享授权
范围内、仍通过当前用户 ACL，且 inode 未在检查期间被替换。

目录配置只在系统应用设置中进行。Flux Reader 的「打开文件」和「打开文件夹」
都只调用 `pickFile` 选择本次要阅读的对象，不调用 `pickUserFile` /
`pickSharedFile`，也不在应用页面内增删授权。工作区只保留在当前会话中，普通启动
不会自动枚举之前选择过的目录；最近文稿只保存惰性展示元数据，按 `x-trim-userid`
隔离，并在展示前重新经过后端鉴权。直接打开文件或从文件关联启动时仍只展示目标文档。
系统设置返回后，应用只重新校验当前已打开工作区或待重试文件，不会自动展示全部
共享授权根。

全文搜索、工作区 revision 和相对图片也复用同一套双层权限与稳定文件描述符检查。
图片必须由已授权 Markdown 文稿引用，真实目标仍位于当前工作区内，只允许受支持的
位图格式；SVG、目录穿越、符号链接逃逸和读取期间的目标替换都会被拒绝。

### 性能保护

NAS 硬件通常较弱，做了几处降级：

- shiki 跑 Web Worker，先纯文本上屏再回填高亮；8 秒超时则放弃高亮
- 代码超 50000 字符或单行超 2000 字符 → 直接纯文本，不高亮
- 单文件读取上限 2 MB
- 本地图片读取上限 25 MB，采用有界读取并禁用响应缓存
- 工作区最多 8 个；递归扫描最多 10000 个条目、20 层目录
- 搜索最多返回 100 条；单次正文扫描最多 1000 个文件、64 MB
- 最近文稿与当前文稿轮询先走轻量元数据鉴权，不为探测变化下载完整正文
- 自动刷新顺序轮询工作区，页面隐藏或文件选择器打开时暂停，且不会叠加在途轮询
- 保存前同步落盘浏览器草稿；后端另用应用私有 0700/0600 恢复日志保护原地写入，异常后可在
  UI 中选择并恢复版本；保存使用 revision 做乐观并发控制，不会静默覆盖已变化的磁盘版本
- mermaid / katex / shiki 各自独立分包懒加载

## 验收

渲染管线有 31 项断言（frontmatter / setext / GFM / 公式 / 占位 / XSS / TOC）
在开发时验证通过，包括：`<script>`、`onerror`、`javascript:` 协议、内联
`style`、`iframe` 均被净化，外链自动补 `rel="noopener"`，GFM 任务列表的
checkbox 保留但强制只读、其他 `input` 类型一律移除。

## 已知限制

- 已在当前 fnOS 环境完成安装与核心流程验证；其他 fnOS / 飞牛 App 版本仍建议
  安装后做一次文件选择器与用户 ACL 冒烟测试。
- mermaid 分包约 3.4 MB（gzip 936 KB），首次打开含图表的文档会有加载等待。
- fnOS 的文件选择器只返回已存在的授权文件，因此当前支持编辑并保存原文件，不伪造「另存为」。
- fnOS 为保留原 inode 上的 Windows ACL、owner 和扩展属性，使用可恢复的原地写回；
  Flux Reader 自身的读写会串行，但 SMB 等外部程序可能在极短时间内观察到中间内容。

## License

MIT

依赖的开源库许可：marked (MIT)、mermaid (MIT)、KaTeX (MIT)、shiki (MIT)、
html-react-parser (MIT)、DOMPurify (Apache-2.0 / MPL-2.0 双许可)。
