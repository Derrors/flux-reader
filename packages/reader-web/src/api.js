/** 后端接口封装。路径与 Vite base 保持一致，便于本地与线上共用。 */
const BASE = '/app/flux-reader/api';

async function get(path, params) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url, { credentials: 'same-origin' });
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

export const api = {
  env: () => get('/env'),
  list: (path) => get('/list', { path }),
  file: (path) => get('/file', { path }),
  sample: () => get('/sample'),
};
