/**
 * 代码块组件：先纯文本上屏，再异步回填 shiki 高亮结果。
 * 这样在 NAS 这类较弱硬件上也不会白屏或卡顿。
 */
import { useEffect, useRef, useState } from 'react';
import { writeClipboardText } from '../platform/clipboard';
import { RENDER_FEATURES } from '../renderFeatures';
import { highlightCode, isHugeCode } from './highlight';
import Mermaid from './Mermaid';

const MAX_COLLAPSED_LINES = 20;

/**
 * 带高亮的普通代码块。
 *
 * 独立成组件是必需的，不能内联进 CodeBlock 里按语言提前 return：
 * React 依赖 Hook 的调用顺序稳定，若同一位置的组件实例在
 * 「mermaid（无 Hook）」与「普通语言（有 Hook）」之间切换，
 * Hook 数量变化会触发 "Rendered fewer/more hooks than expected"
 * 并使整棵渲染树报错。拆开后每个组件实例的 Hook 顺序恒定。
 */
function HighlightedCodeBlock({ code, language, theme, highlightSessionId }) {
  const [html, setHtml] = useState(null);
  const [renderState, setRenderState] = useState('deferred');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [nearViewport, setNearViewport] = useState(
    () => !RENDER_FEATURES.viewportHighlighting
      || typeof IntersectionObserver !== 'function',
  );
  const aliveRef = useRef(true);
  const containerRef = useRef(null);

  const lineCount = code ? code.split('\n').length : 0;
  const collapsible = lineCount > MAX_COLLAPSED_LINES;
  const huge = isHugeCode(code || '');

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      nearViewport
      || !RENDER_FEATURES.viewportHighlighting
      || typeof IntersectionObserver !== 'function'
    ) return undefined;
    const element = containerRef.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '800px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    const renderForPrint = () => setNearViewport(true);
    window.addEventListener('beforeprint', renderForPrint);
    return () => window.removeEventListener('beforeprint', renderForPrint);
  }, []);

  useEffect(() => {
    setHtml(null);
    if (huge) {
      setRenderState('skipped');
      return;
    }
    if (!nearViewport) {
      setRenderState('deferred');
      return;
    }
    setRenderState('loading');
    let cancelled = false;
    highlightCode(code, language, theme, {
      sessionId: highlightSessionId,
      priority: 100,
    })
      .then((out) => {
        if (!cancelled && aliveRef.current) {
          setHtml(out);
          setRenderState(out ? 'highlighted' : 'skipped');
        }
      })
      .catch(() => {
        if (!cancelled && aliveRef.current) {
          setHtml(null);
          setRenderState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, highlightSessionId, language, nearViewport, theme, huge]);

  const copy = async () => {
    try {
      await writeClipboardText(code);
      setCopied(true);
      setTimeout(() => aliveRef.current && setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默失败 */
    }
  };

  const bodyStyle =
    collapsible && !expanded
      ? { maxHeight: `${MAX_COLLAPSED_LINES * 1.5}em`, overflow: 'auto' }
      : undefined;

  return (
    <div
      ref={containerRef}
      className="code-block"
      data-render-state={renderState}
    >
      <div className="code-block-header" data-copy-ignore>
        <span className="code-block-lang">{language || 'text'}</span>
        <span className="code-block-actions">
          {collapsible && (
            <button type="button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : `展开 (${lineCount} 行)`}
            </button>
          )}
          <button type="button" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>

      <div className="code-block-body" style={bodyStyle}>
        {html ? (
          // shiki 输出的是结构化 <pre>，内容来自本地文件且已由 shiki 转义
          <div className="shiki-wrapper" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="code-plain">
            <code>{code}</code>
          </pre>
        )}
      </div>

      {huge && <div className="code-block-note">代码过长，已关闭语法高亮以保证性能</div>}
    </div>
  );
}

/** 分派层：只做选择，自身不含任何 Hook */
export default function CodeBlock({ code, language, theme, highlightSessionId }) {
  if (language === 'mermaid') {
    return <Mermaid code={code} theme={theme} />;
  }
  return (
    <HighlightedCodeBlock
      code={code}
      language={language}
      theme={theme}
      highlightSessionId={highlightSessionId}
    />
  );
}
