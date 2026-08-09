# flux-reader

飞牛 fnOS 上的 Markdown 阅读器。支持 GFM 表格、代码高亮、数学公式与 Mermaid 图表，
默认浅色并可手动切换主题。用户既可以直接选择一个 Markdown 文件阅读，也可以
点击「打开文件夹」浏览应用设置中已授权目录下的 `.md` 文件。

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

## 目录结构

```
flux-reader/
├── backend/                    Express 服务
│   └── src/
│       ├── server.js           端口/Socket 双模式监听
│       ├── trim-api.js         fnOS 开放 API 客户端（Unix Socket）
│       ├── file-access.js      双层权限检查 + 防目录穿越
│       └── sample.md           渲染验收文档（边界用例集）
├── frontend/                   Vite + React
│   ├── src/markdown/           渲染核心
│   │   ├── pipeline.js         marked + KaTeX + 净化
│   │   ├── preprocess.js       setext 修复、frontmatter 转表格
│   │   ├── highlight.js        shiki 调度（Worker + 超时降级）
│   │   ├── shiki.worker.js     后台高亮
│   │   ├── MarkdownView.jsx    HTML → React、代码块替换、图片编组
│   │   ├── CodeBlock.jsx       代码块（先纯文本，高亮后回填）
│   │   └── Mermaid.jsx         图表（双主题 + 导出 SVG）
│   └── src/components/         FileTree、Toc
├── flux-reader/                fnOS 应用包
│   ├── manifest                micro_app=true、统一网关
│   ├── config/privilege        专用应用用户（最小权限）
│   ├── config/resource         api-scope 声明
│   └── cmd/main                生命周期脚本（status 未运行返回 3）
└── scripts/build-combined.js   合并前后端产物
```

## 本地开发

```bash
npm run install:all      # 装前后端依赖

npm run dev:backend      # 后端 :5178
npm run dev:frontend     # 前端 :5177（代理 API 到后端）
```

访问 http://127.0.0.1:5177/app/flux-reader/

本地无 fnOS 宿主环境，文件接口会返回 `LOCAL_DEV_NO_GATEWAY` 提示；
点击「渲染示例」可直接验证渲染效果，这是本地开发的主要用途。

**注意**：本地开发就用生产路径前缀 `/app/flux-reader`，提前模拟统一网关下的
访问路径，避免上线才发现路由问题。

## 自动化测试

```bash
npm test                         # 后端安全测试 + 前端回归测试
npm run test:frontend            # 仅运行前端测试
npm --prefix frontend run test:watch  # 前端监听模式
```

前端测试使用 Vitest、jsdom 与 Testing Library，覆盖文件/文件夹选择、取消与
失败保留状态、文件关联启动、403 回程重试、latest-wins 竞态、空文件、API URL
编码，以及右侧目录折叠样式。宿主 SDK 与后端接口均在测试中隔离 mock，不依赖
真实 fnOS 环境。

## 打包安装

```bash
npm run install:all                  # 先装依赖（构建依赖它）
npm run build                        # 构建并合并产物到 flux-reader/app
cd flux-reader && fnpack build       # 生成 .fpk
```

然后在 fnOS 应用中心离线安装 `.fpk`。

系统要求：**fnOS ≥ 1.2.0401**（开放 API 门槛）、飞牛 App ≥ 1.34.0。

`fnpack` 是飞牛官方独立二进制（非 npm 包），需按开发机架构从
[官方文档](https://developer.fnnas.com/docs/cli/fnpack) 下载安装。

### 常见问题

**`vite: command not found`** —— 前端依赖未安装或安装中断，先跑 `npm run install:all`。

**`npm ci` / `install` 报 404** —— 多见于 registry 版本同步滞后（lock 锁定的
版本在当前源上不存在）。加公网源重试：

```bash
npm run install:all --registry=https://registry.npmjs.org
```

注意：lock 中 `resolved` 写的域名不决定能否安装 —— npm 会用本地配置的
registry 替换域名，只保留包名与版本号。因此关键是「版本号在你用的源上是否存在」。

**产物位置** —— 构建输出到 `flux-reader/app/`，而非 `flux-reader/target/`。
fnpack 只把应用包的 `app/` 压成 `app.tgz`，安装后展开为 `/var/apps/{appname}/target/`；
放到 `target/` 不会被收进 `.fpk`（表现为 fpk 体积异常小、装上去起不来）。

## 架构要点

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
`pickSharedFile`，也不在应用页面内增删授权。普通启动时文件树为空并自动隐藏；
直接打开文件或从文件关联启动时只展示目标文档。系统设置返回后，应用只重新校验
当前已打开目录或待重试文件，不会自动展示全部共享授权根。

### 性能保护

NAS 硬件通常较弱，做了几处降级：

- shiki 跑 Web Worker，先纯文本上屏再回填高亮；8 秒超时则放弃高亮
- 代码超 50000 字符或单行超 2000 字符 → 直接纯文本，不高亮
- 单文件读取上限 2 MB
- mermaid / katex / shiki 各自独立分包懒加载

## 验收

`backend/src/sample.md` 是一份刻意塞满边界情况的验收文档，覆盖：
frontmatter、setext 陷阱、宽表格、任务列表、各语言代码块、超长行、
行内/块级公式、`$100` 误判、错误公式与错误图表降级、XSS 攻击载荷、
多图编组、多级标题 TOC。

渲染管线有 31 项断言（frontmatter / setext / GFM / 公式 / 占位 / XSS / TOC）
在开发时验证通过，包括：`<script>`、`onerror`、`javascript:` 协议、内联
`style`、`iframe` 均被净化，外链自动补 `rel="noopener"`，GFM 任务列表的
checkbox 保留但强制只读、其他 `input` 类型一律移除。

## 已知限制

- 已在当前 fnOS 环境完成安装与核心流程验证；其他 fnOS / 飞牛 App 版本仍建议
  安装后做一次文件选择器与用户 ACL 冒烟测试。
- mermaid 分包约 3.4 MB（gzip 936 KB），首次打开含图表的文档会有加载等待。
- 阅读器定位，暂不支持编辑与保存。

## License

MIT

依赖的开源库许可：marked (MIT)、mermaid (MIT)、KaTeX (MIT)、shiki (MIT)、
html-react-parser (MIT)、DOMPurify (Apache-2.0 / MPL-2.0 双许可)。
