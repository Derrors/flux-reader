const STORAGE_PREFIX = 'flux-reader.document-session.v1';
export const MAX_DOCUMENT_TABS = 12;

const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

function availableStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
export function documentSessionStorageKey(uid) {
  if ((typeof uid !== 'string' && typeof uid !== 'number') || !String(uid).trim()) {
    return null;
  }
  return `${STORAGE_PREFIX}.${encodeURIComponent(String(uid).trim())}`;
}

function normalizeTab(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = typeof value.path === 'string' ? value.path : '';
  if (!path.startsWith('/') || path.includes('\0') || !MARKDOWN_PATH.test(path)) return null;
  const actualPath = typeof value.actualPath === 'string' && value.actualPath.startsWith('/')
    && !value.actualPath.includes('\0')
    ? value.actualPath
    : null;
  const fallbackName = path.split('/').filter(Boolean).pop() || path;
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, 512)
    : fallbackName;
  const displayPath = typeof value.displayPath === 'string' && value.displayPath.trim()
    ? value.displayPath.trim().slice(0, 4096)
    : path;
  return {
    id: path,
    path,
    actualPath,
    name,
    displayPath,
    type: 'file',
    dirty: value.dirty === true,
  };
}

export function readDocumentSession(uid, storage) {
  const key = documentSessionStorageKey(uid);
  const target = availableStorage(storage);
  if (!key || !target) return { tabs: [], activeId: null };
  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!parsed || !Array.isArray(parsed.tabs)) return { tabs: [], activeId: null };
    const seen = new Set();
    const tabs = parsed.tabs
      .map(normalizeTab)
      .filter((tab) => {
        if (!tab || seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
      })
      .slice(0, MAX_DOCUMENT_TABS);
    const activeId = tabs.some((tab) => tab.id === parsed.activeId)
      ? parsed.activeId
      : tabs[0]?.id || null;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

export function writeDocumentSession(uid, tabs, activeId, storage) {
  const key = documentSessionStorageKey(uid);
  const target = availableStorage(storage);
  if (!key || !target) return false;
  const seen = new Set();
  const safeTabs = (Array.isArray(tabs) ? tabs : [])
    .map((tab) => normalizeTab({
      ...tab,
      dirty: tab?.dirty ?? (
        typeof tab?.draft === 'string' && typeof tab?.content === 'string'
          ? tab.draft !== tab.content
          : false
      ),
    }))
    .filter((tab) => {
      if (!tab || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    })
    .slice(0, MAX_DOCUMENT_TABS);
  const safeActiveId = safeTabs.some((tab) => tab.id === activeId)
    ? activeId
    : safeTabs[0]?.id || null;
  try {
    target.setItem(key, JSON.stringify({
      tabs: safeTabs,
      activeId: safeActiveId,
      updatedAt: Date.now(),
    }));
    return true;
  } catch {
    return false;
  }
}
