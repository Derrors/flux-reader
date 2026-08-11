# Flux Reader 安全保存契约 v1

## 目标与边界

本契约统一 fnOS 与 macOS 保存操作的可观察行为、错误分类和安全不变量，不统一底层写盘算法。

- fnOS 继续使用共享目录授权、用户 ACL、稳定文件描述符、inode 事务门、私有 journal 和可恢复的原 inode 写回。
- macOS 继续使用 security-scoped resource、`NSFileCoordinator`、同目录临时文件、`RENAME_SWAP` 和用户可见的恢复 sidecar。
- `version` 是平台生成的不透明令牌。调用方只能保存、回传和比较是否相等，不得解析其中内容。
- `implementationSemantics` 仅用于诊断、测试和能力展示，不能被用于推断另一平台也具有相同的磁盘算法。

## Commit point

保存实现必须定义唯一 commit point。

- fnOS：新正文已写入并同步，目标仍是经授权的原 inode，正文、事务 revision、inode 安全元数据和 pathname 在最终屏障上均通过校验。
- macOS：同目录替换或 swap 已成功发布，并且目标 pathname 指向预期新正文。commit 后的非关键元数据读取失败不能把结果降格成普通失败。

commit point 之前的失败可返回 `rejected`；一旦发生破坏性 mutation 且无法证明目标的最终状态，就必须返回 `recoveryRequired`。已经越过 commit point 的操作只能返回 `committed`，或在确实无法判断是否越过 commit point 时返回 `recoveryRequired(commitState: unknown)`。

## 数据模型

### DocumentSnapshot

| 字段 | 含义 |
| --- | --- |
| `locator` | 当前调用方权限范围内的逻辑文稿标识 |
| `version` | 不透明版本令牌 |
| `content` | UTF-8 正文；传输投影可省略，省略时 `contentIncluded` 必须为 `false` |
| `contentIncluded` | 当前投影是否携带完整正文 |
| `byteCount` | UTF-8 字节数 |
| `capabilities` | 当前快照可观察的读写、创建和另存能力 |
| `implementationSemantics` | `atomicReplace`/`recoverableInPlace` 与 `private`/`sidecar` |

### SaveRequest

`SaveRequest` 包含 `locator`、`baseVersion`、UTF-8 `content` 和 `intent`。`intent` 为 `update`、`create`、`saveAs` 或 `restore`。除明确的 create/saveAs 外，缺失或无效的 `baseVersion` 必须 fail closed。

### SaveOutcome

- `committed`：携带 commit 后的新 `snapshot` 和可选 `recoveryReferences`。返回的 `version` 必须来自 commit 后状态。
- `rejected`：保证本次请求没有覆盖磁盘当前内容，携带结构化 `reason` 和可选 `currentVersion`。
- `recoveryRequired`：目标可能已经发生 mutation，调用方必须进入显式恢复流程；携带 `commitState`、恢复引用和可选 `currentVersion`。

v1 的拒绝原因除了核心的 `conflict`、`permission`、`invalidTarget`、`tooLarge`、`invalidUTF8`，还定义 `resourceExhausted`、`unavailable`、`cancelled` 和 `internal`，使未知平台错误不会被误报为冲突或权限问题。新增或删除分类必须修改 schema，并让两端 adapter 的穷举测试同时失败。

## 共同安全不变量

1. `baseVersion` 不匹配时不得覆盖磁盘当前内容。
2. 写权限、共享授权或 security scope 在 commit 前撤销时，不得开始或继续未经恢复保障的破坏性 mutation。
3. 首次破坏性 mutation 前必须建立 durable baseline，或由原子替换算法提供等价保证。
4. 外部进程在校验、发布、失败处理或回滚窗口内产生的内容不得被自动覆盖或删除。
5. `committed` 必须返回 commit 后的新 snapshot/version。
6. commit 后的非关键元数据读取或恢复工件清理失败不得被报告成普通“未保存”。清理待办应作为 committed 的附加恢复引用或诊断。
7. 无法确定最终状态时必须返回 `recoveryRequired`，不得猜测成功或失败。
8. 恢复版本只能通过显式恢复生命周期清理；保留期和配额是平台能力，不是普通保存的隐式副作用。
9. 日志、API 和 UI 不得向未授权调用方暴露私有恢复路径、真实授权根或其他用户的路径信息。
10. create/saveAs 在确认目标不存在后若被其他进程抢先创建，必须返回 conflict，不能覆盖新目标。

## 平台语义

| 平台 | `writeVisibility` | `recoveryLocation` | 保证 |
| --- | --- | --- | --- |
| fnOS | `recoverableInPlace` | `private` | 保留 inode 与 ACL/owner/mode；不宣称外部读取原子 |
| macOS | `atomicReplace` | `sidecar` | pathname 发布使用替换/swap；不保证保留原 inode |

## 兼容迁移

fnOS HTTP API 在迁移期保留原有成功字段及 `error/currentRevision/recoveryRequired/recovery` 字段，同时增加 `saveOutcome`。前端优先消费 `saveOutcome`，仅为兼容旧后端保留旧字段回退。macOS 继续返回 `MarkdownDocument`/抛出原错误，但 ViewModel 同时记录由 adapter 生成的 `lastSaveOutcome`。

`scenarios.json` 是两端共享的行为目录。它只表达前置状态、注入事件、预期 outcome 和磁盘内容约束；平台测试通过 `platformSignals` 把场景映射到本端既有机制。复杂竞态仍由各平台现有安全测试真正注入，本契约测试负责确保它们被归入相同的可观察结果。
