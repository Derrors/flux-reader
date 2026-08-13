import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Toc from './components/Toc';
import MarkdownView from './markdown/MarkdownView';
import { getCachedMarkdownSnapshot } from './markdown/pipeline';
import {
  DEFAULT_RENDER_PAYLOAD,
  normalizeRenderPayload,
  resolveMacOSImageSource,
} from './macos/bridge';
import { applyRenderFeatureFlags } from './renderFeatures';
import './styles/app.css';
import './styles/markdown.css';
import './styles/macos.css';

applyRenderFeatureFlags();

let pendingPayload = { ...DEFAULT_RENDER_PAYLOAD };
let renderListener = null;
let pendingScrollFraction = null;
let programmaticScrollTop = null;

function rendererScrollElement() {
  return globalThis.document?.querySelector('.macos-renderer-scroll') || null;
}

function applyScrollFraction(value) {
  const fraction = Number(value);
  if (!Number.isFinite(fraction)) return false;
  pendingScrollFraction = Math.min(1, Math.max(0, fraction));
  const element = rendererScrollElement();
  if (!element) return false;
  const maximum = Math.max(element.scrollHeight - element.clientHeight, 0);
  const target = maximum * pendingScrollFraction;
  if (Math.abs(element.scrollTop - target) < 1) {
    programmaticScrollTop = null;
    return true;
  }
  programmaticScrollTop = target;
  element.scrollTop = target;
  return true;
}

globalThis.fluxReader = Object.freeze({
  render(value) {
    pendingPayload = normalizeRenderPayload(value);
    renderListener?.(pendingPayload);
    return true;
  },
  setScrollFraction(value) {
    return applyScrollFraction(value);
  },
});

function notifyNativeRendererReady() {
  globalThis.webkit?.messageHandlers?.rendererReady?.postMessage('ready');
}

function notifyNativeContentDidPaint(renderState) {
  globalThis.webkit?.messageHandlers?.contentDidPaint?.postMessage({
    generation: renderState.generation,
    theme: renderState.theme,
    hasContent: Boolean(renderState.content),
  });
}

const VISUAL_STABILITY_TIMEOUT_MS = 1_200;
const VISUAL_STABILITY_MARGIN_PX = 800;

function isNearViewport(element) {
  const rect = element.getBoundingClientRect?.();
  if (!rect) return true;
  const viewportHeight = globalThis.innerHeight || globalThis.document?.documentElement?.clientHeight || 0;
  return rect.bottom >= -VISUAL_STABILITY_MARGIN_PX
    && rect.top <= viewportHeight + VISUAL_STABILITY_MARGIN_PX;
}

function hasPendingInitialVisualWork() {
  const root = globalThis.document?.querySelector('.macos-renderer');
  if (!root) return false;
  // `deferred` 是代码块等待 IntersectionObserver 启动高亮的初始状态。
  // 若只等待 loading，会在首帧先露出纯文本，下一帧才闪成高亮结果。
  const pendingRender = [
    ...root.querySelectorAll('[data-render-state="loading"], [data-render-state="deferred"]'),
  ]
    .some(isNearViewport);
  if (pendingRender) return true;
  return [...root.querySelectorAll('img')]
    .some((image) => isNearViewport(image) && !image.complete);
}

function notifyWhenInitialVisualsSettle(renderState) {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  let frame = 0;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (!hasPendingInitialVisualWork() || now - startedAt >= VISUAL_STABILITY_TIMEOUT_MS) {
      notifyNativeContentDidPaint(renderState);
      return;
    }
    frame = globalThis.requestAnimationFrame(check);
  };
  frame = globalThis.requestAnimationFrame(check);
  return () => {
    cancelled = true;
    if (frame) globalThis.cancelAnimationFrame(frame);
  };
}

export function MacOSRenderer() {
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

  useEffect(() => {
    const element = rendererScrollElement();
    if (!element) return undefined;
    if (pendingScrollFraction != null) applyScrollFraction(pendingScrollFraction);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        if (
          programmaticScrollTop != null
          && Math.abs(element.scrollTop - programmaticScrollTop) < 1
        ) {
          programmaticScrollTop = null;
          return;
        }
        programmaticScrollTop = null;
        const maximum = Math.max(element.scrollHeight - element.clientHeight, 0);
        const fraction = maximum > 0 ? element.scrollTop / maximum : 0;
        pendingScrollFraction = fraction;
        globalThis.webkit?.messageHandlers?.scrollPosition?.postMessage({
          kind: 'user',
          generation: renderState.generation,
          fraction,
        });
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (frame) globalThis.cancelAnimationFrame(frame);
    };
  }, [renderState.content, renderState.generation]);

  return <MacOSDocumentView renderState={renderState} />;
}

/** macOS 文稿正文与右侧标题目录；导出纯视图便于隔离原生 bridge 做回归测试。 */
export function MacOSDocumentView({ renderState }) {
  const [tocPinned, setTocPinned] = useState(false);
  const resolveImageSource = useMemo(
    () => (source) => resolveMacOSImageSource(source, renderState.resourceToken),
    [renderState.resourceToken],
  );
  const markdownSnapshot = useMemo(
    () => getCachedMarkdownSnapshot(renderState.content),
    [renderState.content],
  );
  const toc = markdownSnapshot.toc;

  useEffect(() => {
    if (!renderState.generation) return undefined;
    return notifyWhenInitialVisualsSettle(renderState);
  }, [renderState.content, renderState.generation, renderState.theme]);

  return (
    <div className="macos-renderer-shell">
      <div className="macos-renderer-scroll">
        <main className="macos-renderer">
          {renderState.content ? (
            <MarkdownView
              content={renderState.content}
              snapshot={markdownSnapshot}
              theme={renderState.theme}
              resolveImageSource={resolveImageSource}
              findQuery={renderState.findQuery}
              findCaseSensitive={renderState.findCaseSensitive}
              activeFindMatch={renderState.activeFindMatch}
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
  const root = createRoot(rootElement);
  if (import.meta.env.MODE === 'contract-macos') {
    import('./render-contract/RenderContractHarness').then(({ default: Harness }) => {
      root.render(<Harness entry="macos" />);
    });
  } else {
    root.render(<MacOSRenderer />);
  }
}
