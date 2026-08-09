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
const path = require('node:path');
const trimApi = require('./trim-api');

const MD_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
/** 单文件读取上限，防止把 NAS 内存吃满 */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
/** 避免单次 ACL 请求包含过多路径 */
const ACL_BATCH_SIZE = 100;
const READ_ONLY_NONBLOCKING = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
let openedTargetResolverForTest = null;

function openReadOnly(pathname) {
  // O_NONBLOCK 避免攻击者把 `.md` 换成 FIFO 后让 open 无限等待；
  // 打开后仍必须通过 fstat 确认是普通文件或目录。
  return fs.open(pathname, READ_ONLY_NONBLOCKING);
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
) {
  const visible = [];
  for (let offset = 0; offset < candidates.length; offset += ACL_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + ACL_BATCH_SIZE);
    const openedChildren = [];
    try {
      for (const item of batch) {
        let fh;
        try {
          // 生产 Linux 从稳定父 fd 打开子项，不再重新遍历用户可控的祖先路径。
          fh = await openReadOnly(path.join(parentOpened.ioPath, item.name));
        } catch {
          // 子项已消失或应用账号无法打开时直接隐藏，不暴露名称。
          continue;
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
      const currentScope = await refreshSharedAuthorization();
      for (const child of openedChildren) {
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
        const typeMatches =
          (child.item.type === 'dir' && stat.isDirectory()) ||
          (child.item.type === 'file' && stat.isFile());
        if (!typeMatches) {
          throw securityError('目录子项类型已发生变化', 'CHILD_TYPE_CHANGED');
        }
      }

      const aclPaths = openedChildren.map((child) => child.opened.aclPath);
      const aclMap = await trimApi.checkUserACL(uid, aclPaths);
      await diagnoseStableAclSupport(uid, openedChildren, aclMap);

      // ACL 返回后先重验父目录及每个子项的 inode。ABA 即使把
      // pathname 换回原 inode，ACL 也已经查的是不变的 child fd，无需且禁止回退。
      await assertFdMatchesPath(parentFh, parentOpened.actualPath);
      for (const child of openedChildren) {
        await assertFdMatchesPath(child.fh, child.opened.actualPath);
        if (getAclForPath(aclMap, child.opened.aclPath)?.readable) {
          visible.push(child.item);
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
        } catch {
          // 根目录已消失或应用账号不可打开时直接隐藏。
          continue;
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

/**
 * 读取 Markdown 文件内容（阅读器主入口）。
 * 完整走双层检查。
 */
async function readMarkdown(uid, targetPath) {
  if (!isMarkdownPath(targetPath)) {
    const e = new Error('仅支持 .md / .markdown / .mdx 文件');
    e.status = 400;
    throw e;
  }

  // ——第一层：是否在应用设置的共享授权范围内
  const scope = await assertWithinAuthorized(targetPath);
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
    const e = new Error(err.code === 'ENOENT' ? '文件不存在' : '无法打开文件');
    e.status = err.code === 'ENOENT' ? 404 : 403;
    throw e;
  }

  try {
    const { stat } = await authorizeOpenedTarget(uid, fh, targetPath, scope, '文件');
    if (!stat.isFile()) {
      const e = new Error('目标不是文件');
      e.status = 400;
      throw e;
    }
    if (stat.size > MAX_FILE_BYTES) {
      const e = new Error(
        `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），阅读器上限为 ${MAX_FILE_BYTES / 1024 / 1024} MB`,
      );
      e.status = 413;
      throw e;
    }
    const content = await fh.readFile('utf8');
    return { content, size: stat.size, mtime: stat.mtimeMs };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 列出目录下的 md 文件与子目录（构建文件树）。
 */
async function listDirectory(uid, dirPath) {
  const scope = await assertWithinAuthorized(dirPath);
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
    const e = new Error(err.code === 'ENOENT' ? '目录不存在' : '无法打开目录');
    e.status = err.code === 'ENOENT' ? 404 : 403;
    throw e;
  }

  try {
    const opened = await authorizeOpenedTarget(uid, fh, dirPath, scope, '目录');
    if (!opened.stat.isDirectory()) {
      const e = new Error('目标不是目录');
      e.status = 400;
      throw e;
    }

    // Linux 通过 /proc/self/fd/<fd> 列目录，即使原路径被重命名或
    // 祖先软链被替换，枚举对象仍是已经通过校验的那个目录 fd。
    const entries = await fs.readdir(opened.ioPath, { withFileTypes: true });
    await assertFdMatchesPath(fh, opened.actualPath);

    const candidates = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // 跳过隐藏文件
      const full = path.join(opened.actualPath, ent.name);
      if (ent.isDirectory()) {
        candidates.push({ name: ent.name, path: full, type: 'dir' });
      } else if (ent.isFile() && isMarkdownPath(ent.name)) {
        candidates.push({ name: ent.name, path: full, type: 'file' });
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
    );
    await assertFdMatchesPath(fh, opened.actualPath);

    const dirs = visible.filter((item) => item.type === 'dir');
    const files = visible.filter((item) => item.type === 'file');
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
    return [...dirs.sort(byName), ...files.sort(byName)];
  } finally {
    await fh.close().catch(() => {});
  }
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
  listDirectory,
  getAuthorizedRoots,
  MAX_FILE_BYTES,
  __test: { setOpenedTargetResolverForTest, crossProcessFdPath },
};
