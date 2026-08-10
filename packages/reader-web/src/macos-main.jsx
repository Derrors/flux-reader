import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Toc from './components/Toc';
import MarkdownView from './markdown/MarkdownView';
import { extractToc } from './markdown/pipeline';
import {
  DEFAULT_RENDER_PAYLOAD,
  normalizeRenderPayload,
  resolveMacOSImageSource,
} from './macos/bridge';
import './styles/app.css';
import './styles/markdown.css';
import './styles/macos.css';

let pendingPayload = { ...DEFAULT_RENDER_PAYLOAD };
let renderListener = null;

globalThis.fluxReader = Object.freeze({
  render(value) {
    pendingPayload = normalizeRenderPayload(value);
    renderListener?.(pendingPayload);
    return true;
  },
});

function notifyNativeRendererReady() {
  globalThis.webkit?.messageHandlers?.rendererReady?.postMessage('ready');
}

function MacOSRenderer() {
  const [renderState, setRenderState] = useState(pendingPayload);

  useEffect(() => {
    renderListener = setRenderState;
    setRenderState(pendingPayload);
    notifyNativeRendererReady();

    return () => {
      if (renderListener === setRenderState) renderListener = null;
    };
  }, []);

  useEffect(() => {
    globalThis.document.documentElement.dataset.theme = renderState.theme;
    globalThis.document.title = renderState.title;
  }, [renderState.theme, renderState.title]);

  return <MacOSDocumentView renderState={renderState} />;
}

/** macOS 文稿正文与右侧标题目录；导出纯视图便于隔离原生 bridge 做回归测试。 */
export function MacOSDocumentView({ renderState }) {
  const [tocPinned, setTocPinned] = useState(false);
  const resolveImageSource = useMemo(
    () => (source) => resolveMacOSImageSource(source, renderState.resourceToken),
    [renderState.resourceToken],
  );
  const toc = useMemo(
    () => (renderState.content ? extractToc(renderState.content) : []),
    [renderState.content],
  );

  return (
    <div className="macos-renderer-shell">
      <div className="macos-renderer-scroll">
        <main className="macos-renderer">
          {renderState.content ? (
            <MarkdownView
              content={renderState.content}
              theme={renderState.theme}
              resolveImageSource={resolveImageSource}
            />
          ) : (
            <p className="macos-empty-document">空白文稿</p>
          )}
        </main>
      </div>

      {toc.length > 1 && (
        <aside
          className={`app-toc${tocPinned ? ' is-pinned' : ''}`}
          aria-label="文档目录"
        >
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
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<MacOSRenderer />);
}
