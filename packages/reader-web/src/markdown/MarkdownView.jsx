/**
 * MarkdownView：渲染主组件。
 *
 * 流程：
 *   preprocess(源码) → marked → 净化 HTML → html-react-parser → React
 *   其中代码块被替换为占位 div，在此处换成 <CodeBlock/> 组件。
 */
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import parse, { attributesToProps, domToReact, Element } from 'html-react-parser';
import { createMarkdownSnapshot } from './pipeline';
import CodeBlock from './CodeBlock';
import MediaFrame from './MediaFrame';
import { cancelHighlightSession, createHighlightSession } from './highlight';
import 'katex/dist/katex.min.css';

const MarkdownRuntimeContext = createContext({
  theme: 'light',
  highlightSessionId: '',
  resolveImageSource: undefined,
});

// 与 pipeline 的 snapshot LRU 配合：同一 snapshot 返回标签时直接复用
// html-react-parser 生成的不可变 React 元素树。WeakMap 不延长 snapshot 生命周期。
let parsedSnapshotCache = new WeakMap();
let parsedSnapshotCacheHits = 0;
let parsedSnapshotCacheMisses = 0;

export function getParsedSnapshotCacheDiagnostics() {
  return { hits: parsedSnapshotCacheHits, misses: parsedSnapshotCacheMisses };
}

export function resetParsedSnapshotCache() {
  parsedSnapshotCache = new WeakMap();
  parsedSnapshotCacheHits = 0;
  parsedSnapshotCacheMisses = 0;
}

/**
 * 图片编组：段落内连续多张图片排成网格，而非竖排堆叠。
 * 这里在 React 层判断，比在 AST 层实现更直接。
 */
function isImageOnlyParagraph(node) {
  const meaningful = node.children.filter(
    (c) => !(c.type === 'text' && !c.data.trim()),
  );
  if (meaningful.length < 2) return false;
  return meaningful.every((c) => c instanceof Element && c.name === 'img');
}

function resolvedImageSource(source, resolveImageSource) {
  const src = String(source || '').trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  if (/^(?:javascript|data|vbscript|file):/i.test(src) || src.startsWith('//')) {
    return null;
  }
  return resolveImageSource?.(src) || null;
}

function RuntimeImage({ source, framed = true, ...props }) {
  const { resolveImageSource } = useContext(MarkdownRuntimeContext);
  const src = resolvedImageSource(source, resolveImageSource);
  if (!src) return null;
  if (!framed) return <img {...props} src={src} />;
  const label = props.alt ? `图片“${props.alt}”` : '图片';
  return (
    <MediaFrame className="resizable-image" label={label}>
      <img {...props} src={src} />
    </MediaFrame>
  );
}

function RuntimeLinkedImage({ imageNode, linkNode }) {
  const imageProps = attributesToProps(imageNode.attribs || {});
  const linkProps = attributesToProps(linkNode.attribs || {});
  const source = imageProps.src;
  delete imageProps.src;
  delete imageProps.srcSet;
  const label = imageProps.alt ? `图片“${imageProps.alt}”` : '图片';
  return (
    <MediaFrame className="resizable-image" label={label}>
      <a {...linkProps}>
        <RuntimeImage {...imageProps} source={source} framed={false} />
      </a>
    </MediaFrame>
  );
}

function linkedImageChild(node) {
  const meaningful = node.children.filter(
    (child) => !(child.type === 'text' && !child.data.trim()),
  );
  if (meaningful.length !== 1) return null;
  const [child] = meaningful;
  return child instanceof Element && child.name === 'img' ? child : null;
}

function RuntimeCodeBlock({ code, language }) {
  const { theme, highlightSessionId } = useContext(MarkdownRuntimeContext);
  return (
    <CodeBlock
      code={code}
      language={language}
      theme={theme}
      highlightSessionId={highlightSessionId}
    />
  );
}

export default function MarkdownView({
  content,
  theme = 'light',
  className = '',
  resolveImageSource,
  findQuery = '',
  findCaseSensitive = false,
  activeFindMatch = 0,
  onFindMatchCountChange,
  snapshot,
}) {
  const rootRef = useRef(null);
  const highlightSessionId = useMemo(
    () => createHighlightSession(),
    [content, theme],
  );

  useEffect(
    () => () => cancelHighlightSession(highlightSessionId),
    [highlightSessionId],
  );

  const ownedSnapshot = useMemo(
    () => (
      snapshot?.source === String(content || '')
        ? snapshot
        : createMarkdownSnapshot(content)
    ),
    [content, snapshot],
  );
  const html = ownedSnapshot.safeHtml;

  const runtime = useMemo(
    () => ({ theme, highlightSessionId, resolveImageSource }),
    [highlightSessionId, resolveImageSource, theme],
  );

  const renderResult = useMemo(() => {
    if (!html) return { content: null, matchCount: 0 };

    const canReuseParsedTree = !findQuery;
    if (canReuseParsedTree) {
      const cached = parsedSnapshotCache.get(ownedSnapshot);
      if (cached) {
        parsedSnapshotCacheHits += 1;
        return cached;
      }
      parsedSnapshotCacheMisses += 1;
    }

    let matchIndex = 0;
    const normalizedQuery = findCaseSensitive ? findQuery : findQuery.toLocaleLowerCase();

    const highlightText = (value) => {
      if (!normalizedQuery) return undefined;
      const comparable = findCaseSensitive ? value : value.toLocaleLowerCase();
      const pieces = [];
      let offset = 0;
      while (offset <= comparable.length - normalizedQuery.length) {
        const index = comparable.indexOf(normalizedQuery, offset);
        if (index < 0) break;
        if (index > offset) pieces.push(value.slice(offset, index));
        const currentIndex = matchIndex;
        matchIndex += 1;
        pieces.push(
          <mark
            key={`find-${currentIndex}-${index}`}
            className="markdown-find-match"
            data-find-match={currentIndex}
          >
            {value.slice(index, index + findQuery.length)}
          </mark>,
        );
        offset = index + normalizedQuery.length;
      }
      if (matchIndex === 0 || offset === 0) return undefined;
      if (offset < value.length) pieces.push(value.slice(offset));
      return <Fragment>{pieces}</Fragment>;
    };

    const options = {
      replace(node) {
        if (node.type === 'text' && typeof node.data === 'string') {
          return highlightText(node.data);
        }
        if (!(node instanceof Element)) return undefined;

        if (node.name === 'a') {
          const imageNode = linkedImageChild(node);
          if (imageNode) {
            return <RuntimeLinkedImage imageNode={imageNode} linkNode={node} />;
          }
        }

        if (node.name === 'img') {
          const props = attributesToProps(node.attribs || {});
          const source = props.src;
          delete props.src;
          delete props.srcSet;
          return (
            <RuntimeImage
              {...props}
              source={source}
              framed
            />
          );
        }

        // 代码块占位 → CodeBlock 组件
        if (node.name === 'div' && node.attribs?.class === 'code-placeholder') {
          const raw = node.attribs['data-code'] || '';
          let code = '';
          try {
            code = decodeURIComponent(raw);
          } catch {
            code = raw;
          }
          return (
            <RuntimeCodeBlock
              code={code}
              language={node.attribs['data-lang'] || ''}
            />
          );
        }

        // 连续多图的段落 → 图片组
        if (node.name === 'p' && isImageOnlyParagraph(node)) {
          const imgs = node.children.filter((c) => c instanceof Element && c.name === 'img');
          return (
            <div className="image-group" data-count={imgs.length}>
              {domToReact(imgs, options)}
            </div>
          );
        }

        // 表格外包一层容器，窄屏可横向滚动
        if (node.name === 'table') {
          return (
            <div className="table-container">
              <table>{domToReact(node.children, options)}</table>
            </div>
          );
        }

        return undefined;
      },
    };

    const parsed = parse(html, options);
    const result = { content: parsed, matchCount: matchIndex };
    if (canReuseParsedTree) parsedSnapshotCache.set(ownedSnapshot, result);
    return result;
  }, [
    findCaseSensitive,
    findQuery,
    html,
    ownedSnapshot,
  ]);

  useEffect(() => {
    onFindMatchCountChange?.(renderResult.matchCount);
  }, [onFindMatchCountChange, renderResult.matchCount]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelector('.markdown-find-match.is-active')?.classList.remove('is-active');
    root
      .querySelector(`[data-find-match="${activeFindMatch}"]`)
      ?.classList.add('is-active');
  }, [activeFindMatch, renderResult.content]);

  useEffect(() => {
    if (!findQuery || renderResult.matchCount === 0) return;
    const selector = `[data-find-match="${activeFindMatch}"]`;
    rootRef.current
      ?.querySelector(selector)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeFindMatch, findQuery, renderResult.matchCount]);

  return (
    <MarkdownRuntimeContext.Provider value={runtime}>
      <div ref={rootRef} className={`flow-markdown-body ${className}`.trim()}>
        <div className="markdown-root">{renderResult.content}</div>
      </div>
    </MarkdownRuntimeContext.Provider>
  );
}
