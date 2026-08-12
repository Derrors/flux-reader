import { isAbsoluteHostPath } from './platform/path';

/** fnOS / Tauri 宿主选择器的最小封装。 */
let sdk = null;
let initError = null;
let initPromise = null;

function normalizeAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  // 路径是不可改写的标识。不能 trim，否则会把合法的末尾空格路径指向
  // 另一个对象；这里只做结构校验，权限和真实路径交给后端处理。
  if (!isAbsoluteHostPath(value) || value.includes('\0')) return null;
  return value;
}

function createTauriSdk(scope = globalThis) {
  const invoke = scope.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return null;
  return Object.freeze({
    isStandaloneWeb: false,
    async pickFile(params) {
      const command = params?.directory
        ? 'reader_pick_folder'
        : 'reader_pick_markdown_file';
      const selected = await invoke(command);
      return selected == null ? null : [selected];
    },
    setTitle(title) {
      return invoke('reader_set_title', { title });
    },
  });
}

async function pickSinglePath(params, kind) {
  const initialized = await initSdk();
  if (!initialized.sdk) {
    throw new Error(`fnOS 文件选择器不可用：${initialized.error || 'SDK 未初始化'}`);
  }
  if (initialized.sdk.isStandaloneWeb) {
    throw new Error('当前页面没有 fnOS 文件选择器，请从 fnOS 桌面打开 Flux Reader 后再试');
  }

  const paths = await initialized.sdk.pickFile(params);
  if (paths == null) return null;
  if (!Array.isArray(paths)) throw new Error('文件选择器返回格式异常');
  if (paths.length === 0) return null;
  if (paths.length !== 1) throw new Error(`文件选择器返回了多个${kind}`);

  const selectedPath = normalizeAbsolutePath(paths[0]);
  if (!selectedPath) throw new Error(`文件选择器返回了无效的${kind}路径`);
  return selectedPath;
}

/** 初始化宿主 bridge；本地浏览器直开失败属于预期情况。 */
export async function initSdk() {
  if (sdk || initError) return { sdk, error: initError };
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const tauriSdk = createTauriSdk();
        if (tauriSdk) {
          sdk = tauriSdk;
          return;
        }
        const mod = await import('@trimjs/web-app');
        const TrimApp = mod.TrimApp || mod.default?.TrimApp;
        if (!TrimApp) throw new Error('@trimjs/web-app 未导出 TrimApp');
        const instance = new TrimApp();
        await instance.ready();
        sdk = instance;
      } catch (err) {
        initError = err?.message || String(err);
      }
    })();
  }
  await initPromise;
  return { sdk, error: initError };
}

/**
 * 打开宿主文件夹选择器。fnOS 只选择已有授权路径；Tauri 在原生对话框
 * 成功返回后把规范路径登记为当前 WebView 的授权根。
 *
 * 应用正式入口在 app/ui/config 中声明为 iframe；移动客户端也提供原生桥接。
 * standalone 网页没有可保持当前阅读状态的宿主选择器，因此明确拒绝，避免
 * 整页跳转后用户取消选择却丢失当前文档与文件树。
 */
export async function pickFolder() {
  return pickSinglePath({
    directory: true,
    multiple: false,
    title: '打开文件夹',
    okText: '打开',
    creatable: false,
  }, '目录');
}

/** 打开宿主文件选择器，仅允许选择一个 Markdown 文件。 */
export async function pickMarkdownFile() {
  const filePath = await pickSinglePath({
    directory: false,
    multiple: false,
    accept: ['.md', '.markdown', '.mdx'],
    title: '打开 Markdown 文件',
    okText: '打开',
  }, '文件');
  if (filePath && !/\.(md|markdown|mdx)$/i.test(filePath)) {
    throw new Error('请选择 Markdown 文件（.md、.markdown 或 .mdx）');
  }
  return filePath;
}

/** 设置宿主页面标题；失败不影响 Markdown 阅读。 */
export async function setTitle(title) {
  if (!sdk) return;
  try {
    await sdk.setTitle(title);
  } catch {
    /* 忽略宿主桥接异常 */
  }
}
