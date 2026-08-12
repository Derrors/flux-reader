/** fnOS HTTP 传输：保持统一网关路径、同源凭证与错误对象形状不变。 */
const BASE = '/app/flux-reader/api';

async function parseResponse(res) {
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
    err.details = data;
    throw err;
  }
  return data;
}

async function get(path, params, { signal } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item != null) url.searchParams.append(key, String(item));
        });
      } else if (value != null) {
        url.searchParams.set(key, String(value));
      }
    });
  }
  const fetchOptions = { credentials: 'same-origin' };
  if (signal) fetchOptions.signal = signal;
  return parseResponse(await fetch(url, fetchOptions));
}

async function put(path, body, { signal } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  const fetchOptions = {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (signal) fetchOptions.signal = signal;
  return parseResponse(await fetch(url, fetchOptions));
}

async function post(path, body, { signal } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  const fetchOptions = {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (signal) fetchOptions.signal = signal;
  return parseResponse(await fetch(url, fetchOptions));
}

async function remove(path, params, { signal } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value != null) url.searchParams.set(key, String(value));
    });
  }
  const fetchOptions = {
    method: 'DELETE',
    credentials: 'same-origin',
  };
  if (signal) fetchOptions.signal = signal;
  return parseResponse(await fetch(url, fetchOptions));
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

export const httpTransport = Object.freeze({
  get,
  put,
  post,
  delete: remove,
  resourceUrl,
});
