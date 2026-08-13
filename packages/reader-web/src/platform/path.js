const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//u;

/**
 * 桌面端统一使用正斜杠路径标识。POSIX 路径保持逐字不变；Windows Rust
 * bridge 在返回前只转换分隔符，不做 trim 或大小写改写。
 */
export function isAbsoluteHostPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && (value.startsWith('/') || WINDOWS_DRIVE_PATH.test(value));
}

export function isWindowsHostPath(value) {
  return typeof value === 'string'
    && (WINDOWS_DRIVE_PATH.test(value) || value.startsWith('//'));
}

export function basenameHostPath(value) {
  const path = String(value || '');
  return path.split('/').filter(Boolean).pop() || path;
}

export function dirnameHostPath(value) {
  const path = String(value || '');
  const normalized = path.replace(/\/+$/u, '');
  if (/^[A-Za-z]:$/u.test(normalized)) return `${normalized}/`;
  const boundary = normalized.lastIndexOf('/');
  if (boundary < 0) return '/';
  if (boundary === 0) return '/';
  if (boundary === 2 && WINDOWS_DRIVE_PATH.test(path)) return `${normalized.slice(0, 2)}/`;
  return normalized.slice(0, boundary);
}

/** 目录根标识去掉多余末尾斜杠，但保留 POSIX 与盘符根目录。 */
export function normalizeHostRoot(value) {
  if (!isAbsoluteHostPath(value) || value.includes('\0')) return null;
  if (value === '/' || /^[A-Za-z]:\/$/u.test(value)) return value;
  const normalized = value.replace(/\/+$/u, '');
  return /^[A-Za-z]:$/u.test(normalized) ? `${normalized}/` : normalized || '/';
}

function comparisonPath(value) {
  return isWindowsHostPath(value) ? value.toLocaleLowerCase('en-US') : value;
}

/** 用路径组件边界判断包含关系；Windows 路径比较不区分大小写。 */
export function containsHostPath(rootValue, targetValue) {
  const rootPath = normalizeHostRoot(rootValue);
  if (!rootPath || !isAbsoluteHostPath(targetValue) || targetValue.includes('\0')) return false;
  const root = comparisonPath(rootPath);
  const target = comparisonPath(targetValue);
  if (root === '/') return target.startsWith('/');
  if (/^[a-z]:\/$/u.test(root)) return target.startsWith(root);
  return target === root || target.startsWith(`${root}/`);
}
