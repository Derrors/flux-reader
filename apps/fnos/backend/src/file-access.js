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
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
/** 本地图片读取上限；与 macOS 端保持一致。 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB
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
/** 避免单次 ACL 请求包含过多路径 */
const ACL_BATCH_SIZE = 100;
const READ_ONLY_NONBLOCKING = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
let openedTargetResolverForTest = null;
let searchContentLimitsForTest = null;

function openReadOnly(pathname) {
  // O_NONBLOCK 避免攻击者把 `.md` 换成 FIFO 后让 open 无限等待；
  // 打开后仍必须通过 fstat 确认是普通文件或目录。
  return fs.open(pathname, READ_ONLY_NONBLOCKING);
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
  throwIfAborted(signal);
  if (
    total !== initialStat.size ||
    finalStat.size !== initialStat.size ||
    finalStat.mtimeMs !== initialStat.mtimeMs ||
    finalStat.ctimeMs !== initialStat.ctimeMs
  ) {
    throw securityError(`${kind}在读取期间发生变化`, changedReason, 409);
  }
  return { data: buffer.subarray(0, total), stat: finalStat };
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
  return { ...opened, stat, currentScope };
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
    fh = await openReadOnly(targetPath);
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

function metadataFromOpened(target) {
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
  };
}

async function inspectAuthorizedTarget(uid, targetPath, options) {
  const target = await openAuthorizedTarget(uid, targetPath, options);
  try {
    return metadataFromOpened(target);
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
    const e = new Error('仅支持 .md / .markdown / .mdx 文件');
    e.status = 400;
    throw e;
  }

  // ——第一层：是否在应用设置的共享授权范围内
  const scope = await assertWithinAuthorized(targetPath);
  throwIfAborted(signal);
  if (!scope.ok) {
    let message = '该路径未被授权访问';
    if (scope.reason === 'NO_AUTHORIZED_PATH') {
      message = '尚未配置可访问目录，请由管理员在应用设置的「访问权限」中添加';
    } else if (scope.reason === 'SHARED_AUTHORIZATION_FAILED') {
      message = `无法读取应用设置中的授权目录: ${scope.detail}`;
    }
    const e = new Error(message);
    e.status = scope.reason === 'SHARED_AUTHORIZATION_FAILED' ? 502 : 403;
    e.reason = scope.reason;
    throw e;
  }

  // 先打开用户请求的原路径，后续授权、stat 和读取都锚定这个 fd。
  // 不能在打开前把 realpath 存起来再 open，否则目标或任一祖先软链
  // 都可在两步之间被替换。
  let fh;
  try {
    fh = await openReadOnly(targetPath);
  } catch (err) {
    throw mapOpenError(err, '文件');
  }

  try {
    const opened = await authorizeOpenedTarget(uid, fh, targetPath, scope, '文件');
    const { stat } = opened;
    throwIfAborted(signal);
    if (!stat.isFile()) {
      const e = new Error('目标不是文件');
      e.status = 400;
      throw e;
    }
    if (stat.size > MAX_FILE_BYTES) {
      const e = securityError(
        `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），阅读器上限为 ${MAX_FILE_BYTES / 1024 / 1024} MB`,
        'FILE_TOO_LARGE',
        413,
      );
      throw e;
    }
    const { data, stat: finalStat } = await readStableBounded(
      fh,
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
    return {
      content,
      actualPath: opened.actualPath,
      size: finalStat.size,
      mtime: finalStat.mtimeMs,
      ctime: finalStat.ctimeMs,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 只校验 Markdown 权限并返回元数据，不读取正文。 */
async function getMarkdownState(uid, targetPath, { signal } = {}) {
  const metadata = await inspectAuthorizedTarget(uid, targetPath, {
    kind: 'Markdown 文稿',
    expectedType: 'file',
    markdownOnly: true,
    signal,
  });
  if (metadata.size > MAX_FILE_BYTES) {
    throw securityError(
      `文件过大（${(metadata.size / 1024 / 1024).toFixed(1)} MB），阅读器上限为 ${MAX_FILE_BYTES / 1024 / 1024} MB`,
      'FILE_TOO_LARGE',
      413,
    );
  }
  return {
    actualPath: metadata.path,
    size: metadata.size,
    mtime: metadata.mtime,
    ctime: metadata.ctime,
  };
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
  getMarkdownState,
  readLocalImage,
  searchMarkdown,
  getWorkspaceState,
  listDirectory,
  getAuthorizedRoots,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_SEARCH_CONTENT_BYTES,
  MAX_SEARCH_CONTENT_FILES,
  __test: {
    setOpenedTargetResolverForTest,
    setSearchContentLimitsForTest,
    crossProcessFdPath,
  },
};
