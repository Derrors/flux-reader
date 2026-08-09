import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownView from './markdown/MarkdownView';
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
  const resolveImageSource = useMemo(
    () => (source) => resolveMacOSImageSource(source, renderState.resourceToken),
    [renderState.resourceToken],
  );

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

  return (
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
  );
}

createRoot(document.getElementById('root')).render(<MacOSRenderer />);
