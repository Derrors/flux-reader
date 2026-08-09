/** 后端接口封装。路径与 Vite base 保持一致，便于本地与线上共用。 */
const BASE = '/app/flux-reader/api';

async function get(path, params, { signal } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        v.forEach((item) => {
          if (item != null) url.searchParams.append(k, String(item));
        });
      } else if (v != null) {
        url.searchParams.set(k, String(v));
      }
    });
  }
  const fetchOptions = { credentials: 'same-origin' };
  if (signal) fetchOptions.signal = signal;
  const res = await fetch(url, fetchOptions);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = new Error(data.message || `请求失败 (HTTP ${res.status})`);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function resourceUrl(documentPath, resourcePath, workspacePath, revision) {
  const document = typeof documentPath === 'string' ? documentPath : '';
  const resource = String(resourcePath || '').trim();
  const workspace = typeof workspacePath === 'string' ? workspacePath : '';

  if (
    !document.startsWith('/') ||
    document.includes('\0') ||
    !/\.(?:md|markdown|mdx)$/i.test(document)
  ) return null;
  if (
    !resource ||
    resource.startsWith('//') ||
    resource.includes('\\') ||
    resource.includes('\0') ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resource)
  ) {
    return null;
  }
  if (workspace && (!workspace.startsWith('/') || workspace.includes('\0'))) return null;

  const url = new URL(`${BASE}/resource`, window.location.origin);
  url.searchParams.set('document', document);
  url.searchParams.set('path', resource);
  if (workspace) url.searchParams.set('workspace', workspace);
  // Cache-Control: no-store is the server-side guarantee. The opaque file
  // revision also makes the DOM URL change when an image is replaced in place.
  if (revision != null && String(revision)) url.searchParams.set('v', String(revision));
  return `${url.pathname}${url.search}`;
}

export const api = {
  env: () => get('/env'),
  list: (path, options) => get('/list', { path }, options),
  file: (path) => get('/file', { path }),
  fileState: (path) => get('/file-state', { path }),
  search: (paths, query, limit = 100, options) => get('/search', {
    path: Array.isArray(paths) ? paths : [paths],
    q: query,
    limit,
  }, options),
  workspaceState: (path) => get('/workspace-state', { path }),
  resourceUrl,
};
