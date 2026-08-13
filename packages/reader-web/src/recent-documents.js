import { basenameHostPath, isAbsoluteHostPath } from './platform/path';

const STORAGE_PREFIX = 'flux-reader.recent-documents.v1';
export const MAX_RECENT_DOCUMENTS = 12;

const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

function cleanText(value, maximumLength) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\0/g, '').trim();
  return text.length <= maximumLength ? text : text.slice(0, maximumLength);
}

/**
 * localStorage keys are scoped to the signed-in fnOS user. If the environment
 * cannot identify the user we keep recents in memory instead of sharing a
 * fallback bucket between accounts using the same browser profile.
 */
export function recentStorageKey(uid) {
  if ((typeof uid !== 'string' && typeof uid !== 'number') || !String(uid).trim()) {
    return null;
  }
  return `${STORAGE_PREFIX}.${encodeURIComponent(String(uid).trim())}`;
}

/** Only inert display metadata is accepted; document bodies never enter storage. */
export function normalizeRecentDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'file' || (value.isFile != null && value.isFile !== true)) return null;

  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.length > 4096 ||
    value.path.includes('\0')
  ) {
    return null;
  }
  const path = value.path;
  if (!isAbsoluteHostPath(path) || !MARKDOWN_PATH.test(path)) return null;

  const fallbackName = basenameHostPath(path);
  const name = cleanText(value.name, 512) || fallbackName;
  const displayPath = cleanText(value.displayPath, 4096) || path;
  const openedAt = Number(value.openedAt);

  return {
    path,
    name,
    displayPath,
    type: 'file',
    openedAt: Number.isFinite(openedAt) && openedAt > 0 ? openedAt : Date.now(),
  };
}

function availableStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readRecentDocuments(uid, storage) {
  const key = recentStorageKey(uid);
  const target = availableStorage(storage);
  if (!key || !target) return [];

  try {
    const parsed = JSON.parse(target.getItem(key) || '[]');
    if (!Array.isArray(parsed)) return [];

    const seen = new Set();
    return parsed
      .map(normalizeRecentDocument)
      .filter((item) => {
        if (!item || seen.has(item.path)) return false;
        seen.add(item.path);
        return true;
      })
      .slice(0, MAX_RECENT_DOCUMENTS);
  } catch {
    return [];
  }
}

export function writeRecentDocuments(uid, documents, storage) {
  const key = recentStorageKey(uid);
  const target = availableStorage(storage);
  if (!key || !target) return false;

  const seen = new Set();
  const safe = (Array.isArray(documents) ? documents : [])
    .map(normalizeRecentDocument)
    .filter((item) => {
      if (!item || seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    })
    .slice(0, MAX_RECENT_DOCUMENTS);

  try {
    target.setItem(key, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

export function prependRecentDocument(documents, document, openedAt = Date.now()) {
  const next = normalizeRecentDocument({ ...document, openedAt });
  if (!next) return Array.isArray(documents) ? documents : [];
  return [next, ...(Array.isArray(documents) ? documents : []).filter(
    (item) => item?.path !== next.path,
  )].slice(0, MAX_RECENT_DOCUMENTS);
}
