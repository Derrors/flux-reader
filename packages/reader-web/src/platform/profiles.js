import { DEFAULT_PRODUCT_POLICY } from './environment';

export const FNOS_APP_PROFILE = Object.freeze({
  id: 'fnos',
  // fnos-reader remains as a legacy shared-style hook until app.css is split;
  // platform-fnos is the only selector new platform-specific UI should use.
  rootClassName: 'web-reader fnos-reader platform-fnos',
  defaultPolicy: DEFAULT_PRODUCT_POLICY,
  readOnlySaveMessage: '当前文稿为只读；请在 fnOS 应用设置中授予读写权限后重试',
  readOnlyNotice: '当前文稿只读。如需编辑，请在 fnOS「系统设置 → 应用 → Flux Reader → 访问权限」中将目录调整为读写。',
  unavailableMessage: '当前不在 fnOS 环境中，请安装到 fnOS 后打开已授权的 Markdown 文档。',
});

export const WINDOWS_APP_PROFILE = Object.freeze({
  id: 'windows',
  rootClassName: 'web-reader fnos-reader windows-reader platform-windows',
  defaultPolicy: DEFAULT_PRODUCT_POLICY,
  readOnlySaveMessage: '当前文稿为只读；请检查 Windows 文件权限后重试',
  readOnlyNotice: '当前文稿只读。如需编辑，请在 Windows 文件属性或安全设置中授予写入权限。',
  unavailableMessage: 'Windows 本地文件服务暂不可用，请重新启动 Flux Reader 后重试。',
});

export function appProfileFor(platform) {
  return platform === 'windows' ? WINDOWS_APP_PROFILE : FNOS_APP_PROFILE;
}
