/**
 * 文件访问层：所有对用户文件的读取都必须经过这里。
 *
 * 安全模型（双层检查，缺任何一层都是安全缺陷）：
 *   第一层：管理员在应用设置中把共享目录 ACL 授予「应用用户」，
 *          应用侧通过 getSharedAccessibleFolders 得知授权范围。
 *   第二层：应用自己按「当前登录用户」权限判断 —— checkUserACL。
 *
 * 网关只保证「有人登录了」，不保证「这个人能读这份文件」。
 */
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const trimApi = require('./trim-api');

const MD_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
/** 单文件读取上限，防止把 NAS 内存吃满 */
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
/** 本地图片读取上限；与 macOS 端保持一致。 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MiB
const IMAGE_MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.webp', 'image/webp'],
]);
/** 递归接口的硬上限，避免一次请求扫描整台 NAS。 */
const MAX_SELECTED_WORKSPACES = 8;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 20;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_CONTENT_FILES = 1000;
/**
 * JSON 控制字符最坏会以 \uXXXX 扩为 6 倍；请求层只防资源耗尽，真正的
 * Markdown 上限仍在解码后按 UTF-8 字节严格检查 10 MiB。
 */
const MAX_SAVE_REQUEST_BYTES = MAX_FILE_BYTES * 6 + 64 * 1024;
/** 避免单次 ACL 请求包含过多路径 */
const ACL_BATCH_SIZE = 100;
const READ_ONLY_NONBLOCKING = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
const READ_WRITE_NONBLOCKING = fsConstants.O_RDWR | fsConstants.O_NONBLOCK;
const TEMP_WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const SAVE_ARTIFACT_PREFIX = '.flux-reader-save-';
const RECOVERY_MANIFEST_VERSION = 1;
const MAX_RECOVERY_MANIFEST_BYTES = 64 * 1024;
const RECOVERY_MANIFEST_NAME = /^manifest-([a-f0-9]{48})\.json$/u;
/**
 * 恢复提交允许处理的单个 baseline / attempted / observed 硬上限。
 * 新的 Markdown 编辑正文仍由 MAX_FILE_BYTES 严格限制为 10 MiB。
 */
const MAX_RECOVERY_BASELINE_BYTES = 16 * 1024 * 1024;
const MAX_RECOVERY_ARTIFACTS_PER_TRANSACTION = 3;
const MAX_RECOVERY_MANIFEST_RESERVATIONS_PER_TRANSACTION = 4;
const MAX_RECOVERY_TRANSACTION_BYTES =
  MAX_RECOVERY_BASELINE_BYTES * MAX_RECOVERY_ARTIFACTS_PER_TRANSACTION +
  MAX_RECOVERY_MANIFEST_BYTES *
    MAX_RECOVERY_MANIFEST_RESERVATIONS_PER_TRANSACTION;
const MAX_RECOVERY_TRANSACTIONS_PER_TARGET = 8;
const MAX_RECOVERY_TRANSACTIONS_PER_UID = 32;
const MAX_RECOVERY_TRANSACTIONS_GLOBAL = 128;
/**
 * 一个事务最坏保留 3 个 16 MiB 工件与 4 份 manifest 预留。单目标
 * 允许两个最坏事务同时存在，所以最大恢复记录仍能安全重试一次；
 * uid/global 继续按固定倍数封顶，避免恢复空间无界增长。
 */
const MAX_RECOVERY_BYTES_PER_TARGET = MAX_RECOVERY_TRANSACTION_BYTES * 2;
const MAX_RECOVERY_BYTES_PER_UID = MAX_RECOVERY_BYTES_PER_TARGET * 2;
const MAX_RECOVERY_BYTES_GLOBAL = MAX_RECOVERY_BYTES_PER_UID * 4;
const RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let openedTargetResolverForTest = null;
let searchContentLimitsForTest = null;
let saveHooksForTest = null;
let recoveryRootForTest = null;
/** 同一进程内按真实文件路径串行保存；外部写入仍由 revision + fd 重验拦截。 */
const saveTails = new Map();
/** 进程内尚未完成的 recoveryId；防止新 inode 路径并发丢弃在途 baseline。 */
const activeRecoveryIds = new Set();

function openReadOnly(pathname) {
  // O_NONBLOCK 避免攻击者把 `.md` 换成 FIFO 后让 open 无限等待；
  // 打开后仍必须通过 fstat 确认是普通文件或目录。
  return fs.open(pathname, READ_ONLY_NONBLOCKING);
}

function openReadWrite(pathname) {
  // 与读取相同地使用 O_NONBLOCK，避免恶意 FIFO 阻塞；随后必须 fstat 普通文件。
  return fs.open(pathname, READ_WRITE_NONBLOCKING);
}

async function canWriteOpenedMarkdown(opened, expectedIdentity) {
  if (!opened.acl?.writable) return false;
  let fh;
  try {
    // 生产 Linux 使用 /proc/self/fd/N 重新以 O_RDWR 打开同一 inode；这既验证
    // fnOS 应用账号的真实写能力，也避免为 capability 探测重新遍历用户路径。
    fh = await openReadWrite(opened.ioPath);
    const stat = await fh.stat();
    return stat.isFile() && sameFileIdentity(stat, expectedIdentity);
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function preciseStatValue(stat, preciseName, millisecondName) {
  if (stat?.[preciseName] !== undefined) return String(stat[preciseName]);
  return String(stat?.[millisecondName] ?? '');
}

function revisionFromStat(stat) {
  const hash = crypto.createHash('sha256');
  hash.update('flux-reader-file-revision-v1\0');
  for (const value of [
    stat.dev,
    stat.ino,
    stat.size,
    preciseStatValue(stat, 'mtimeNs', 'mtimeMs'),
    preciseStatValue(stat, 'ctimeNs', 'ctimeMs'),
  ]) {
    const text = String(value);
    hash.update(String(Buffer.byteLength(text)));
    hash.update(':');
    hash.update(text);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function samePreciseVersion(left, right) {
  return (
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    String(left.size) === String(right.size) &&
    preciseStatValue(left, 'mtimeNs', 'mtimeMs') ===
      preciseStatValue(right, 'mtimeNs', 'mtimeMs') &&
    preciseStatValue(left, 'ctimeNs', 'ctimeMs') ===
      preciseStatValue(right, 'ctimeNs', 'ctimeMs')
  );
}

function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function preciseMilliseconds(stat, nanosecondName, millisecondName) {
  if (stat?.[nanosecondName] !== undefined) return Number(stat[nanosecondName]) / 1_000_000;
  return Number(stat?.[millisecondName]);
}

function preciseMatchesOpened(precise, opened) {
  // Number Stat 的 *timeMs 在部分文件系统会因 IEEE-754 舍入与
  // bigint nanoseconds 相差一个最小浮点单位；用小于 1 微秒的容差只做
  //「授权 stat 与紧随其后的 precise stat」桥接，revision 本身仍使用完整 ns。
  const mtimeDelta = Math.abs(
    preciseMilliseconds(precise, 'mtimeNs', 'mtimeMs') - opened.mtimeMs,
  );
  const ctimeDelta = Math.abs(
    preciseMilliseconds(precise, 'ctimeNs', 'ctimeMs') - opened.ctimeMs,
  );
  return (
    sameFileIdentity(precise, opened) &&
    Number(precise.size) === opened.size &&
    mtimeDelta < 0.001 &&
    ctimeDelta < 0.001
  );
}

async function preciseStat(fh) {
  try {
    return await fh.stat({ bigint: true });
  } catch (err) {
    // Node 20 支持 bigint stat；若文件系统适配层不支持则保持 fail closed，
    // 否则毫秒级时间戳会让快速 ABA 修改绕过 revision。
    throw securityError(
      `无法获取文件的高精度版本信息: ${err.message}`,
      'PRECISE_FILE_STATE_UNAVAILABLE',
      503,
    );
  }
}

async function withSaveLock(key, operation) {
  const previous = (saveTails.get(key) || Promise.resolve()).catch(() => {});
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  saveTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (saveTails.get(key) === tail) saveTails.delete(key);
  }
}

/**
 * 所有本进程内的 Markdown 读、状态探测和保存都按稳定 fd 的 dev+ino 排队。
 * probe 在进入队列前只读打开，保存侧直到取得锁后才会打开 O_RDWR fd；因此
 * hard-link 别名会落到同一把锁，应用自身不会观察到 truncate/write 窗口。
 */
async function withLockedMarkdown(uid, targetPath, { signal } = {}, operation) {
  const probe = await openAuthorizedTarget(uid, targetPath, {
    kind: 'Markdown 文稿',
    expectedType: 'file',
    markdownOnly: true,
    signal,
  });
  try {
    const identity = await preciseStat(probe.fh);
    const lockKey = `${String(identity.dev)}:${String(identity.ino)}`;
    return await withSaveLock(lockKey, async () => {
      throwIfAborted(signal);
      const opened = await authorizeOpenedTarget(
        uid,
        probe.fh,
        probe.requestedPath,
        probe.scope,
        'Markdown 文稿',
      );
      const currentIdentity = await preciseStat(probe.fh);
      if (!sameFileIdentity(identity, currentIdentity)) {
        throw fileConflict('文稿在等待文件事务期间已被替换');
      }
      await assertRequestedPathStable(targetPath, opened.actualPath, 'Markdown 文稿');
      return operation({ probe, opened, currentIdentity, lockKey });
    });
  } finally {
    await probe.fh.close().catch(() => {});
  }
}

function abortError() {
  const err = new Error('搜索已取消');
  err.name = 'AbortError';
  err.reason = 'SEARCH_ABORTED';
  err.status = 499;
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function mapOpenError(err, kind) {
  const code = err?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return securityError(`${kind}不存在`, 'PATH_NOT_FOUND', 404);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return securityError(`无权打开${kind}`, 'PATH_OPEN_DENIED', 403);
  }
  if (['EMFILE', 'ENFILE', 'ENOMEM', 'ESTALE', 'EBUSY', 'ETIMEDOUT'].includes(code)) {
    return securityError(`存储暂时无法打开${kind}`, 'PATH_OPEN_UNAVAILABLE', 503);
  }
  return securityError(`打开${kind}时发生存储错误`, 'PATH_OPEN_FAILED', 500);
}

/**
 * 使用一个按「已授权初始 stat.size + 1」分配的缓冲区读取。
 * 额外一字节用于检测并发增长；最终 size/mtime/ctime 必须与授权时完全一致。
 */
async function readStableBounded(
  fh,
  initialStat,
  limit,
  { signal, changedReason, tooLargeReason, kind },
) {
  throwIfAborted(signal);
  if (initialStat.size > limit) {
    throw securityError(`${kind}超过读取上限`, tooLargeReason, 413);
  }

  const initialPreciseStat = await preciseStat(fh);
  if (!sameFileIdentity(initialPreciseStat, initialStat)) {
    throw securityError(`${kind}在读取前已被替换`, changedReason, 409);
  }

  const capacity = initialStat.size + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let total = 0;
  let position = 0;
  while (total < capacity) {
    throwIfAborted(signal);
    const { bytesRead } = await fh.read(
      buffer,
      total,
      capacity - total,
      position,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
    position += bytesRead;
  }
  const finalStat = await fh.stat();
  const finalPreciseStat = await preciseStat(fh);
  throwIfAborted(signal);
  if (
    total !== initialStat.size ||
    finalStat.size !== initialStat.size ||
    finalStat.mtimeMs !== initialStat.mtimeMs ||
    finalStat.ctimeMs !== initialStat.ctimeMs ||
    !samePreciseVersion(initialPreciseStat, finalPreciseStat)
  ) {
    throw securityError(`${kind}在读取期间发生变化`, changedReason, 409);
  }
  return {
    data: buffer.subarray(0, total),
    stat: finalStat,
    preciseStat: finalPreciseStat,
  };
}

function isMarkdownPath(p) {
  return MD_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/**
 * 判断 target 是否位于 root 之内（防目录穿越）。
 *
 * 必须在 resolve 之后比较，且用 path.sep 收尾避免 /a/bc 命中 /a/b。
 * 注意这只是**词法**判断，不解析符号链接——调用方应先用 realpath 拿到
 * 规范路径再传进来，否则授权目录内的软链可指向目录外，绕过范围校验。
 */
function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 从 getSharedAccessibleFolders 的返回中取出授权路径数组。
 *
 * 官方结构是 data.paths（字符串数组）；其余键名仅作兜底。
 * 这里必须集中一处：此前 assertWithinAuthorized 与 getAuthorizedRoots
 * 各写了一份且都漏了 paths，导致「设置里已授权，应用却说没有授权」
 * 且不报任何错。
 */
function extractAuthorizedPaths(data) {
  const items = Array.isArray(data)
    ? data
    : data?.paths || data?.list || data?.folders || [];
  return items
    .map((it) => (typeof it === 'string' ? it : it?.path))
    .filter(Boolean);
}

/**
 * 解析真实路径（跟随符号链接）。
 * 路径不存在时回退到词法 resolve，由调用方后续的存在性/权限检查处理。
 */
async function realpathSafe(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** 兼容 checkUserACL 返回以路径为 key 或把 path 放在值内的形态。 */
function getAclForPath(aclMap, targetPath) {
  if (!aclMap || typeof aclMap !== 'object') return null;
  if (aclMap[targetPath]) return aclMap[targetPath];
  return Object.values(aclMap).find((item) => item?.path === targetPath) || null;
}

/** 获取共享授权的一次快照，并丢弃已无法解析的根目录。 */
async function getSharedAuthorizationSnapshot() {
  const roots = extractAuthorizedPaths(await trimApi.getSharedAccessibleFolders());
  const resolvedRoots = (
    await Promise.all(
      roots.map(async (root) => {
        try {
          return { path: root, realPath: await fs.realpath(root) };
        } catch {
          // 授权根已不存在或应用账号无法解析时必须 fail closed。
          return null;
        }
      }),
    )
  ).filter(Boolean);
  return {
    roots,
    resolvedRoots,
    realRoots: resolvedRoots.map((item) => item.realPath),
  };
}

function securityError(message, reason, status = 403) {
  const err = new Error(message);
  err.reason = reason;
  err.status = status;
  return err;
}

function isInsideAny(roots, targetPath) {
  return roots.some((root) => isInside(root, targetPath));
}

function isTestRuntime() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
}

/** 只供单元测试注入可解析的稳定 fd 标识，生产环境禁止设置。 */
function setOpenedTargetResolverForTest(resolver) {
  if (!isTestRuntime()) {
    throw new Error('opened target resolver 只能在测试环境中注入');
  }
  openedTargetResolverForTest = resolver || null;
}

function setSearchContentLimitsForTest(limits) {
  if (!isTestRuntime()) {
    throw new Error('搜索上限只能在测试环境中覆盖');
  }
  searchContentLimitsForTest = limits || null;
}

function setSaveHooksForTest(hooks) {
  if (!isTestRuntime()) {
    throw new Error('保存测试 hook 只能在测试环境中注入');
  }
  saveHooksForTest = hooks || null;
}

function setRecoveryRootForTest(rootPath) {
  if (!isTestRuntime()) {
    throw new Error('恢复目录只能在测试环境中注入');
  }
  recoveryRootForTest = rootPath || null;
}

function selfFdPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function crossProcessFdPath(fd) {
  return `/proc/${process.pid}/fd/${fd}`;
}

/**
 * 从已打开 fd 反查它实际指向的路径。
 *
 * fnOS 生产环境是 Linux，/proc 解析失败时必须拒绝，绝不能回退到
 * 原请求路径。非 Linux 只在 NODE_ENV=test 或 Node 内置测试运行器下
 * 允许用「重新 realpath + fd/path inode 前后校验」的降级方式；
 * 生产不会走该分支。
 */
async function resolveOpenedTarget(fh, requestedPath) {
  if (openedTargetResolverForTest) {
    return openedTargetResolverForTest(fh, requestedPath);
  }

  if (process.platform === 'linux') {
    const fdPath = selfFdPath(fh.fd);
    try {
      return {
        actualPath: await fs.realpath(fdPath),
        ioPath: fdPath,
        // 开放 API 由另一个进程执行，/proc/self 会指向网关自己；
        // 必须显式带本服务 pid，才能让 ACL 检查绑定当前已打开对象。
        aclPath: crossProcessFdPath(fh.fd),
        testFallback: false,
      };
    } catch (err) {
      throw securityError(
        `无法解析已打开文件描述符: ${err.message}`,
        'OPENED_FD_RESOLUTION_FAILED',
        500,
      );
    }
  }

  if (!isTestRuntime()) {
    throw securityError(
      '当前系统无法安全解析已打开的文件描述符',
      'SECURE_FD_PATH_UNAVAILABLE',
      500,
    );
  }

  try {
    const actualPath = await fs.realpath(requestedPath);
    return {
      actualPath,
      ioPath: actualPath,
      // 非 Linux 测试环境没有可跨进程解析的 /proc fd 路径；
      // 该降级仅用于功能测试，生产 Linux 绝不会回退到 actualPath。
      aclPath: actualPath,
      testFallback: true,
    };
  } catch (err) {
    throw securityError(
      `无法解析测试环境中的已打开目标: ${err.message}`,
      'OPENED_FD_RESOLUTION_FAILED',
      500,
    );
  }
}

/** ACL 返回后确认路径仍指向当初打开的同一个 inode。 */
async function assertFdMatchesPath(fh, actualPath) {
  let fdStat;
  let pathStat;
  try {
    [fdStat, pathStat] = await Promise.all([fh.stat(), fs.stat(actualPath)]);
  } catch {
    throw securityError(
      '权限检查期间目标路径已发生变化',
      'PATH_CHANGED_DURING_AUTHORIZATION',
    );
  }
  if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
    throw securityError(
      '权限检查期间目标路径已被替换',
      'PATH_CHANGED_DURING_AUTHORIZATION',
    );
  }
  return fdStat;
}

/**
 * 稳定 fd ACL 不可读时，可以用 nominal actualPath 做一次「仅诊断」的对照。
 * 如果 nominal 可读而 fd 不可读，说明当前 fnOS 开放 API 无法检查
 * 跨进程 proc fd。此时必须明确报错且继续 fail closed，诊断结果绝不能放行。
 */
async function diagnoseStableAclSupport(uid, openedItems, stableAclMap) {
  const denied = openedItems.filter(
    (item) =>
      item.opened.aclPath !== item.opened.actualPath &&
      !getAclForPath(stableAclMap, item.opened.aclPath)?.readable,
  );
  if (denied.length === 0) return;

  const nominalPaths = denied.map((item) => item.opened.actualPath);
  const nominalMap = await trimApi.checkUserACL(uid, nominalPaths);
  const nominalReadable = denied.some((item) =>
    getAclForPath(nominalMap, item.opened.actualPath)?.readable,
  );
  if (nominalReadable) {
    throw securityError(
      '当前 fnOS 不支持对稳定文件描述符执行用户权限检查',
      'SECURE_FD_ACL_UNAVAILABLE',
      503,
    );
  }
}

function assertOpenedWithinScopes(opened, preliminaryScope, currentScope, kind) {
  if (!isInsideAny(preliminaryScope.realRoots, opened.actualPath)) {
    throw securityError(
      `${kind}在打开期间已移出预校验的授权范围`,
      'PATH_CHANGED_DURING_OPEN',
    );
  }
  if (!isInsideAny(currentScope.realRoots, opened.actualPath)) {
    throw securityError(
      `${kind}已不在当前共享授权范围内`,
      'SHARED_AUTHORIZATION_CHANGED',
    );
  }
}

async function refreshSharedAuthorization() {
  try {
    return await getSharedAuthorizationSnapshot();
  } catch (err) {
    throw securityError(
      `无法重新读取应用设置中的授权目录: ${err.message}`,
      'SHARED_AUTHORIZATION_FAILED',
      502,
    );
  }
}

/**
 * 用已打开 fd 的真实目标重做授权范围和当前用户 ACL 检查。
 * 真实目标必须同时位于打开前的授权快照和重新查询的当前快照内。
 */
async function authorizeOpenedTarget(uid, fh, requestedPath, preliminaryScope, kind) {
  const opened = await resolveOpenedTarget(fh, requestedPath);
  const currentScope = await refreshSharedAuthorization();
  assertOpenedWithinScopes(opened, preliminaryScope, currentScope, kind);

  // ACL 必须检查可跨进程解析的稳定 fd 路径。若平台不支持该
  // 路径，结果会是不可读或接口错误，必须 fail closed，不得回退 actualPath。
  const aclMap = await trimApi.checkUserACL(uid, [opened.aclPath]);
  await diagnoseStableAclSupport(uid, [{ opened }], aclMap);
  const acl = getAclForPath(aclMap, opened.aclPath);
  if (!acl?.readable) {
    throw securityError(`当前用户无权读取该${kind}`, 'USER_ACL_DENIED');
  }

  const stat = await assertFdMatchesPath(fh, opened.actualPath);
  return { ...opened, stat, currentScope, acl };
}

/**
 * 从稳定父目录 fd 逐批打开子项，并把用户 ACL 检查绑定到每个
 * 子项的跨进程 proc fd 路径。任何子项在返回前都会校验授权范围、
 * 直属父目录、类型和 fd/path inode；批次结束无论成败都关闭所有 handle。
 */
async function filterDirectoryChildrenByStableAcl(
  uid,
  parentFh,
  parentOpened,
  preliminaryScope,
  candidates,
  signal,
) {
  const visible = [];
  for (let offset = 0; offset < candidates.length; offset += ACL_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = candidates.slice(offset, offset + ACL_BATCH_SIZE);
    const openedChildren = [];
    try {
      for (const item of batch) {
        throwIfAborted(signal);
        let fh;
        try {
          // 生产 Linux 从稳定父 fd 打开子项，不再重新遍历用户可控的祖先路径。
          fh = await openReadOnly(path.join(parentOpened.ioPath, item.name));
        } catch (err) {
          // 子项消失或无权时隐藏名称；NAS/进程资源故障必须向上报告。
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err?.code)) continue;
          throw mapOpenError(err, '目录子项');
        }

        try {
          const opened = await resolveOpenedTarget(fh, path.join(parentOpened.ioPath, item.name));
          openedChildren.push({ item, fh, opened });
        } catch (err) {
          await fh.close().catch(() => {});
          throw err;
        }
      }

      if (openedChildren.length === 0) continue;
      throwIfAborted(signal);
      const currentScope = await refreshSharedAuthorization();
      throwIfAborted(signal);
      for (const child of openedChildren) {
        throwIfAborted(signal);
        assertOpenedWithinScopes(
          child.opened,
          preliminaryScope,
          currentScope,
          '目录子项',
        );

        const expectedPath = path.join(parentOpened.actualPath, child.item.name);
        if (path.resolve(child.opened.actualPath) !== path.resolve(expectedPath)) {
          throw securityError(
            '目录子项已不再属于当前父目录',
            'CHILD_PATH_CHANGED',
          );
        }

        const stat = await child.fh.stat();
        child.stat = stat;
        const typeMatches =
          (child.item.type === 'dir' && stat.isDirectory()) ||
          (child.item.type === 'file' && stat.isFile());
        if (!typeMatches) {
          throw securityError('目录子项类型已发生变化', 'CHILD_TYPE_CHANGED');
        }
      }

      const aclPaths = openedChildren.map((child) => child.opened.aclPath);
      const aclMap = await trimApi.checkUserACL(uid, aclPaths);
      throwIfAborted(signal);
      await diagnoseStableAclSupport(uid, openedChildren, aclMap);

      // ACL 返回后先重验父目录及每个子项的 inode。ABA 即使把
      // pathname 换回原 inode，ACL 也已经查的是不变的 child fd，无需且禁止回退。
      await assertFdMatchesPath(parentFh, parentOpened.actualPath);
      for (const child of openedChildren) {
        await assertFdMatchesPath(child.fh, child.opened.actualPath);
        if (getAclForPath(aclMap, child.opened.aclPath)?.readable) {
          visible.push({
            ...child.item,
            size: child.stat.size,
            mtime: child.stat.mtimeMs,
            ctime: child.stat.ctimeMs,
          });
        }
      }
    } finally {
      await Promise.all(openedChildren.map((child) => child.fh.close().catch(() => {})));
    }
  }
  return visible;
}

/** 打开每个共享授权根，并以根目录 fd 的跨进程 proc 路径检查用户 ACL。 */
async function filterSharedRootsByStableAcl(uid, preliminaryScope) {
  const visible = [];
  for (
    let offset = 0;
    offset < preliminaryScope.resolvedRoots.length;
    offset += ACL_BATCH_SIZE
  ) {
    const batch = preliminaryScope.resolvedRoots.slice(offset, offset + ACL_BATCH_SIZE);
    const openedRoots = [];
    try {
      for (const item of batch) {
        let fh;
        try {
          fh = await openReadOnly(item.path);
        } catch (err) {
          // 根目录已消失或无权时隐藏；系统资源/存储故障不能伪装成空授权。
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err?.code)) continue;
          throw mapOpenError(err, '共享授权根目录');
        }
        try {
          const opened = await resolveOpenedTarget(fh, item.path);
          openedRoots.push({ item, fh, opened });
        } catch (err) {
          await fh.close().catch(() => {});
          throw err;
        }
      }

      if (openedRoots.length === 0) continue;
      const currentScope = await refreshSharedAuthorization();
      for (const root of openedRoots) {
        assertOpenedWithinScopes(
          root.opened,
          preliminaryScope,
          currentScope,
          '共享授权根目录',
        );

        // 根目录必须仍是同一条应用设置授权，不能只因为它恰好落在
        // 另一个更大的授权根下就继续展示。
        const stillConfigured = currentScope.resolvedRoots.some(
          (item) => item.path === root.item.path && item.realPath === root.opened.actualPath,
        );
        if (
          root.item.realPath !== root.opened.actualPath ||
          !stillConfigured
        ) {
          throw securityError(
            '共享授权根目录在打开期间已发生变化',
            'SHARED_AUTHORIZATION_CHANGED',
          );
        }

        const stat = await root.fh.stat();
        if (!stat.isDirectory()) {
          throw securityError('共享授权根不是目录', 'ROOT_TYPE_CHANGED');
        }
      }

      const aclPaths = openedRoots.map((root) => root.opened.aclPath);
      const aclMap = await trimApi.checkUserACL(uid, aclPaths);
      await diagnoseStableAclSupport(uid, openedRoots, aclMap);
      for (const root of openedRoots) {
        await assertFdMatchesPath(root.fh, root.opened.actualPath);
        if (getAclForPath(aclMap, root.opened.aclPath)?.readable) {
          visible.push(root.item);
        }
      }
    } finally {
      await Promise.all(openedRoots.map((root) => root.fh.close().catch(() => {})));
    }
  }
  return visible;
}

/**
 * 校验请求路径是否落在「管理员授权给应用的共享目录」范围内。
 *
 * 授权根与目标都取 realpath 后再比较，否则可在授权目录内放一个指向外部的
 * 符号链接来绕过范围校验（读到目录外的文件）。
 *
 * @returns {Promise<{ok:boolean, reason?:string, roots:string[], realTarget?:string}>}
 */
async function assertWithinAuthorized(targetPath) {
  let snapshot;
  try {
    snapshot = await getSharedAuthorizationSnapshot();
  } catch (err) {
    return {
      ok: false,
      reason: 'SHARED_AUTHORIZATION_FAILED',
      detail: err.message,
      roots: [],
      realRoots: [],
    };
  }

  if (snapshot.roots.length === 0 || snapshot.realRoots.length === 0) {
    return {
      ok: false,
      reason: 'NO_AUTHORIZED_PATH',
      roots: snapshot.roots,
      realRoots: snapshot.realRoots,
    };
  }

  // 这只是打开前的快速拒绝。打开后必须以 fd 真实目标重做全部校验。
  const realTarget = await realpathSafe(targetPath);
  const hit = isInsideAny(snapshot.realRoots, realTarget);
  return hit
    ? { ok: true, ...snapshot, realTarget }
    : { ok: false, reason: 'PATH_NOT_AUTHORIZED', ...snapshot, realTarget };
}

function throwAuthorizationScopeError(scope, kind) {
  const message =
    scope.reason === 'NO_AUTHORIZED_PATH'
      ? '尚未配置可访问目录，请由管理员在应用设置的「访问权限」中添加'
      : scope.reason === 'SHARED_AUTHORIZATION_FAILED'
        ? `无法读取应用设置中的授权目录: ${scope.detail}`
        : `该${kind}未被授权访问`;
  throw securityError(
    message,
    scope.reason,
    scope.reason === 'SHARED_AUTHORIZATION_FAILED' ? 502 : 403,
  );
}

function assertAbsolutePath(value, fieldName) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw securityError(`${fieldName} 必须是有效的绝对路径`, 'INVALID_PATH', 400);
  }
}

/**
 * 打开并授权一个目标，但不读取内容。调用方必须关闭返回的 fh。
 *
 * 新增的搜索、轮询和图片接口都经由这里绑定稳定 fd，不能在 API 层
 * 直接 stat/readFile/readdir 用户提供的路径。
 */
async function openAuthorizedTarget(
  uid,
  targetPath,
  {
    kind = '路径',
    expectedType = null,
    markdownOnly = false,
    authorizationPath = targetPath,
    writeAccess = false,
    signal,
  } = {},
) {
  throwIfAborted(signal);
  assertAbsolutePath(targetPath, kind);
  assertAbsolutePath(authorizationPath, `${kind}授权路径`);
  if (markdownOnly && !isMarkdownPath(targetPath)) {
    throw securityError('仅支持 .md / .markdown / .mdx 文件', 'UNSUPPORTED_DOCUMENT_TYPE', 400);
  }

  const scope = await assertWithinAuthorized(authorizationPath);
  throwIfAborted(signal);
  if (!scope.ok) throwAuthorizationScopeError(scope, kind);

  let fh;
  try {
    fh = writeAccess ? await openReadWrite(targetPath) : await openReadOnly(targetPath);
  } catch (err) {
    throw mapOpenError(err, kind);
  }

  try {
    const opened = await authorizeOpenedTarget(uid, fh, targetPath, scope, kind);
    throwIfAborted(signal);
    if (
      (expectedType === 'file' && !opened.stat.isFile()) ||
      (expectedType === 'dir' && !opened.stat.isDirectory()) ||
      (!expectedType && !opened.stat.isFile() && !opened.stat.isDirectory())
    ) {
      throw securityError(
        expectedType === 'dir' ? '目标不是目录' : expectedType === 'file' ? '目标不是文件' : '目标类型不受支持',
        'INVALID_TARGET_TYPE',
        400,
      );
    }
    return { fh, opened, scope, requestedPath: targetPath, authorizationPath };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

function metadataFromOpened(target, precise = null) {
  const { opened, requestedPath } = target;
  const type = opened.stat.isDirectory() ? 'dir' : 'file';
  return {
    path: opened.actualPath,
    requestedPath,
    type,
    size: opened.stat.size,
    mtime: opened.stat.mtimeMs,
    ctime: opened.stat.ctimeMs,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    ...(precise ? { revision: revisionFromStat(precise) } : {}),
  };
}

async function inspectAuthorizedTarget(uid, targetPath, options) {
  const target = await openAuthorizedTarget(uid, targetPath, options);
  try {
    const currentPrecise = await preciseStat(target.fh);
    if (!preciseMatchesOpened(currentPrecise, target.opened.stat)) {
      throw securityError(
        '目标在读取元数据期间发生变化',
        'FILE_CHANGED_DURING_STATE_READ',
        409,
      );
    }
    return metadataFromOpened(target, currentPrecise);
  } finally {
    await target.fh.close().catch(() => {});
  }
}

/**
 * 读取 Markdown 文件内容（阅读器主入口）。
 * 完整走双层检查。
 */
async function readMarkdown(uid, targetPath, { signal } = {}) {
  throwIfAborted(signal);
  if (!isMarkdownPath(targetPath)) {
    throw securityError(
      '仅支持 .md / .markdown / .mdx 文件',
      'UNSUPPORTED_DOCUMENT_TYPE',
      400,
    );
  }

  return withLockedMarkdown(
    uid,
    targetPath,
    { signal },
    async ({ probe, opened }) => {
      const { stat } = opened;
      if (stat.size > MAX_FILE_BYTES) {
        throw securityError(
          `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MiB），阅读器上限为 ${MAX_FILE_BYTES / 1024 / 1024} MiB`,
          'FILE_TOO_LARGE',
          413,
        );
      }
      const {
        data,
        stat: finalStat,
        preciseStat: finalPreciseStat,
      } = await readStableBounded(
        probe.fh,
        stat,
        MAX_FILE_BYTES,
        {
          signal,
          changedReason: 'FILE_CHANGED_DURING_READ',
          tooLargeReason: 'FILE_TOO_LARGE',
          kind: '文件',
        },
      );
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw securityError('文件不是有效的 UTF-8 文本', 'INVALID_UTF8', 422);
      }
      const recovery = await getRecoveryDiagnostics(
        uid,
        opened.actualPath,
        finalPreciseStat,
      );
      const writable = await canWriteOpenedMarkdown(opened, finalPreciseStat);
      return {
        content,
        actualPath: opened.actualPath,
        size: finalStat.size,
        mtime: finalStat.mtimeMs,
        ctime: finalStat.ctimeMs,
        revision: revisionFromStat(finalPreciseStat),
        writable,
        ...(recovery ? { recovery } : {}),
      };
    },
  );
}


/** 只校验 Markdown 权限并返回元数据，不读取正文。 */
async function getMarkdownState(uid, targetPath, { signal } = {}) {
  return withLockedMarkdown(
    uid,
    targetPath,
    { signal },
    async ({ probe, opened }) => {
      const precise = await preciseStat(probe.fh);
      if (!preciseMatchesOpened(precise, opened.stat)) {
        throw securityError(
          '目标在读取元数据期间发生变化',
          'FILE_CHANGED_DURING_STATE_READ',
          409,
        );
      }
      const recovery = await getRecoveryDiagnostics(
        uid,
        opened.actualPath,
        precise,
      );
      const writable = await canWriteOpenedMarkdown(opened, precise);
      return {
        actualPath: opened.actualPath,
        size: opened.stat.size,
        mtime: opened.stat.mtimeMs,
        ctime: opened.stat.ctimeMs,
        revision: revisionFromStat(precise),
        writable,
        ...(recovery ? { recovery } : {}),
      };
    },
  );
}


function assertValidSaveRequest(targetPath, content, expectedRevision) {
  assertAbsolutePath(targetPath, 'Markdown 文稿路径');
  if (!isMarkdownPath(targetPath)) {
    throw securityError(
      '仅支持保存 .md / .markdown / .mdx 文件',
      'UNSUPPORTED_DOCUMENT_TYPE',
      400,
    );
  }
  if (typeof content !== 'string') {
    throw securityError('content 必须是字符串', 'INVALID_CONTENT', 400);
  }
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw securityError('content 包含无效 Unicode', 'INVALID_UTF8', 422);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw securityError('content 包含无效 Unicode', 'INVALID_UTF8', 422);
    }
  }
  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_FILE_BYTES) {
    throw securityError(
      `文件过大，保存上限为 ${MAX_FILE_BYTES / 1024 / 1024} MiB`,
      'FILE_TOO_LARGE',
      413,
    );
  }
  if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
    throw securityError(
      'expectedRevision 必须是读取接口返回的有效 revision',
      'INVALID_EXPECTED_REVISION',
      400,
    );
  }
  return data;
}

function fileConflict(message, currentRevision = null, reason = 'FILE_CONFLICT') {
  const err = securityError(message, reason, 409);
  if (currentRevision) err.currentRevision = currentRevision;
  return err;
}

async function assertRequestedPathStable(requestedPath, expectedActualPath, kind) {
  let current;
  try {
    current = await fs.realpath(requestedPath);
  } catch {
    throw fileConflict(`${kind}在保存期间已消失`, null, 'PATH_CHANGED_DURING_SAVE');
  }
  if (path.resolve(current) !== path.resolve(expectedActualPath)) {
    throw fileConflict(`${kind}或其祖先在保存期间已发生变化`, null, 'PATH_CHANGED_DURING_SAVE');
  }
}

async function assertNoSymlinkBelowAuthorizedRoot(requestedParentPath, parent) {
  const requested = path.resolve(requestedParentPath);
  const candidates = parent.scope.resolvedRoots
    .filter(
      (root) =>
        isInside(path.resolve(root.path), requested) &&
        isInside(root.realPath, parent.opened.actualPath),
    )
    .sort((left, right) => right.path.length - left.path.length);
  if (candidates.length === 0) {
    throw securityError(
      '保存路径必须直接位于应用设置授权目录内',
      'SYMLINK_SAVE_DENIED',
      409,
    );
  }

  const configuredRoot = candidates[0].path;
  const relative = path.relative(path.resolve(configuredRoot), requested);
  let current = configuredRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      throw fileConflict(
        '文稿祖先目录在保存期间发生变化',
        null,
        'PATH_CHANGED_DURING_SAVE',
      );
    }
    if (stat.isSymbolicLink()) {
      throw securityError(
        '为避免祖先目录切换导致保存错位，不支持通过符号链接目录编辑文稿',
        'SYMLINK_SAVE_DENIED',
        409,
      );
    }
  }
}

function configuredRecoveryRoot() {
  if (recoveryRootForTest) return recoveryRootForTest;
  const packageVar =
    process.env.TRIM_PKGVAR ||
    path.join('/var/apps', process.env.TRIM_APPNAME || trimApi.APP_NAME || 'flux-reader', 'var');
  return path.join(packageVar, 'flux-reader-save-recovery');
}

function recoveryBucketName(uid, targetActualPath) {
  return crypto
    .createHash('sha256')
    .update('flux-reader-recovery-bucket-v1\0')
    .update(String(uid))
    .update('\0')
    .update(path.resolve(targetActualPath))
    .digest('hex');
}

async function openStrictPrivateDirectory(directoryPath, { create }) {
  if (create) {
    await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  }

  let before;
  try {
    before = await fs.lstat(directoryPath);
  } catch (err) {
    if (!create && err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw securityError('应用私有恢复路径不是安全目录', 'UNSAFE_RECOVERY_DIRECTORY', 500);
  }
  if (create) await fs.chmod(directoryPath, 0o700);

  const actualPath = await fs.realpath(directoryPath);
  const fh = await openReadOnly(actualPath);
  try {
    const [fdStat, pathStat] = await Promise.all([fh.stat(), fs.stat(actualPath)]);
    if (
      !fdStat.isDirectory() ||
      !sameFileIdentity(fdStat, pathStat) ||
      (fdStat.mode & 0o777) !== 0o700
    ) {
      throw securityError(
        '应用私有恢复目录必须为稳定的 0700 目录',
        'UNSAFE_RECOVERY_DIRECTORY',
        500,
      );
    }
    return { path: actualPath, fh };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

async function openPrivateRecoveryDirectory(
  uid,
  targetActualPath,
  { create = true } = {},
) {
  assertAbsolutePath(targetActualPath, '恢复目标路径');
  const rootPath = configuredRecoveryRoot();
  assertAbsolutePath(rootPath, '应用私有恢复目录');
  let root;
  try {
    root = await openStrictPrivateDirectory(rootPath, { create });
    if (!root) return null;
    const bucketPath = path.join(root.path, recoveryBucketName(uid, targetActualPath));
    const bucket = await openStrictPrivateDirectory(bucketPath, { create });
    if (!bucket) {
      await root.fh.close().catch(() => {});
      return null;
    }
    if (create) await root.fh.sync();
    return { ...bucket, rootFh: root.fh, rootPath: root.path };
  } catch (err) {
    await root?.fh.close().catch(() => {});
    if (err?.status) throw err;
    throw securityError(
      `无法准备应用私有恢复目录: ${err.message}`,
      'RECOVERY_STORAGE_UNAVAILABLE',
      503,
    );
  }
}

async function closePrivateRecoveryDirectory(recovery) {
  await recovery?.fh.close().catch(() => {});
  await recovery?.rootFh.close().catch(() => {});
}

function recoveryFileName(kind, recoveryId) {
  return `${kind}-${recoveryId}.bin`;
}

function recoveryManifestFileName(recoveryId) {
  return `manifest-${recoveryId}.json`;
}

function recoveryArtifactPath(recovery, fileName) {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) {
    throw securityError('恢复工件名称无效', 'RECOVERY_ARTIFACT_INVALID', 500);
  }
  return path.join(recovery.path, fileName);
}

async function createPrivateRecoveryArtifact(recovery, fileName, data) {
  const artifactPath = recoveryArtifactPath(recovery, fileName);
  let fh;
  try {
    fh = await fs.open(artifactPath, TEMP_WRITE_FLAGS, 0o600);
    await fh.chmod(0o600);
    await fh.writeFile(data);
    await fh.sync();
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size !== data.length || (stat.mode & 0o777) !== 0o600) {
      throw securityError('恢复工件校验失败', 'RECOVERY_ARTIFACT_INVALID', 500);
    }
    await fh.close();
    fh = null;
    await recovery.fh.sync();
    return { name: fileName, path: artifactPath };
  } catch (err) {
    await fh?.chmod(0o600).catch(() => {});
    await fh?.close().catch(() => {});
    await fs.unlink(artifactPath).catch(() => {});
    if (err?.status) throw err;
    throw securityError(
      `无法写入应用私有恢复工件: ${err.message}`,
      'RECOVERY_STORAGE_UNAVAILABLE',
      503,
    );
  }
}

async function persistRecoveryManifest(recovery, transaction) {
  const manifestPath = recoveryArtifactPath(
    recovery,
    recoveryManifestFileName(transaction.id),
  );
  const temporaryPath = path.join(
    recovery.path,
    `.manifest-${transaction.id}-${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  const payload = Buffer.from(
    `${JSON.stringify({ ...transaction.manifest, updatedAt: new Date().toISOString() })}\n`,
    'utf8',
  );
  if (payload.length > MAX_RECOVERY_MANIFEST_BYTES) {
    throw securityError('恢复清单超过安全上限', 'RECOVERY_MANIFEST_INVALID', 500);
  }

  let fh;
  try {
    fh = await fs.open(temporaryPath, TEMP_WRITE_FLAGS, 0o600);
    await fh.chmod(0o600);
    await fh.writeFile(payload);
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(temporaryPath, manifestPath);
    await recovery.fh.sync();
    transaction.manifestPath = manifestPath;
  } catch (err) {
    await fh?.chmod(0o600).catch(() => {});
    await fh?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    if (err?.status) throw err;
    throw securityError(
      `无法持久化恢复清单: ${err.message}`,
      'RECOVERY_STORAGE_UNAVAILABLE',
      503,
    );
  }
}

async function updateRecoveryManifest(recovery, transaction, values) {
  Object.assign(transaction.manifest, values);
  await persistRecoveryManifest(recovery, transaction);
}

async function createRecoveryTransaction({
  recovery,
  uid,
  target,
  targetPath,
  baseline,
  baselineRevision,
  data,
}) {
  const id = crypto.randomBytes(24).toString('hex');
  const baselineName = recoveryFileName('baseline', id);
  const attemptedName = recoveryFileName('attempted', id);
  const observedName = recoveryFileName('observed', id);
  const transaction = {
    id,
    baselineArtifact: null,
    attemptedArtifact: null,
    observedArtifact: null,
    manifestPath: null,
    manifest: {
      version: RECOVERY_MANIFEST_VERSION,
      recoveryId: id,
      uid: String(uid),
      requestedPath: path.resolve(targetPath),
      actualPath: path.resolve(target.opened.actualPath),
      targetDev: String(target.opened.stat.dev),
      targetIno: String(target.opened.stat.ino),
      targetUid: target.opened.stat.uid,
      targetGid: target.opened.stat.gid,
      targetMode: target.opened.stat.mode,
      reservedBytes:
        baseline.data.length +
        data.length +
        MAX_RECOVERY_BASELINE_BYTES +
        MAX_RECOVERY_MANIFEST_BYTES * 4,
      baselineRevision,
      baselineSha256: crypto.createHash('sha256').update(baseline.data).digest('hex'),
      attemptedSha256: crypto.createHash('sha256').update(data).digest('hex'),
      baselineArtifact: baselineName,
      attemptedArtifact: attemptedName,
      observedArtifact: observedName,
      transactionRevision: null,
      phase: 'allocating',
      createdAt: new Date().toISOString(),
    },
  };

  // 清单先于任何正文工件落盘。即使进程在下一步崩溃，也不会留下无法关联的
  // 随机正文；manifest 会明确记录缺失工件和目标 uid/path/inode。
  activeRecoveryIds.add(id);
  try {
    return await withSaveLock('recovery-quota:global', async () => {
      await assertRecoveryCapacity(
        recovery,
        transaction.manifest.reservedBytes,
        uid,
      );
      await persistRecoveryManifest(recovery, transaction);
      try {
        transaction.baselineArtifact = await createPrivateRecoveryArtifact(
          recovery,
          baselineName,
          baseline.data,
        );
        transaction.attemptedArtifact = await createPrivateRecoveryArtifact(
          recovery,
          attemptedName,
          data,
        );
        await updateRecoveryManifest(recovery, transaction, { phase: 'prepared' });
        return transaction;
      } catch (err) {
        await fs.unlink(transaction.attemptedArtifact?.path || '').catch(() => {});
        await fs.unlink(transaction.baselineArtifact?.path || '').catch(() => {});
        await fs.unlink(transaction.manifestPath || '').catch(() => {});
        await recovery.fh.sync().catch(() => {});
        throw err;
      }
    });
  } catch (err) {
    activeRecoveryIds.delete(id);
    throw err;
  }
}

async function removeRecoveryTransaction(
  recovery,
  transaction,
  { commitCleanup = false } = {},
) {
  try {
    for (const artifact of [
      transaction.observedArtifact,
      transaction.attemptedArtifact,
      transaction.baselineArtifact,
    ]) {
      if (artifact?.path) await fs.unlink(artifact.path).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
    if (transaction.manifestPath) {
      await fs.unlink(transaction.manifestPath).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
    if (commitCleanup) await saveHooksForTest?.cleanupRecoverySync?.();
    await recovery.fh.sync();
    const remaining = await fs.readdir(recovery.path);
    if (remaining.length === 0) {
      await fs.rmdir(recovery.path);
      await recovery.rootFh.sync();
    }
    return true;
  } catch {
    // verified commit 之后的清理只能 best effort。即使 unlink/fsync 失败，
    // 也绝不能再改动已提交的用户文件。
    return false;
  }
}

async function artifactAvailability(recovery, fileName) {
  try {
    const artifactPath = recoveryArtifactPath(recovery, fileName);
    const stat = await fs.lstat(artifactPath);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o600
    );
  } catch {
    return false;
  }
}

async function readPrivateManifest(recovery, fileName) {
  const manifestPath = recoveryArtifactPath(recovery, fileName);
  let fh;
  try {
    fh = await fs.open(
      manifestPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const stat = await fh.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_RECOVERY_MANIFEST_BYTES ||
      (stat.mode & 0o777) !== 0o600
    ) {
      return null;
    }
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await fh.read(data, offset, stat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) return null;
    return JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function purgeExpiredRecoveryBucket(bucketPath) {
  const now = Date.now();
  const entries = await fs.readdir(bucketPath, { withFileTypes: true });
  const activeIds = new Set();
  let changed = false;

  for (const entry of entries) {
    const match = RECOVERY_MANIFEST_NAME.exec(entry.name);
    if (!match) continue;
    const manifest = await readPrivateManifest({ path: bucketPath }, entry.name);
    const timestamp = Date.parse(manifest?.updatedAt || manifest?.createdAt || '');
    if (
      activeRecoveryIds.has(match[1]) ||
      (Number.isFinite(timestamp) && now - timestamp <= RECOVERY_RETENTION_MS)
    ) {
      activeIds.add(match[1]);
      continue;
    }
    for (const fileName of [
      recoveryFileName('observed', match[1]),
      recoveryFileName('attempted', match[1]),
      recoveryFileName('baseline', match[1]),
      entry.name,
    ]) {
      await fs.unlink(path.join(bucketPath, fileName)).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
    changed = true;
  }

  // 清除超过保留期且已没有 manifest 的已知格式孤儿；永不触碰未知文件。
  for (const entry of entries) {
    const manifestTemp = /^\.manifest-[a-f0-9]{48}-[a-f0-9]{24}\.tmp$/u.test(
      entry.name,
    );
    const match = /^(baseline|attempted|observed)-([a-f0-9]{48})\.bin$/u.exec(
      entry.name,
    );
    if (!manifestTemp && (!match || activeIds.has(match[2]))) continue;
    const itemPath = path.join(bucketPath, entry.name);
    const stat = await fs.lstat(itemPath);
    if (now - stat.mtimeMs > RECOVERY_RETENTION_MS) {
      await fs.unlink(itemPath);
      changed = true;
    }
  }
  if (changed) {
    const fh = await openReadOnly(bucketPath);
    try {
      await fh.sync();
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

async function inspectRecoveryBucketUsage(bucketPath) {
  await purgeExpiredRecoveryBucket(bucketPath);
  const entries = await fs.readdir(bucketPath, { withFileTypes: true });
  let bytes = 0;
  let reservedBytes = 0;
  let transactions = 0;
  const manifests = [];
  for (const entry of entries) {
    const itemPath = path.join(bucketPath, entry.name);
    const stat = await fs.lstat(itemPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw securityError(
        '恢复目录包含不安全工件',
        'UNSAFE_RECOVERY_DIRECTORY',
        500,
      );
    }
    bytes += stat.size;
    const match = RECOVERY_MANIFEST_NAME.exec(entry.name);
    if (!match) continue;
    transactions += 1;
    const manifest = await readPrivateManifest({ path: bucketPath }, entry.name);
    const reservation = Number(manifest?.reservedBytes);
    const safeReservation =
      Number.isFinite(reservation) && reservation >= 0
        ? reservation
        : MAX_RECOVERY_TRANSACTION_BYTES;
    reservedBytes += safeReservation;
    manifests.push({
      uid: typeof manifest?.uid === 'string' ? manifest.uid : null,
      reservedBytes: safeReservation,
    });
  }
  return { bytes, reservedBytes, transactions, manifests };
}

async function assertRecoveryCapacity(recovery, reservationBytes, uid) {
  const rootEntries = await fs.readdir(recovery.rootPath, { withFileTypes: true });
  await saveHooksForTest?.afterRecoveryRootList?.({
    recoveryRoot: recovery.rootPath,
    currentBucket: recovery.path,
    entries: rootEntries.map((entry) => entry.name),
  });
  let globalBytes = 0;
  let globalTransactions = 0;
  let uidBytes = 0;
  let uidTransactions = 0;
  let targetUsage = null;

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
      throw securityError(
        '应用恢复根目录包含不安全条目',
        'UNSAFE_RECOVERY_DIRECTORY',
        500,
      );
    }
    const bucketPath = path.join(recovery.rootPath, entry.name);
    try {
      const stat = await fs.lstat(bucketPath);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o700
      ) {
        throw securityError(
          '应用恢复分区权限不安全',
          'UNSAFE_RECOVERY_DIRECTORY',
          500,
        );
      }
      const usage = await inspectRecoveryBucketUsage(bucketPath);
      const chargedBytes = Math.max(usage.bytes, usage.reservedBytes);
      globalBytes += chargedBytes;
      globalTransactions += usage.transactions;
      for (const manifest of usage.manifests) {
        if (manifest.uid === String(uid)) {
          uidTransactions += 1;
          uidBytes += manifest.reservedBytes;
        }
      }
      if (path.resolve(bucketPath) === path.resolve(recovery.path)) {
        targetUsage = usage;
      } else if (
        usage.transactions === 0 &&
        (await fs.readdir(bucketPath)).length === 0
      ) {
        await fs.rmdir(bucketPath).catch(() => {});
      }
    } catch (err) {
      // 另一个已提交事务删除空 bucket 只会释放配额；root readdir 与本次
      // 检查之间的 ENOENT 是安全竞态，不能把无关文稿保存误报为 500。
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
  }
  targetUsage ||= { bytes: 0, reservedBytes: 0, transactions: 0 };

  if (
    targetUsage.transactions + 1 > MAX_RECOVERY_TRANSACTIONS_PER_TARGET ||
    Math.max(targetUsage.bytes, targetUsage.reservedBytes) + reservationBytes >
      MAX_RECOVERY_BYTES_PER_TARGET ||
    uidTransactions + 1 > MAX_RECOVERY_TRANSACTIONS_PER_UID ||
    uidBytes + reservationBytes > MAX_RECOVERY_BYTES_PER_UID ||
    globalTransactions + 1 > MAX_RECOVERY_TRANSACTIONS_GLOBAL ||
    globalBytes + reservationBytes > MAX_RECOVERY_BYTES_GLOBAL
  ) {
    throw securityError(
      '恢复空间已达到安全上限，请先处理现有恢复记录',
      'RECOVERY_QUOTA_EXCEEDED',
      507,
    );
  }
  await recovery.rootFh.sync();
}

async function cleanupExpiredRecoveries() {
  const rootPath = configuredRecoveryRoot();
  assertAbsolutePath(rootPath, '应用私有恢复目录');
  const root = await openStrictPrivateDirectory(rootPath, { create: false });
  if (!root) return { removedBuckets: 0 };
  let removedBuckets = 0;
  try {
    const entries = await fs.readdir(root.path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
        throw securityError(
          '应用恢复根目录包含不安全条目',
          'UNSAFE_RECOVERY_DIRECTORY',
          500,
        );
      }
      const bucketPath = path.join(root.path, entry.name);
      const stat = await fs.lstat(bucketPath);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o700
      ) {
        throw securityError(
          '应用恢复分区权限不安全',
          'UNSAFE_RECOVERY_DIRECTORY',
          500,
        );
      }
      await purgeExpiredRecoveryBucket(bucketPath);
      if ((await fs.readdir(bucketPath)).length === 0) {
        await fs.rmdir(bucketPath);
        removedBuckets += 1;
      }
    }
    await root.fh.sync();
    return { removedBuckets };
  } finally {
    await root.fh.close().catch(() => {});
  }
}


async function getRecoveryDiagnostics(uid, targetActualPath, currentIdentity) {
  let recovery;
  try {
    recovery = await openPrivateRecoveryDirectory(uid, targetActualPath, {
      create: false,
    });
    if (!recovery) return null;
    const entries = await fs.readdir(recovery.path);
    const records = [];
    for (const entry of entries) {
      const match = RECOVERY_MANIFEST_NAME.exec(entry);
      if (!match) continue;
      const manifest = await readPrivateManifest(recovery, entry);
      if (
        !manifest ||
        manifest.version !== RECOVERY_MANIFEST_VERSION ||
        manifest.recoveryId !== match[1] ||
        manifest.uid !== String(uid) ||
        path.resolve(manifest.actualPath || '') !== path.resolve(targetActualPath)
      ) {
        continue;
      }
      const targetMatches =
        String(currentIdentity.dev) === String(manifest.targetDev) &&
        String(currentIdentity.ino) === String(manifest.targetIno) &&
        String(currentIdentity.uid) === String(manifest.targetUid) &&
        String(currentIdentity.gid) === String(manifest.targetGid) &&
        String(currentIdentity.mode) === String(manifest.targetMode);
      records.push({
        recoveryId: manifest.recoveryId,
        phase: manifest.phase,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        baselineRevision: manifest.baselineRevision,
        targetMatches,
        baselineAvailable: await artifactAvailability(
          recovery,
          manifest.baselineArtifact,
        ) && REVISION_PATTERN.test(manifest.baselineSha256 || ''),
        attemptedAvailable: await artifactAvailability(
          recovery,
          manifest.attemptedArtifact,
        ) && REVISION_PATTERN.test(manifest.attemptedSha256 || ''),
        observedAvailable: await artifactAvailability(
          recovery,
          manifest.observedArtifact,
        ) && REVISION_PATTERN.test(manifest.observedSha256 || ''),
        currentMatchesAttempt:
          targetMatches &&
          Boolean(manifest.transactionRevision) &&
          revisionFromStat(currentIdentity) === manifest.transactionRevision,
        inProgress: activeRecoveryIds.has(manifest.recoveryId),
      });
    }
    if (records.length === 0) return null;
    records.sort((left, right) =>
      String(right.updatedAt || right.createdAt).localeCompare(
        String(left.updatedAt || left.createdAt),
      ),
    );
    return { available: true, records };
  } catch {
    // 恢复诊断不可用不应把一个仍可读取的文稿伪装成 5xx；下一次保存仍会
    // 要求私有恢复目录可用并 fail closed。
    return { available: false, diagnosticsUnavailable: true };
  } finally {
    await closePrivateRecoveryDirectory(recovery);
  }
}

async function loadRecoveryManifestForTarget(
  recovery,
  uid,
  targetActualPath,
  recoveryId,
  { currentIdentity = null, requireIdentity = false } = {},
) {
  if (typeof recoveryId !== 'string' || !/^[a-f0-9]{48}$/u.test(recoveryId)) {
    throw securityError('recoveryId 无效', 'INVALID_RECOVERY_ID', 400);
  }
  if (activeRecoveryIds.has(recoveryId)) {
    throw securityError(
      '保存事务仍在进行，暂不能读取或丢弃该恢复记录',
      'RECOVERY_IN_PROGRESS',
      409,
    );
  }
  const fileName = recoveryManifestFileName(recoveryId);
  const manifest = await readPrivateManifest(recovery, fileName);
  if (
    !manifest ||
    manifest.version !== RECOVERY_MANIFEST_VERSION ||
    manifest.recoveryId !== recoveryId ||
    manifest.uid !== String(uid) ||
    path.resolve(manifest.actualPath || '') !== path.resolve(targetActualPath) ||
    manifest.baselineArtifact !== recoveryFileName('baseline', recoveryId) ||
    manifest.attemptedArtifact !== recoveryFileName('attempted', recoveryId) ||
    manifest.observedArtifact !== recoveryFileName('observed', recoveryId)
  ) {
    throw securityError('恢复记录不存在或不属于当前文稿', 'RECOVERY_NOT_FOUND', 404);
  }
  if (
    requireIdentity &&
    (!currentIdentity ||
      String(currentIdentity.dev) !== String(manifest.targetDev) ||
      String(currentIdentity.ino) !== String(manifest.targetIno) ||
      String(currentIdentity.uid) !== String(manifest.targetUid) ||
      String(currentIdentity.gid) !== String(manifest.targetGid) ||
      String(currentIdentity.mode) !== String(manifest.targetMode))
  ) {
    throw securityError(
      '当前路径已指向另一份文稿，不能读取旧 inode 的恢复正文',
      'RECOVERY_TARGET_CHANGED',
      409,
    );
  }
  return manifest;
}

async function readPrivateRecoveryArtifact(
  recovery,
  fileName,
  expectedSha256,
  maximumBytes = MAX_RECOVERY_BASELINE_BYTES,
) {
  if (typeof expectedSha256 !== 'string' || !REVISION_PATTERN.test(expectedSha256)) {
    throw securityError('恢复正文缺少完整性校验', 'RECOVERY_ARTIFACT_INVALID', 409);
  }
  const artifactPath = recoveryArtifactPath(recovery, fileName);
  let fh;
  try {
    fh = await fs.open(
      artifactPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const stat = await fh.stat();
    if (
      !stat.isFile() ||
      stat.size > maximumBytes ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw securityError('恢复正文工件无效', 'RECOVERY_ARTIFACT_INVALID', 409);
    }
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await fh.read(data, offset, stat.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      throw securityError('恢复正文读取不完整', 'RECOVERY_ARTIFACT_INVALID', 409);
    }
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    if (sha256 !== expectedSha256) {
      throw securityError('恢复正文校验失败', 'RECOVERY_ARTIFACT_INVALID', 409);
    }
    return { data, size: stat.size, sha256 };
  } catch (err) {
    if (err?.status) throw err;
    if (err?.code === 'ENOENT') {
      throw securityError('恢复正文不存在', 'RECOVERY_NOT_FOUND', 404);
    }
    throw securityError('无法读取恢复正文', 'RECOVERY_READ_FAILED', 500);
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function readPrivateRecoveryContent(
  recovery,
  fileName,
  expectedSha256,
  maximumBytes = MAX_RECOVERY_BASELINE_BYTES,
) {
  const artifact = await readPrivateRecoveryArtifact(
    recovery,
    fileName,
    expectedSha256,
    maximumBytes,
  );
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(artifact.data);
  } catch {
    throw securityError('恢复正文不是有效 UTF-8', 'INVALID_UTF8', 422);
  }
  return { content, size: artifact.size, sha256: artifact.sha256 };
}

async function getRecoveryState(uid, targetPath, { signal } = {}) {
  return withLockedMarkdown(
    uid,
    targetPath,
    { signal },
    async ({ opened, currentIdentity }) =>
      (await getRecoveryDiagnostics(uid, opened.actualPath, currentIdentity)) || {
        available: false,
        records: [],
      },
  );
}

async function readRecoveryVersion(
  uid,
  targetPath,
  recoveryId,
  version,
  { signal } = {},
) {
  const supported = new Set(['baseline', 'attempted', 'observed']);
  if (!supported.has(version)) {
    throw securityError(
      'version 必须是 baseline、attempted 或 observed',
      'INVALID_RECOVERY_VERSION',
      400,
    );
  }
  return withLockedMarkdown(
    uid,
    targetPath,
    { signal },
    async ({ opened, currentIdentity }) => {
      const recovery = await openPrivateRecoveryDirectory(
        uid,
        opened.actualPath,
        { create: false },
      );
      if (!recovery) {
        throw securityError('恢复记录不存在', 'RECOVERY_NOT_FOUND', 404);
      }
      try {
        const manifest = await loadRecoveryManifestForTarget(
          recovery,
          uid,
          opened.actualPath,
          recoveryId,
          { currentIdentity, requireIdentity: true },
        );
        const field = `${version}Artifact`;
        const hashField = `${version}Sha256`;
        const result = await readPrivateRecoveryContent(
          recovery,
          manifest[field],
          manifest[hashField],
          MAX_RECOVERY_BASELINE_BYTES,
        );
        return {
          recoveryId,
          version,
          phase: manifest.phase,
          ...result,
        };
      } finally {
        await closePrivateRecoveryDirectory(recovery);
      }
    },
  );
}

function assertValidRecoveryCommitRequest(
  targetPath,
  recoveryId,
  version,
  expectedRevision,
) {
  assertAbsolutePath(targetPath, 'Markdown 文稿路径');
  if (!isMarkdownPath(targetPath)) {
    throw securityError(
      '仅支持恢复 .md / .markdown / .mdx 文件',
      'UNSUPPORTED_DOCUMENT_TYPE',
      400,
    );
  }
  if (typeof recoveryId !== 'string' || !/^[a-f0-9]{48}$/u.test(recoveryId)) {
    throw securityError('recoveryId 无效', 'INVALID_RECOVERY_ID', 400);
  }
  if (!new Set(['baseline', 'attempted', 'observed']).has(version)) {
    throw securityError(
      'version 必须是 baseline、attempted 或 observed',
      'INVALID_RECOVERY_VERSION',
      400,
    );
  }
  if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
    throw securityError(
      'expectedRevision 必须是 file-state 返回的有效 revision',
      'INVALID_EXPECTED_REVISION',
      400,
    );
  }
}

async function readRecoveryArtifactForCommit(
  uid,
  target,
  currentTarget,
  recoveryId,
  version,
  signal,
) {
  throwIfAborted(signal);
  const currentIdentity = await preciseStat(target.fh);
  if (!preciseMatchesOpened(currentIdentity, currentTarget.stat)) {
    throw fileConflict(
      '文稿在读取恢复工件前发生变化，请重新读取 file-state',
      revisionFromStat(currentIdentity),
    );
  }
  const recovery = await openPrivateRecoveryDirectory(
    uid,
    target.opened.actualPath,
    { create: false },
  );
  if (!recovery) {
    throw securityError('恢复记录不存在', 'RECOVERY_NOT_FOUND', 404);
  }
  try {
    const manifest = await loadRecoveryManifestForTarget(
      recovery,
      uid,
      target.opened.actualPath,
      recoveryId,
      { currentIdentity, requireIdentity: true },
    );
    const artifact = await readPrivateRecoveryArtifact(
      recovery,
      manifest[`${version}Artifact`],
      manifest[`${version}Sha256`],
      MAX_RECOVERY_BASELINE_BYTES,
    );
    throwIfAborted(signal);
    return artifact.data;
  } finally {
    await closePrivateRecoveryDirectory(recovery);
  }
}

async function discardRecovery(uid, targetPath, recoveryId, { signal } = {}) {
  return withLockedMarkdown(
    uid,
    targetPath,
    { signal },
    async ({ opened }) => {
      const recovery = await openPrivateRecoveryDirectory(
        uid,
        opened.actualPath,
        { create: false },
      );
      if (!recovery) {
        throw securityError('恢复记录不存在', 'RECOVERY_NOT_FOUND', 404);
      }
      try {
        await loadRecoveryManifestForTarget(
          recovery,
          uid,
          opened.actualPath,
          recoveryId,
        );
        for (const fileName of [
          recoveryFileName('observed', recoveryId),
          recoveryFileName('attempted', recoveryId),
          recoveryFileName('baseline', recoveryId),
          recoveryManifestFileName(recoveryId),
        ]) {
          await fs.unlink(recoveryArtifactPath(recovery, fileName)).catch((err) => {
            if (err?.code !== 'ENOENT') throw err;
          });
        }
        await recovery.fh.sync();
        if ((await fs.readdir(recovery.path)).length === 0) {
          await fs.rmdir(recovery.path);
          await recovery.rootFh.sync();
        }
        return { recoveryId, discarded: true };
      } finally {
        await closePrivateRecoveryDirectory(recovery);
      }
    },
  );
}

async function writeBufferToStableFile(
  fh,
  data,
  { runHooks = false } = {},
) {
  await fh.truncate(0);
  if (runHooks) await saveHooksForTest?.afterTruncate?.();
  let written = 0;
  while (written < data.length) {
    const result = await fh.write(data, written, data.length - written, written);
    if (!result.bytesWritten) {
      throw securityError('写入 Markdown 时没有取得进展', 'FILE_WRITE_STALLED', 500);
    }
    written += result.bytesWritten;
  }
  if (runHooks) await saveHooksForTest?.afterWrite?.();
  await fh.sync();
  return preciseStat(fh);
}

async function readCurrentStableBytes(fh, limit, kind) {
  const stat = await fh.stat();
  return readStableBounded(fh, stat, limit, {
    changedReason: 'FILE_CHANGED_DURING_SAVE',
    tooLargeReason: 'FILE_TOO_LARGE',
    kind,
  });
}

function isStaleSaveTargetError(err) {
  return [
    'PATH_CHANGED_DURING_AUTHORIZATION',
    'OPENED_FD_RESOLUTION_FAILED',
    'PATH_CHANGED_DURING_OPEN',
    'PATH_CHANGED_DURING_SAVE',
  ].includes(err?.reason);
}

function mapInPlaceSaveError(err) {
  if (err?.status) return err;
  if (['EACCES', 'EPERM', 'EROFS'].includes(err?.code)) {
    return securityError('保存时存储拒绝写入', 'STORAGE_WRITE_DENIED', 403);
  }
  if (['ENOSPC', 'EDQUOT'].includes(err?.code)) {
    return securityError('保存失败：存储空间不足', 'STORAGE_FULL', 507);
  }
  if (['EMFILE', 'ENFILE', 'ENOMEM', 'ESTALE', 'EBUSY', 'ETIMEDOUT'].includes(err?.code)) {
    return securityError('保存时存储暂不可用', 'STORAGE_WRITE_UNAVAILABLE', 503);
  }
  return securityError('保存时发生存储错误', 'STORAGE_WRITE_FAILED', 500);
}

async function performInPlaceSave({
  uid,
  targetPath,
  parentPath,
  parent,
  target,
  baseline,
  baselineRevision,
  data,
  signal,
  maximumDocumentBytes = MAX_FILE_BYTES,
  includeContent = true,
}) {
  const originalIdentity = await preciseStat(target.fh);
  const originalMode = target.opened.stat.mode;
  const originalUid = target.opened.stat.uid;
  const originalGid = target.opened.stat.gid;
  const recovery = await openPrivateRecoveryDirectory(
    uid,
    target.opened.actualPath,
  );
  let transaction;
  let writeStarted = false;
  let transactionRevision = null;

  try {
    transaction = await createRecoveryTransaction({
      recovery,
      uid,
      target,
      targetPath,
      baseline,
      baselineRevision,
      data,
    });
    throwIfAborted(signal);
    const finalTarget = await authorizeOpenedTarget(
      uid,
      target.fh,
      target.requestedPath,
      target.scope,
      'Markdown 文稿',
    );
    if (!finalTarget.acl?.writable) {
      throw securityError('当前用户无权写入 Markdown 文稿', 'USER_ACL_WRITE_DENIED', 403);
    }
    await authorizeOpenedTarget(
      uid,
      parent.fh,
      parent.requestedPath,
      parent.scope,
      '父目录',
    );
    await assertRequestedPathStable(parentPath, parent.opened.actualPath, '父目录');
    await assertRequestedPathStable(targetPath, target.opened.actualPath, 'Markdown 文稿');
    await assertNoSymlinkBelowAuthorizedRoot(parentPath, parent);
    const finalParentVersion = await preciseStat(parent.fh);
    const finalVersion = await preciseStat(target.fh);
    if (revisionFromStat(finalVersion) !== baselineRevision) {
      throw fileConflict(
        '文稿已被外部修改，请重新加载后再保存',
        revisionFromStat(finalVersion),
      );
    }

    await saveHooksForTest?.afterFinalCheck?.({ originalPath: targetPath });
    throwIfAborted(signal);

    // Hook 后重做 ACL、授权根、父目录与 revision 检查。POSIX 没有跨进程
    // 内容 CAS；真正的外部 SMB writer 仍可能在下一条 truncate 前介入。
    const checkedTarget = await authorizeOpenedTarget(
      uid,
      target.fh,
      target.requestedPath,
      target.scope,
      'Markdown 文稿',
    );
    if (!checkedTarget.acl?.writable) {
      throw securityError('当前用户无权写入 Markdown 文稿', 'USER_ACL_WRITE_DENIED', 403);
    }
    await authorizeOpenedTarget(
      uid,
      parent.fh,
      parent.requestedPath,
      parent.scope,
      '父目录',
    );
    const checkedVersion = await preciseStat(target.fh);
    const checkedParentVersion = await preciseStat(parent.fh);
    if (
      revisionFromStat(checkedVersion) !== baselineRevision ||
      !samePreciseVersion(finalParentVersion, checkedParentVersion)
    ) {
      throw fileConflict('文稿或父目录在提交瞬间发生变化，请重新加载后再保存');
    }
    await assertRequestedPathStable(targetPath, target.opened.actualPath, 'Markdown 文稿');

    // 进入 truncate 之后必须完成 fsync/校验或落 recovery；只在 mutation 前
    // 最后响应取消，避免用户已取消的请求仍开始改写正文。
    throwIfAborted(signal);
    await updateRecoveryManifest(recovery, transaction, { phase: 'writing' });
    throwIfAborted(signal);
    writeStarted = true;
    const transactionVersion = await writeBufferToStableFile(target.fh, data, {
      runHooks: true,
    });
    transactionRevision = revisionFromStat(transactionVersion);
    await updateRecoveryManifest(recovery, transaction, {
      phase: 'written',
      transactionRevision,
    });
    await saveHooksForTest?.afterPublish?.({ originalPath: targetPath });

    const saved = await readCurrentStableBytes(
      target.fh,
      maximumDocumentBytes,
      '已保存文稿',
    );
    if (
      !saved.data.equals(data) ||
      revisionFromStat(saved.preciseStat) !== transactionRevision
    ) {
      throw fileConflict('保存结果被并发修改，请重新加载', null, 'FILE_CONFLICT');
    }
    const committedStat = await target.fh.stat();
    if (
      !sameFileIdentity(originalIdentity, committedStat) ||
      committedStat.uid !== originalUid ||
      committedStat.gid !== originalGid ||
      committedStat.mode !== originalMode
    ) {
      throw fileConflict(
        '原 inode 安全元数据在保存期间发生变化',
        null,
        'FILE_CONFLICT',
      );
    }
    await assertFdMatchesPath(target.fh, target.opened.actualPath);
    await assertRequestedPathStable(targetPath, target.opened.actualPath, 'Markdown 文稿');
    const commitVersion = await preciseStat(target.fh);
    if (revisionFromStat(commitVersion) !== transactionRevision) {
      throw fileConflict('保存结果在提交边界前再次发生变化，请重新加载');
    }

    // 内容、transaction revision、inode 元数据和 pathname 全部验证完成即为
    // commit boundary。之后只更新/清理私有 journal，任何错误均返回保存成功。
    const result = {
      ...(includeContent ? { content: data.toString('utf8') } : {}),
      actualPath: target.opened.actualPath,
      size: saved.stat.size,
      mtime: saved.stat.mtimeMs,
      ctime: saved.stat.ctimeMs,
      revision: transactionRevision,
      saveSemantics: 'in-place-recoverable',
      externalAtomicity: 'non-atomic-to-external-readers',
    };
    let cleanupPending = false;
    try {
      await updateRecoveryManifest(recovery, transaction, { phase: 'committed' });
      cleanupPending = !(await removeRecoveryTransaction(
        recovery,
        transaction,
        { commitCleanup: true },
      ));
    } catch {
      cleanupPending = true;
    }
    if (cleanupPending) result.recoveryCleanupPending = true;
    return result;
  } catch (caught) {
    let err = mapInPlaceSaveError(caught);
    if (isStaleSaveTargetError(err)) {
      const conflict = fileConflict('文稿路径已被另一个进程替换，请重新加载');
      conflict.cause = err;
      err = conflict;
    }

    if (!writeStarted) {
      const cleaned = transaction
        ? await removeRecoveryTransaction(recovery, transaction)
        : true;
      if (!cleaned && transaction) {
        err.recoveryRequired = true;
        err.recovery = {
          available: true,
          recoveryId: transaction.id,
          phase: transaction.manifest.phase,
        };
      }
      throw err;
    }

    // 请求草稿永远单独保存。若稳定 fd 已被外部 writer 修改，再额外保存
    // observed 副本，但绝不把它误标为本次 attempted。
    if (!transaction.attemptedArtifact) {
      try {
        transaction.attemptedArtifact = await createPrivateRecoveryArtifact(
          recovery,
          transaction.manifest.attemptedArtifact,
          data,
        );
      } catch {
        // baseline + manifest 仍可诊断；前端也继续持有草稿。
      }
    }

    let observed = null;
    try {
      observed = await readCurrentStableBytes(
        target.fh,
        maximumDocumentBytes,
        '失败现场',
      );
      if (
        !observed.data.equals(data) ||
        !transactionRevision ||
        revisionFromStat(observed.preciseStat) !== transactionRevision
      ) {
        transaction.observedArtifact = await createPrivateRecoveryArtifact(
          recovery,
          transaction.manifest.observedArtifact,
          observed.data,
        ).catch(() => null);
        if (transaction.observedArtifact) {
          transaction.manifest.observedSha256 = crypto
            .createHash('sha256')
            .update(observed.data)
            .digest('hex');
        }
      }
    } catch {
      observed = null;
    }

    // mutation 开始后，后端绝不再自动改写目标 inode。即使失败现场此刻仍
    // 精确等于本事务写入，也无法排除另一个 fd 在检查后、回写 baseline 前
    // 插入合法写入。baseline / attempted / observed 只保存在应用私有目录；
    // 用户恢复时必须重新读取 file-state，并通过专用的
    // recovery-commit 端点以 revision CAS 提交服务端私有工件。
    await saveHooksForTest?.afterFailureObserved?.({ originalPath: targetPath });
    const recoveryPhase = 'recovery-required';
    await updateRecoveryManifest(recovery, transaction, {
      phase: recoveryPhase,
      failureReason: err.reason || 'SAVE_FAILED',
      observedRevision: observed
        ? revisionFromStat(observed.preciseStat)
        : null,
    }).catch(() => {});

    err.recoveryRequired = true;
    err.recovery = {
      available: true,
      recoveryId: transaction.id,
      phase: recoveryPhase,
    };
    if (!err.reason || err.reason === 'STORAGE_WRITE_FAILED') {
      err.reason = 'SAVE_RECOVERY_REQUIRED';
      err.status = 409;
    }
    throw err;
  } finally {
    if (transaction) activeRecoveryIds.delete(transaction.id);
    await closePrivateRecoveryDirectory(recovery);
  }
}


/**
 * 保存一个已经存在的 Markdown 文稿；使用原 inode 写回以保留 fnOS/Windows
 * ACL、owner/group、xattr。该方案对其他进程的读取不是原子替换，崩溃窗口由
 * 应用私有 0700 目录中的 0600 baseline 提供人工恢复，不在共享目录落工件。
 */
async function saveMarkdownBuffer(
  uid,
  targetPath,
  initialData,
  expectedRevision,
  {
    signal,
    recoverySource = null,
    maximumDocumentBytes = MAX_FILE_BYTES,
    includeContent = true,
  } = {},
) {
  throwIfAborted(signal);
  let data = initialData;
  const parentPath = path.dirname(targetPath);
  const baseName = path.basename(targetPath);

  return withLockedMarkdown(
    uid,
    targetPath,
    { signal },
    async ({ probe, currentIdentity: lockedIdentity }) => {
      const parent = await openAuthorizedTarget(uid, parentPath, {
        kind: '父目录',
        expectedType: 'dir',
      });
      let target;
      try {
        await assertNoSymlinkBelowAuthorizedRoot(parentPath, parent);
        const stableTargetPath = path.join(parent.opened.ioPath, baseName);
        target = await openAuthorizedTarget(uid, stableTargetPath, {
          kind: 'Markdown 文稿',
          expectedType: 'file',
          markdownOnly: true,
          authorizationPath: targetPath,
          writeAccess: true,
        });
        if (!sameFileIdentity(lockedIdentity, target.opened.stat)) {
          throw fileConflict('文稿在取得写锁后已被替换，请重新加载');
        }
        if (!sameFileIdentity(await preciseStat(probe.fh), await preciseStat(target.fh))) {
          throw fileConflict('Markdown 读写描述符未绑定同一文稿');
        }

        const expectedDirectPath = path.join(parent.opened.actualPath, baseName);
        if (path.resolve(target.opened.actualPath) !== path.resolve(expectedDirectPath)) {
          throw securityError(
            '为避免保存到软链接的意外目标，不支持直接编辑符号链接文稿',
            'SYMLINK_SAVE_DENIED',
            409,
          );
        }
        if (!target.opened.acl?.writable) {
          throw securityError(
            '当前用户无权写入 Markdown 文稿',
            'USER_ACL_WRITE_DENIED',
            403,
          );
        }

        let currentTarget;
        try {
          await authorizeOpenedTarget(
            uid,
            parent.fh,
            parent.requestedPath,
            parent.scope,
            '父目录',
          );
          currentTarget = await authorizeOpenedTarget(
            uid,
            target.fh,
            target.requestedPath,
            target.scope,
            'Markdown 文稿',
          );
          if (!currentTarget.acl?.writable) {
            throw securityError(
              '当前用户无权写入 Markdown 文稿',
              'USER_ACL_WRITE_DENIED',
              403,
            );
          }
          await assertRequestedPathStable(
            parentPath,
            parent.opened.actualPath,
            '父目录',
          );
          await assertRequestedPathStable(
            targetPath,
            target.opened.actualPath,
            'Markdown 文稿',
          );
        } catch (err) {
          if (isStaleSaveTargetError(err)) {
            throw fileConflict('文稿已被另一个保存请求替换，请重新加载');
          }
          throw err;
        }

        if (recoverySource) {
          data = await readRecoveryArtifactForCommit(
            uid,
            target,
            currentTarget,
            recoverySource.recoveryId,
            recoverySource.version,
            signal,
          );
        }
        if (!Buffer.isBuffer(data) || data.length > maximumDocumentBytes) {
          throw securityError(
            '恢复正文超过安全上限',
            'RECOVERY_ARTIFACT_INVALID',
            409,
          );
        }

        const baselineReadLimit = maximumDocumentBytes;
        let baseline;
        try {
          baseline = await readStableBounded(
            target.fh,
            currentTarget.stat,
            baselineReadLimit,
            {
              signal,
              changedReason: 'FILE_CHANGED_DURING_SAVE',
              tooLargeReason:
                baselineReadLimit === MAX_FILE_BYTES
                  ? 'FILE_TOO_LARGE'
                  : 'RECOVERY_BASELINE_TOO_LARGE',
              kind: '待保存文稿',
            },
          );
        } catch (err) {
          if (err.reason === 'FILE_CHANGED_DURING_SAVE') {
            throw fileConflict('文稿已被另一个保存请求修改，请重新加载');
          }
          throw err;
        }
        const baselineRevision = revisionFromStat(baseline.preciseStat);
        if (baselineRevision !== expectedRevision) {
          throw fileConflict(
            '文稿已被外部修改，请重新加载后再保存',
            baselineRevision,
          );
        }

        if (baseline.data.equals(data)) {
          await authorizeOpenedTarget(
            uid,
            parent.fh,
            parent.requestedPath,
            parent.scope,
            '父目录',
          );
          const noOpTarget = await authorizeOpenedTarget(
            uid,
            target.fh,
            target.requestedPath,
            target.scope,
            'Markdown 文稿',
          );
          if (!noOpTarget.acl?.writable) {
            throw securityError(
              '当前用户无权写入 Markdown 文稿',
              'USER_ACL_WRITE_DENIED',
              403,
            );
          }
          await assertRequestedPathStable(
            parentPath,
            parent.opened.actualPath,
            '父目录',
          );
          await assertRequestedPathStable(
            targetPath,
            target.opened.actualPath,
            'Markdown 文稿',
          );
          await assertNoSymlinkBelowAuthorizedRoot(parentPath, parent);
          const noOpPreciseStat = await preciseStat(target.fh);
          const noOpRevision = revisionFromStat(noOpPreciseStat);
          if (noOpRevision !== baselineRevision) {
            throw fileConflict(
              '文稿已被外部修改，请重新加载后再保存',
              noOpRevision,
            );
          }
          return {
            ...(includeContent ? { content: data.toString('utf8') } : {}),
            actualPath: target.opened.actualPath,
            size: noOpTarget.stat.size,
            mtime: noOpTarget.stat.mtimeMs,
            ctime: noOpTarget.stat.ctimeMs,
            revision: noOpRevision,
            saveSemantics: 'in-place-recoverable',
            externalAtomicity: 'non-atomic-to-external-readers',
          };
        }

        return await performInPlaceSave({
          uid,
          targetPath,
          parentPath,
          parent,
          target,
          baseline,
          baselineRevision,
          data,
          signal,
          maximumDocumentBytes,
          includeContent,
        });
      } finally {
        await target?.fh.close().catch(() => {});
        await parent.fh.close().catch(() => {});
      }
    },
  );
}

async function writeMarkdown(uid, targetPath, content, expectedRevision, { signal } = {}) {
  throwIfAborted(signal);
  const data = assertValidSaveRequest(targetPath, content, expectedRevision);
  return saveMarkdownBuffer(uid, targetPath, data, expectedRevision, { signal });
}

async function commitRecoveryVersion(
  uid,
  targetPath,
  recoveryId,
  version,
  expectedRevision,
  { signal } = {},
) {
  throwIfAborted(signal);
  assertValidRecoveryCommitRequest(
    targetPath,
    recoveryId,
    version,
    expectedRevision,
  );
  return saveMarkdownBuffer(uid, targetPath, null, expectedRevision, {
    signal,
    recoverySource: { recoveryId, version },
    maximumDocumentBytes: MAX_RECOVERY_BASELINE_BYTES,
    includeContent: false,
  });
}


/**
 * 列出目录下的 md 文件与子目录（构建文件树）。
 */
async function listDirectory(
  uid,
  dirPath,
  { includeImages = false, includeRootMetadata = false, signal } = {},
) {
  throwIfAborted(signal);
  const scope = await assertWithinAuthorized(dirPath);
  throwIfAborted(signal);
  if (!scope.ok) {
    const e = new Error(
      scope.reason === 'NO_AUTHORIZED_PATH'
        ? '尚未配置可访问目录，请由管理员在应用设置的「访问权限」中添加'
        : scope.reason === 'SHARED_AUTHORIZATION_FAILED'
          ? `无法读取应用设置中的授权目录: ${scope.detail}`
          : '该目录未被授权访问',
    );
    e.status = scope.reason === 'SHARED_AUTHORIZATION_FAILED' ? 502 : 403;
    e.reason = scope.reason;
    throw e;
  }

  let fh;
  try {
    fh = await openReadOnly(dirPath);
  } catch (err) {
    throw mapOpenError(err, '目录');
  }

  try {
    const opened = await authorizeOpenedTarget(uid, fh, dirPath, scope, '目录');
    throwIfAborted(signal);
    if (!opened.stat.isDirectory()) {
      const e = new Error('目标不是目录');
      e.status = 400;
      throw e;
    }

    // Linux 通过 /proc/self/fd/<fd> 列目录，即使原路径被重命名或
    // 祖先软链被替换，枚举对象仍是已经通过校验的那个目录 fd。
    // 使用流式 opendir，而不是一次性 readdir 整个目录；即使 NAS 目录含有
    // 海量不支持的文件，也只会枚举到硬上限，不会先把全部 Dirent 放进内存。
    const entries = [];
    let directory;
    try {
      directory = await fs.opendir(opened.ioPath);
    } catch (err) {
      throw mapOpenError(err, '目录');
    }
    for await (const entry of directory) {
      throwIfAborted(signal);
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        throw securityError(
          `单个目录条目超过 ${MAX_DIRECTORY_ENTRIES} 个`,
          'DIRECTORY_SCAN_LIMIT',
          413,
        );
      }
      entries.push(entry);
    }
    await assertFdMatchesPath(fh, opened.actualPath);
    throwIfAborted(signal);

    const candidates = [];
    for (const ent of entries) {
      throwIfAborted(signal);
      if (ent.name.startsWith('.')) continue; // 跳过隐藏文件
      const full = path.join(opened.actualPath, ent.name);
      if (ent.isDirectory()) {
        candidates.push({ name: ent.name, path: full, type: 'dir' });
      } else if (ent.isFile() && isMarkdownPath(ent.name)) {
        candidates.push({ name: ent.name, path: full, type: 'file', format: 'markdown' });
      } else if (
        includeImages &&
        ent.isFile() &&
        IMAGE_MIME_TYPES.has(path.extname(ent.name).toLowerCase())
      ) {
        candidates.push({ name: ent.name, path: full, type: 'file', format: 'image' });
      }
    }

    // 父目录可读不代表每个子项都可读。子项也必须先从稳定
    // 父 fd 打开，再以各自的跨进程 proc fd 路径分批查 ACL。
    const visible = await filterDirectoryChildrenByStableAcl(
      uid,
      fh,
      opened,
      scope,
      candidates,
      signal,
    );
    throwIfAborted(signal);
    await assertFdMatchesPath(fh, opened.actualPath);

    const dirs = visible.filter((item) => item.type === 'dir');
    const files = visible.filter((item) => item.type === 'file');
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
    const sortedEntries = [...dirs.sort(byName), ...files.sort(byName)];
    return includeRootMetadata
      ? { actualPath: opened.actualPath, entries: sortedEntries }
      : sortedEntries;
  } finally {
    await fh.close().catch(() => {});
  }
}

function parseLocalResourceSource(rawSource) {
  if (typeof rawSource !== 'string' || rawSource.length === 0 || rawSource.length > 4096) {
    throw securityError('图片路径无效', 'INVALID_RESOURCE_PATH', 400);
  }

  // Markdown 图片允许附带 query/hash；本地文件解析只使用路径部分。
  const withoutSuffix = rawSource.split(/[?#]/u, 1)[0];
  let sourcePath;
  try {
    // HTTP query 已由 Express 解码；这里再解一次的是 Markdown URL 自身的百分号编码。
    sourcePath = decodeURIComponent(withoutSuffix);
  } catch {
    throw securityError('图片路径编码无效', 'INVALID_RESOURCE_PATH', 400);
  }

  if (
    !sourcePath ||
    sourcePath.includes('\0') ||
    sourcePath.startsWith('//') ||
    sourcePath.startsWith('\\\\') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(sourcePath)
  ) {
    throw securityError('图片路径无效', 'INVALID_RESOURCE_PATH', 400);
  }

  const rootRelative = sourcePath.startsWith('/');
  const relativePath = rootRelative ? sourcePath.slice(1) : sourcePath;
  if (!relativePath) {
    throw securityError('图片路径不能为空', 'INVALID_RESOURCE_PATH', 400);
  }
  return { relativePath, rootRelative };
}

function hasImageSignature(data, mimeType) {
  const ascii = (start, end) => data.subarray(start, end).toString('ascii');
  switch (mimeType) {
    case 'image/png':
      return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif':
      return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    case 'image/webp':
      return data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/bmp':
      return data.length >= 2 && ascii(0, 2) === 'BM';
    case 'image/tiff':
      return (
        data.length >= 4 &&
        ((ascii(0, 2) === 'II' && data[2] === 42 && data[3] === 0) ||
          (ascii(0, 2) === 'MM' && data[2] === 0 && data[3] === 42))
      );
    case 'image/avif':
      return (
        data.length >= 12 &&
        ascii(4, 8) === 'ftyp' &&
        ['avif', 'avis'].includes(ascii(8, 12))
      );
    case 'image/heic':
    case 'image/heif':
      return (
        data.length >= 12 &&
        ascii(4, 8) === 'ftyp' &&
        ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(8, 12))
      );
    default:
      return false;
  }
}

/**
 * 读取 Markdown 引用的本地图片。
 *
 * workspace 缺省时资源根是文稿父目录；显式传入时可指向任意已授权且
 * 当前用户可读的子目录。最终图片从稳定的资源根 fd 打开，并对图片 fd
 * 独立执行用户 ACL 检查。
 */
async function readLocalImage(uid, documentPath, rawSource, workspacePath = null) {
  const source = parseLocalResourceSource(rawSource);
  const document = await openAuthorizedTarget(uid, documentPath, {
    kind: 'Markdown 文稿',
    expectedType: 'file',
    markdownOnly: true,
  });
  let workspace;
  let image;

  try {
    const requestedWorkspace = workspacePath || path.dirname(document.opened.actualPath);
    workspace = await openAuthorizedTarget(uid, requestedWorkspace, {
      kind: '资源工作区',
      expectedType: 'dir',
    });

    const workspaceRoot = workspace.opened.actualPath;
    const documentRealPath = document.opened.actualPath;
    if (
      documentRealPath === workspaceRoot ||
      !isInside(workspaceRoot, documentRealPath) ||
      (!workspacePath && path.dirname(documentRealPath) !== workspaceRoot)
    ) {
      throw securityError(
        'Markdown 文稿不在指定资源工作区内',
        'DOCUMENT_OUTSIDE_WORKSPACE',
        403,
      );
    }

    const basePath = source.rootRelative ? workspaceRoot : path.dirname(documentRealPath);
    const candidatePath = path.resolve(basePath, source.relativePath);
    if (candidatePath === workspaceRoot || !isInside(workspaceRoot, candidatePath)) {
      throw securityError('图片路径超出资源工作区', 'RESOURCE_OUTSIDE_WORKSPACE', 403);
    }
    if (!IMAGE_MIME_TYPES.has(path.extname(candidatePath).toLowerCase())) {
      throw securityError('不支持该图片格式', 'UNSUPPORTED_IMAGE_TYPE', 415);
    }

    // 从已授权的稳定目录 fd 向下解析相对路径，避免工作区路径在 open 前被替换。
    const pathWithinWorkspace = path.relative(workspaceRoot, candidatePath);
    const stableCandidatePath = path.join(workspace.opened.ioPath, pathWithinWorkspace);
    image = await openAuthorizedTarget(uid, stableCandidatePath, {
      kind: '图片',
      expectedType: 'file',
      // stableCandidatePath 在生产是 /proc/self/fd/<root-fd>/...；不存在时
      // 该 proc 路径无法 realpath。用已验证的词法候选做打开前范围预检，
      // 再从稳定根 fd 真正 open，才能把缺失准确映射为 404。
      authorizationPath: candidatePath,
    });

    if (
      image.opened.actualPath === workspaceRoot ||
      !isInside(workspaceRoot, image.opened.actualPath)
    ) {
      throw securityError('图片真实路径超出资源工作区', 'RESOURCE_OUTSIDE_WORKSPACE', 403);
    }

    const mimeType = IMAGE_MIME_TYPES.get(path.extname(image.opened.actualPath).toLowerCase());
    if (!mimeType) {
      throw securityError('不支持该图片格式', 'UNSUPPORTED_IMAGE_TYPE', 415);
    }
    if (image.opened.stat.size > MAX_IMAGE_BYTES) {
      throw securityError(
        `图片过大，读取上限为 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
        'IMAGE_TOO_LARGE',
        413,
      );
    }

    const { data, stat: finalStat } = await readStableBounded(
      image.fh,
      image.opened.stat,
      MAX_IMAGE_BYTES,
      {
        changedReason: 'RESOURCE_CHANGED_DURING_READ',
        tooLargeReason: 'IMAGE_TOO_LARGE',
        kind: '图片',
      },
    );
    if (!hasImageSignature(data, mimeType)) {
      throw securityError('文件内容不是受支持的图片', 'INVALID_IMAGE_CONTENT', 415);
    }

    // 多目标操作完成前再用各自仍打开的稳定 fd 重做当前共享授权与用户 ACL，
    // 防止文稿/工作区在图片读取期间被撤权后仍返回数据。
    const finalDocument = await authorizeOpenedTarget(
      uid,
      document.fh,
      document.requestedPath,
      document.scope,
      'Markdown 文稿',
    );
    const finalWorkspace = await authorizeOpenedTarget(
      uid,
      workspace.fh,
      workspace.requestedPath,
      workspace.scope,
      '资源工作区',
    );
    const finalImage = await authorizeOpenedTarget(
      uid,
      image.fh,
      image.requestedPath,
      image.scope,
      '图片',
    );
    if (
      !isInside(finalWorkspace.actualPath, finalDocument.actualPath) ||
      !isInside(finalWorkspace.actualPath, finalImage.actualPath)
    ) {
      throw securityError('资源在读取期间移出工作区', 'RESOURCE_OUTSIDE_WORKSPACE', 403);
    }
    return {
      data,
      mimeType,
      size: data.length,
      mtime: finalStat.mtimeMs,
    };
  } finally {
    await image?.fh.close().catch(() => {});
    await workspace?.fh.close().catch(() => {});
    await document.fh.close().catch(() => {});
  }
}

function normalizeWorkspacePaths(workspacePaths) {
  const values = Array.isArray(workspacePaths) ? workspacePaths : [workspacePaths];
  if (values.length === 0 || values.length > MAX_SELECTED_WORKSPACES) {
    throw securityError(
      `每次最多选择 ${MAX_SELECTED_WORKSPACES} 个工作区`,
      'INVALID_WORKSPACE_COUNT',
      400,
    );
  }

  const unique = [];
  const seen = new Set();
  for (const value of values) {
    assertAbsolutePath(value, '工作区路径');
    const key = path.resolve(value);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  }
  return unique;
}

async function inspectSelectedWorkspaces(uid, workspacePaths, { signal } = {}) {
  const inspected = [];
  for (const requestedPath of normalizeWorkspacePaths(workspacePaths)) {
    throwIfAborted(signal);
    inspected.push(
      await inspectAuthorizedTarget(uid, requestedPath, {
        kind: '工作区',
        expectedType: 'dir',
        signal,
      }),
    );
  }

  // 同一真实目录只保留一次；深层工作区优先，便于重叠工作区归属及去重。
  const byRealPath = new Map();
  for (const workspace of inspected) {
    if (!byRealPath.has(workspace.path)) byRealPath.set(workspace.path, workspace);
  }
  return [...byRealPath.values()].sort(
    (a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path),
  );
}

function relativeDisplayPath(rootPath, targetPath) {
  if (targetPath === rootPath || !isInside(rootPath, targetPath)) {
    throw securityError('工作区在扫描期间发生变化', 'WORKSPACE_CHANGED_DURING_SCAN', 409);
  }
  return path.relative(rootPath, targetPath).split(path.sep).join('/');
}

function throwTreeLimit(reason) {
  throw securityError(
    reason === 'depth'
      ? `工作区目录深度超过 ${MAX_TREE_DEPTH} 层`
      : `工作区可见条目超过 ${MAX_TREE_ENTRIES} 个`,
    'WORKSPACE_SCAN_LIMIT',
    413,
  );
}

async function collectWorkspaceTree(
  uid,
  workspace,
  {
    budget,
    onLimit = 'error',
    excludedRoots = [],
    includeImages = false,
    signal,
  } = {},
) {
  const records = [];
  const queue = [{ dirPath: workspace.path, depth: 0 }];
  const excluded = new Set(excludedRoots.map((item) => path.resolve(item)));
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    throwIfAborted(signal);
    const current = queue.shift();
    const entries = await listDirectory(uid, current.dirPath, { includeImages, signal });
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.type === 'dir' && excluded.has(path.resolve(entry.path))) continue;
      if (budget.remaining <= 0) {
        if (onLimit === 'error') throwTreeLimit('entries');
        truncated = true;
        break;
      }

      budget.remaining -= 1;
      budget.used += 1;
      const relativePath = relativeDisplayPath(workspace.path, entry.path);
      const record = { ...entry, relativePath };
      records.push(record);

      if (entry.type === 'dir') {
        if (current.depth + 1 >= MAX_TREE_DEPTH) {
          if (onLimit === 'error') throwTreeLimit('depth');
          truncated = true;
          break;
        }
        queue.push({ dirPath: entry.path, depth: current.depth + 1 });
      }
    }
  }

  const currentRoot = await inspectAuthorizedTarget(uid, workspace.requestedPath, {
    kind: '工作区',
    expectedType: 'dir',
    signal,
  });
  if (currentRoot.dev !== workspace.dev || currentRoot.ino !== workspace.ino) {
    throw securityError('工作区在扫描期间被替换', 'WORKSPACE_CHANGED_DURING_SCAN', 409);
  }
  return { records, truncated };
}

function foldSearchText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();
}

function matchingSnippet(content, foldedQuery) {
  for (const rawLine of String(content).split(/\r?\n/u)) {
    if (!foldSearchText(rawLine).includes(foldedQuery)) continue;
    const line = rawLine.trim().replace(/\s+/gu, ' ');
    return line.length > 180 ? `${line.slice(0, 177)}…` : line;
  }
  return null;
}

/** 全文搜索一个或多个显式选择的工作区。 */
async function searchMarkdown(
  uid,
  workspacePaths,
  query,
  requestedLimit = MAX_SEARCH_RESULTS,
  { signal } = {},
) {
  throwIfAborted(signal);
  const needle = String(query || '').trim();
  if (!needle) return { results: [], scannedFiles: 0, truncated: false };
  if (needle.length > MAX_SEARCH_QUERY_LENGTH) {
    throw securityError(
      `搜索词不能超过 ${MAX_SEARCH_QUERY_LENGTH} 个字符`,
      'SEARCH_QUERY_TOO_LONG',
      400,
    );
  }
  const limit = Math.floor(
    Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(requestedLimit) || MAX_SEARCH_RESULTS)),
  );
  const workspaces = await inspectSelectedWorkspaces(uid, workspacePaths, { signal });
  const contentByteLimit =
    searchContentLimitsForTest?.bytes ?? MAX_SEARCH_CONTENT_BYTES;
  const contentFileLimit =
    searchContentLimitsForTest?.files ?? MAX_SEARCH_CONTENT_FILES;
  const budget = { remaining: MAX_TREE_ENTRIES, used: 0 };
  const candidates = [];
  const seenFiles = new Set();
  let truncated = false;

  for (let index = 0; index < workspaces.length; index += 1) {
    throwIfAborted(signal);
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const workspace = workspaces[index];
    const excludedRoots = workspaces
      .slice(0, index)
      .filter((other) => isInside(workspace.path, other.path))
      .map((other) => other.path);
    const tree = await collectWorkspaceTree(uid, workspace, {
      budget,
      onLimit: 'truncate',
      excludedRoots,
      signal,
    });
    truncated ||= tree.truncated;
    for (const record of tree.records) {
      if (record.type !== 'file' || seenFiles.has(record.path)) continue;
      seenFiles.add(record.path);
      candidates.push({ ...record, workspacePath: workspace.requestedPath });
    }
  }

  const foldedQuery = foldSearchText(needle);
  const byDisplayPath = (a, b) => {
    const aDisplayPath = a.displayPath || a.relativePath;
    const bDisplayPath = b.displayPath || b.relativePath;
    return (
      aDisplayPath.localeCompare(bDisplayPath, 'zh-CN', { numeric: true }) ||
      a.path.localeCompare(b.path)
    );
  };
  const fileNameMatches = [];
  const contentCandidates = [];
  for (const candidate of candidates) {
    throwIfAborted(signal);
    if (foldSearchText(candidate.relativePath).includes(foldedQuery)) {
      fileNameMatches.push({
        path: candidate.path,
        name: candidate.name,
        displayPath: candidate.relativePath,
        snippet: candidate.relativePath,
        matchKind: 'fileName',
        workspacePath: candidate.workspacePath,
      });
    } else if (candidate.size <= MAX_FILE_BYTES) {
      contentCandidates.push(candidate);
    }
  }
  fileNameMatches.sort(byDisplayPath);
  contentCandidates.sort(byDisplayPath);

  const results = [];
  let fileNameMatchesChecked = 0;
  for (const match of fileNameMatches) {
    throwIfAborted(signal);
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    try {
      await inspectAuthorizedTarget(uid, match.path, {
        kind: '搜索结果文稿',
        expectedType: 'file',
        markdownOnly: true,
        signal,
      });
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
    fileNameMatchesChecked += 1;
    results.push(match);
  }
  let contentFilesRead = 0;
  let contentBytesScheduled = 0;
  let contentBytesRead = 0;
  for (const candidate of contentCandidates) {
    throwIfAborted(signal);
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    if (
      contentFilesRead >= contentFileLimit ||
      contentBytesScheduled + candidate.size > contentByteLimit ||
      contentBytesRead + candidate.size > contentByteLimit
    ) {
      truncated = true;
      break;
    }
    contentBytesScheduled += candidate.size;
    let document;
    try {
      document = await readMarkdown(uid, candidate.path, { signal });
    } catch (err) {
      // 搜索期间文件被删除或变大属于正常并发变化；权限失败必须透出并 fail closed。
      if (err.status === 404 || err.status === 413 || err.reason === 'INVALID_UTF8') continue;
      throw err;
    }
    contentFilesRead += 1;
    contentBytesRead += document.size;
    if (contentBytesRead > contentByteLimit) {
      truncated = true;
      break;
    }
    const snippet = matchingSnippet(document.content, foldedQuery);
    throwIfAborted(signal);
    if (!snippet) continue;
    results.push({
      path: candidate.path,
      name: candidate.name,
      displayPath: candidate.relativePath,
      snippet,
      matchKind: 'content',
      workspacePath: candidate.workspacePath,
    });
  }

  throwIfAborted(signal);
  return {
    results,
    scannedFiles: candidates.length,
    fileNameMatchesChecked,
    contentFilesRead,
    contentBytesScheduled,
    contentBytesRead,
    truncated,
  };
}

/** 生成可轮询的工作区树 revision；不读取 Markdown 正文。 */
async function getWorkspaceState(uid, workspacePath, { signal } = {}) {
  throwIfAborted(signal);
  const [workspace] = await inspectSelectedWorkspaces(uid, [workspacePath], { signal });
  const budget = { remaining: MAX_TREE_ENTRIES, used: 0 };
  const tree = await collectWorkspaceTree(uid, workspace, {
    budget,
    onLimit: 'error',
    includeImages: true,
    signal,
  });
  throwIfAborted(signal);
  const records = tree.records
    .map((record) => ({
      relativePath: record.relativePath,
      type: record.type,
      format: record.format || null,
      size: record.size,
      mtime: record.mtime,
      ctime: record.ctime,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = crypto.createHash('sha256');
  hash.update(
    JSON.stringify({
      root: {
        type: workspace.type,
        size: workspace.size,
        mtime: workspace.mtime,
        ctime: workspace.ctime,
      },
      records,
    }),
  );
  throwIfAborted(signal);

  return {
    path: workspace.requestedPath,
    actualPath: workspace.path,
    revision: hash.digest('hex'),
    fileCount: records.filter((item) => item.format === 'markdown').length,
    imageCount: records.filter((item) => item.format === 'image').length,
    directoryCount: records.filter((item) => item.type === 'dir').length,
    generatedAt: Date.now(),
  };
}

/** 获取当前用户可见的应用共享授权根目录（保留给诊断/兼容接口） */
async function getAuthorizedRoots(uid, language = 'zh-CN') {
  const snapshot = await getSharedAuthorizationSnapshot();
  if (snapshot.resolvedRoots.length === 0) return [];

  // 共享授权是全应用的；根目录也必须先按当前用户 ACL 过滤，
  // 不能把无权根的路径和展示名泄露给所有登录用户。ACL 同样绑定根 fd。
  const visibleRoots = await filterSharedRootsByStableAcl(uid, snapshot);
  const visiblePaths = visibleRoots.map((item) => item.path);
  if (visiblePaths.length === 0) return [];

  // 界面上不要直接暴露 /vol1/... 内部路径，转成可读形式
  const displayMap = await getDisplayPaths(visiblePaths, language);

  return visiblePaths.map((p) => ({
    path: p,
    displayPath: displayMap[p] || p,
    // fnOS 应用共享授权只支持目录。
    isFile: false,
  }));
}

/**
 * 批量把内部路径转成语义化展示路径。
 *
 * 返回结构为 data.result[]，每项含 path 与 semanticPath
 * （例：/vol1/1000/photo → 存储空间1/admin 的文件/photo）。
 * 转换失败时返回空映射，由调用方回退到原始路径 —— 展示降级不应阻断阅读。
 */
async function getDisplayPaths(paths, language = 'zh-CN') {
  const map = {};
  if (!paths || paths.length === 0) return map;

  const converted = await trimApi.convertPath(paths, language);
  if (!converted) return map;

  const list = Array.isArray(converted)
    ? converted
    : converted.result || converted.list || [];
  list.forEach((item, i) => {
    const key = item?.path || paths[i];
    const display = item?.semanticPath || item?.displayPath || item?.convertPath;
    if (key && display) map[key] = display;
  });
  return map;
}

module.exports = {
  extractAuthorizedPaths,
  isMarkdownPath,
  isInside,
  readMarkdown,
  writeMarkdown,
  commitRecoveryVersion,
  getMarkdownState,
  getRecoveryState,
  readRecoveryVersion,
  discardRecovery,
  cleanupExpiredRecoveries,
  readLocalImage,
  searchMarkdown,
  getWorkspaceState,
  listDirectory,
  getAuthorizedRoots,
  MAX_FILE_BYTES,
  MAX_SAVE_REQUEST_BYTES,
  MAX_RECOVERY_BASELINE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_SEARCH_CONTENT_BYTES,
  MAX_SEARCH_CONTENT_FILES,
  __test: {
    setOpenedTargetResolverForTest,
    setSearchContentLimitsForTest,
    setSaveHooksForTest,
    setRecoveryRootForTest,
    crossProcessFdPath,
  },
};
