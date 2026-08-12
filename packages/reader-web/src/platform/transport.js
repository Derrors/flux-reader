import { httpTransport } from './transport-http';
import { createGlobalTauriTransport, hasTauriInvoke } from './transport-tauri';

/** Tauri 全局 API 只在 Windows WebView 中存在；fnOS 默认仍使用原 HTTP 路径。 */
export function selectTransport(scope = globalThis) {
  return hasTauriInvoke(scope) ? createGlobalTauriTransport(scope) : httpTransport;
}

export const transport = selectTransport();
