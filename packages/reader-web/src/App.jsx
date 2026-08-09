import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownView from './markdown/MarkdownView';
import { extractToc } from './markdown/pipeline';
import { api } from './api';
import { initSdk, pickFolder, pickMarkdownFile, setTitle } from './trim-sdk';
import FileTree from './components/FileTree';
import Toc from './components/Toc';

/**
 * 读取启动参数中的目标文件路径。
 *
 * 从文件管理器双击 .md 打开本应用时，系统会把文件路径作为 query 参数带进来
 * （见 app/ui/config 的 fileTypes 注册）。不同版本用过 path / file 两种键名，
 * 这里都认；只接受绝对路径且扩展名合法的值，其余忽略。
 */
function readLaunchPath() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('path') || params.get('file');
    if (!raw) return null;
    // URLSearchParams.get 已完成一次 URL 解码；再次 decodeURIComponent 会破坏
    // 文件名中合法的百分号或形如 %20 的字面内容。
    const filePath = raw;
    if (!filePath.startsWith('/')) return null;
    if (filePath.includes('\0')) return null;
    if (!/\.(md|markdown|mdx)$/i.test(filePath)) return null;
    return filePath;
  } catch {
    return null;
  }
}

/** 从绝对路径取最后一段，供标题与文件夹根节点展示。 */
function basename(filePath) {
  return String(filePath).split('/').filter(Boolean).pop() || filePath;
}

export default function App() {
  const [theme, setTheme] = useState('light');
  const [env, setEnv] = useState(null);
  // folderRoot 只表示用户本次会话主动“打开”的目录；系统设置中的全部共享
  // 授权根不会自动灌入这里，因此普通启动与文件关联启动都没有左侧栏。
  const [folderRoot, setFolderRoot] = useState(null);
  const [current, setCurrent] = useState(null); // { path, name, displayPath }
  // null = 尚未成功打开文档；空字符串是合法的 0 字节 Markdown。
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tocPinned, setTocPinned] = useState(false);

  const launchPathRef = useRef(readLaunchPath());
  const isFileLaunch = launchPathRef.current !== null;
  const launchHandledRef = useRef(false);
  const pendingOpenRef = useRef(null);
  const documentRequestSeqRef = useRef(0);
  const folderRequestSeqRef = useRef(0);
  const folderRevisionRef = useRef(0);
  const pickerActiveRef = useRef(false);
  const folderRootRef = useRef(folderRoot);
  folderRootRef.current = folderRoot;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* ---------- 打开文档（latest-wins，避免慢响应覆盖新选择） ---------- */
  const openFile = useCallback(async (item, { standalone = false } = {}) => {
    const requestSeq = ++documentRequestSeqRef.current;
    pendingOpenRef.current = null;
    setLoading(true);
    setError('');
    try {
      const { content: text } = await api.file(item.path);
      if (requestSeq !== documentRequestSeqRef.current) return false;
      setContent(typeof text === 'string' ? text : '');
      setCurrent(item);
      await setTitle(item.name || item.displayPath || 'Flux Reader');
      if (requestSeq !== documentRequestSeqRef.current) return false;
      if (standalone) {
        // 直接打开文件与文件关联启动都进入单文件态。等标题桥接完成并再次
        // 确认仍是最新请求后才清理旧目录，避免慢请求误伤后来的文件树操作。
        folderRequestSeqRef.current += 1;
        folderRootRef.current = null;
        setFolderRoot(null);
        setSidebarOpen(false);
      }
      window.scrollTo({ top: 0 });
      return true;
    } catch (err) {
      if (requestSeq !== documentRequestSeqRef.current) return false;
      setError(err.message);
      // 403 可能表示系统设置尚未授权该路径；从系统设置返回后直接重试
      // 这个文件，不加载也不展示全部共享授权目录。
      if (err.status === 403) pendingOpenRef.current = { item, standalone };
      return false;
    } finally {
      if (requestSeq === documentRequestSeqRef.current) setLoading(false);
    }
  }, []);

  /* ---------- 校验并打开本次会话的文件夹 ---------- */
  const openFolderPath = useCallback(async (folderPath) => {
    if (isFileLaunch) return false;
    const requestSeq = ++folderRequestSeqRef.current;
    setPickingFolder(true);
    setError('');
    try {
      // pickFile 只负责选择；/list 才是可信边界，会继续校验系统共享授权、
      // 当前用户 ACL、真实路径、软链接与目录类型。
      const { entries } = await api.list(folderPath);
      if (requestSeq !== folderRequestSeqRef.current) return false;
      const revision = ++folderRevisionRef.current;
      setFolderRoot({
        path: folderPath,
        name: basename(folderPath),
        displayPath: folderPath,
        type: 'directory',
        initialChildren: Array.isArray(entries) ? entries : [],
        revision,
      });
      setSidebarOpen(true);
      return true;
    } catch (err) {
      if (requestSeq !== folderRequestSeqRef.current) return false;
      // 选择失败或越权时保留旧的有效目录，不把未校验路径放入文件树。
      setError(err.message);
      return false;
    } finally {
      if (requestSeq === folderRequestSeqRef.current) setPickingFolder(false);
    }
  }, [isFileLaunch]);

  const onOpenFolder = useCallback(async () => {
    if (isFileLaunch || pickerActiveRef.current) return;
    pickerActiveRef.current = true;
    // 让点击选择器前已经在途的目录刷新失效，避免它在选择期间改写状态。
    folderRequestSeqRef.current += 1;
    setPickingFolder(true);
    try {
      const folderPath = await pickFolder();
      if (folderPath) await openFolderPath(folderPath);
    } catch (err) {
      setError(err.message);
    } finally {
      pickerActiveRef.current = false;
      setPickingFolder(false);
    }
  }, [isFileLaunch, openFolderPath]);

  /* ---------- 直接选择并打开一个 Markdown 文件 ---------- */
  const onOpenStandaloneFile = useCallback(async () => {
    if (pickerActiveRef.current) return;
    pickerActiveRef.current = true;
    // 选择器打开前让旧目录刷新失效；只有文件读取成功后才真正清理目录。
    folderRequestSeqRef.current += 1;
    setPickingFile(true);
    try {
      const filePath = await pickMarkdownFile();
      if (!filePath) return;
      await openFile(
        { path: filePath, name: basename(filePath), displayPath: filePath },
        { standalone: true },
      );
    } catch (err) {
      setError(err.message);
    } finally {
      pickerActiveRef.current = false;
      setPickingFile(false);
    }
  }, [openFile]);

  /* ---------- 加载内置示例 ---------- */
  const loadSample = useCallback(async () => {
    const requestSeq = ++documentRequestSeqRef.current;
    pendingOpenRef.current = null;
    setLoading(true);
    setError('');
    try {
      const { content: text } = await api.sample();
      if (requestSeq !== documentRequestSeqRef.current) return;
      setContent(typeof text === 'string' ? text : '');
      setCurrent({ name: '渲染能力示例', displayPath: '内置示例文档' });
      await setTitle('渲染能力示例');
    } catch (err) {
      if (requestSeq === documentRequestSeqRef.current) setError(err.message);
    } finally {
      if (requestSeq === documentRequestSeqRef.current) setLoading(false);
    }
  }, []);

  /* ---------- 初始化：SDK + 环境 ---------- */
  useEffect(() => {
    let active = true;
    (async () => {
      await initSdk();
      if (!active) return;

      try {
        const nextEnv = await api.env();
        if (active) setEnv(nextEnv);
      } catch (err) {
        if (active) setError(err.message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  /* ---------- 文件关联启动：只打开目标文件，不创建左侧目录 ---------- */
  useEffect(() => {
    const target = launchPathRef.current;
    if (!target || launchHandledRef.current || !env) return;
    launchHandledRef.current = true;
    setFolderRoot(null);
    setSidebarOpen(false);
    openFile(
      { path: target, name: basename(target), displayPath: target },
      { standalone: true },
    );
  }, [env, openFile]);

  /* ---------- 从系统设置返回：刷新当前会话目录并重试待打开文件 ---------- */
  const refreshAccessState = useCallback(async () => {
    if (pickerActiveRef.current) return;

    const selected = folderRootRef.current;
    if (selected) {
      const requestSeq = ++folderRequestSeqRef.current;
      try {
        const { entries } = await api.list(selected.path);
        if (pickerActiveRef.current) return;
        if (
          requestSeq === folderRequestSeqRef.current &&
          folderRootRef.current?.path === selected.path
        ) {
          const revision = ++folderRevisionRef.current;
          setFolderRoot({
            ...selected,
            initialChildren: Array.isArray(entries) ? entries : [],
            revision,
          });
        }
      } catch (err) {
        if (pickerActiveRef.current) return;
        if (requestSeq === folderRequestSeqRef.current) {
          if (err.status === 403 || err.status === 404) {
            setFolderRoot(null);
            setSidebarOpen(false);
          }
          setError(err.message);
        }
      }
    }

    if (pickerActiveRef.current) return;
    const retry = pendingOpenRef.current;
    if (retry) {
      pendingOpenRef.current = null;
      await openFile(retry.item, { standalone: retry.standalone });
    }
  }, [openFile]);

  useEffect(() => {
    if (!env) return undefined;

    let timerId = null;
    const scheduleRefresh = () => {
      if (document.visibilityState === 'hidden' || pickerActiveRef.current) return;
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        timerId = null;
        void refreshAccessState();
      }, 150);
    };

    window.addEventListener('focus', scheduleRefresh);
    document.addEventListener('visibilitychange', scheduleRefresh);
    return () => {
      window.removeEventListener('focus', scheduleRefresh);
      document.removeEventListener('visibilitychange', scheduleRefresh);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [env, refreshAccessState]);

  useEffect(
    () => () => {
      documentRequestSeqRef.current += 1;
      folderRequestSeqRef.current += 1;
    },
    [],
  );

  const toc = useMemo(
    () => (typeof content === 'string' && content ? extractToc(content) : []),
    [content],
  );
  const hasDocument = content !== null;
  const showSidebar = Boolean(!isFileLaunch && folderRoot && sidebarOpen);

  return (
    <div className="app" data-theme={theme}>
      <header className="app-header">
        {!isFileLaunch && folderRoot && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSidebarOpen((value) => !value)}
            title={sidebarOpen ? '隐藏文件目录' : '显示文件目录'}
            aria-label={sidebarOpen ? '隐藏文件目录' : '显示文件目录'}
            aria-pressed={sidebarOpen}
          >
            ☰
          </button>
        )}
        <h1 className="app-title">
          {current ? current.name || current.displayPath : 'Flux Reader'}
        </h1>
        <div className="app-header-actions">
          {env?.openApiAvailable && (
            <button
              type="button"
              className={!hasDocument && !folderRoot ? 'primary-btn' : undefined}
              onClick={onOpenStandaloneFile}
              disabled={pickingFile || pickingFolder}
              title="直接选择一个已在应用设置中授权的 Markdown 文件"
            >
              {pickingFile ? '选择中…' : '打开文件'}
            </button>
          )}
          {!isFileLaunch && env?.openApiAvailable && (
            <button
              type="button"
              onClick={onOpenFolder}
              disabled={pickingFolder || pickingFile}
              title="选择已在应用设置中授权的文件夹"
            >
              {pickingFolder ? '选择中…' : '打开文件夹'}
            </button>
          )}
          <button type="button" onClick={loadSample} disabled={loading}>
            渲染示例
          </button>
          <button
            type="button"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            title="切换主题"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="app-body">
        {showSidebar && (
          <aside className="app-sidebar">
            <FileTree
              root={folderRoot}
              currentPath={current?.path}
              onOpenFile={openFile}
            />
          </aside>
        )}

        <main className="app-main">
          {error && (
            <div className="notice notice-error">
              <strong>提示：</strong>
              {error}
            </div>
          )}

          {loading && <div className="notice">加载中…</div>}

          {!loading && !hasDocument && !error && (
            <div className="empty-state">
              <h2>还没有打开文档</h2>
              <p>
                {env?.openApiAvailable
                  ? isFileLaunch
                    ? '点击「打开文件」选择另一个 Markdown 文档，或先看「渲染示例」。'
                    : '点击「打开文件」直接阅读 Markdown，或点击「打开文件夹」浏览已授权目录。'
                  : '当前不在 fnOS 环境中，可点击「渲染示例」预览渲染效果。'}
              </p>
            </div>
          )}

          {hasDocument && <MarkdownView content={content} theme={theme} />}
        </main>

        {hasDocument && toc.length > 1 && (
          <aside className={`app-toc${tocPinned ? ' is-pinned' : ''}`}>
            <div className="app-toc-panel">
              <Toc
                items={toc}
                pinned={tocPinned}
                onTogglePinned={() => setTocPinned((value) => !value)}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
