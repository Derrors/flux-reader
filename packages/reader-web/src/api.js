import { transport as platformTransport } from './platform/transport';

const REQUIRED_TRANSPORT_METHODS = ['get', 'put', 'post', 'delete'];

/** 后端接口封装；业务端点只依赖 transport，不感知 HTTP 或 Tauri IPC。 */
export function createApi(transport) {
  for (const method of REQUIRED_TRANSPORT_METHODS) {
    if (typeof transport?.[method] !== 'function') {
      throw new TypeError(`transport.${method} 必须是函数`);
    }
  }

  return {
    env: () => transport.get('/env'),
    list: (path, options) => transport.get('/list', { path }, options),
    file: (path, options) => transport.get('/file', { path }, options),
    saveFile: (path, content, expectedRevision, options) => transport.put('/file', {
      path,
      content,
      expectedRevision,
    }, options),
    recoveryState: (path, options) => transport.get('/file-recovery', { path }, options),
    recoveryVersion: (path, recoveryId, version, options) => transport.get('/file-recovery', {
      path,
      recoveryId,
      version,
    }, options),
    commitRecovery: (path, recoveryId, version, expectedRevision, options) => transport.post(
      '/file-recovery/commit',
      {
        path,
        recoveryId,
        version,
        expectedRevision,
      },
      options,
    ),
    discardRecovery: (path, recoveryId, options) => transport.delete('/file-recovery', {
      path,
      recoveryId,
    }, options),
    fileState: (path, options) => transport.get('/file-state', { path }, options),
    search: (paths, query, limit = 100, options) => transport.get('/search', {
      path: Array.isArray(paths) ? paths : [paths],
      q: query,
      limit,
    }, options),
    workspaceState: (path) => transport.get('/workspace-state', { path }),
    resourceUrl: (...args) => transport.resourceUrl?.(...args) ?? null,
    subscribeFileChanges: (listener) => {
      if (typeof transport.subscribeFileChanges !== 'function') {
        return Promise.reject(new Error('当前 transport 不支持文件变更事件'));
      }
      return transport.subscribeFileChanges(listener);
    },
  };
}

export const api = createApi(platformTransport);
