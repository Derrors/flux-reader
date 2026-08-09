/**
 * MarkdownView：渲染主组件。
 *
 * 流程：
 *   preprocess(源码) → marked → 净化 HTML → html-react-parser → React
 *   其中代码块被替换为占位 div，在此处换成 <CodeBlock/> 组件。
 */
import { useMemo } from 'react';
import parse, { attributesToProps, domToReact, Element } from 'html-react-parser';
import { preprocess } from './preprocess';
import { renderToSafeHtml } from './pipeline';
import CodeBlock from './CodeBlock';
import 'katex/dist/katex.min.css';

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

export default function MarkdownView({
  content,
  theme = 'light',
  className = '',
  resolveImageSource,
}) {
  const html = useMemo(() => {
    if (!content) return '';
    return renderToSafeHtml(preprocess(content));
  }, [content]);

  const rendered = useMemo(() => {
    if (!html) return null;

    const options = {
      replace(node) {
        if (!(node instanceof Element)) return undefined;

        if (node.name === 'img') {
          const src = resolvedImageSource(node.attribs?.src, resolveImageSource);
          if (!src) return <></>;

          const props = attributesToProps(node.attribs || {});
          delete props.srcSet;
          return <img {...props} src={src} />;
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
            <CodeBlock
              code={code}
              language={node.attribs['data-lang'] || ''}
              theme={theme}
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

    return parse(html, options);
  }, [html, resolveImageSource, theme]);

  return (
    <div className={`flow-markdown-body ${className}`.trim()}>
      <div className="markdown-root">{rendered}</div>
    </div>
  );
}
