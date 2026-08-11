/**
 * Markdown 主渲染管线。
 *
 * 采用双轨结构：
 *   主轨：marked → HTML → html-react-parser → React 元素
 *   预处理轨：字符串级修正（见 preprocess.js）
 *
 * 为什么不用 react-markdown：它走 unified/rehype 管线，要接入自定义
 * 代码块与图表渲染需要写 rehype 插件；marked + html-react-parser 的
 * 组合可以直接在 React 层替换节点，扩展成本更低。
 *
 * marked 原生支持 GFM 表格 / 任务列表 / 删除线，无需额外注入 micromark 扩展。
 */
import { Marked } from 'marked';
import katex from 'katex';
// 用浏览器原生 dompurify，而非 isomorphic-dompurify：
// 后者为 SSR 打包了 jsdom，阅读器纯跑在浏览器里不需要，白增体积。
import DOMPurify from 'dompurify';
import { preprocess } from './preprocess.js';

/* ------------------------------------------------------------------ *
 * 数学公式：KaTeX
 * 安全配置：output=mathml、trust=false（禁用 \href
 * \includegraphics 等可引入外部资源的命令）、strict、throwOnError。
 * ------------------------------------------------------------------ */
const KATEX_OPTIONS = {
  throwOnError: false, // 阅读器场景：公式写错就原样显示，不要整篇崩
  strict: false,
  output: 'mathml',
  trust: false,
};

function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode });
  } catch {
    // 渲染失败时保留原始文本，方便作者发现问题
    const esc = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return displayMode
      ? `<pre class="math-error">$$${esc}$$</pre>`
      : `<code class="math-error">$${esc}$</code>`;
  }
}

/** 块级公式 $$...$$ */
const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    return src.indexOf('$$');
  },
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
    if (match) {
      return { type: 'mathBlock', raw: match[0], text: match[1].trim() };
    }
    return undefined;
  },
  renderer(token) {
    return `<div class="math math-display">${renderMath(token.text, true)}</div>`;
  },
};

/** 行内公式 $...$ —— 要求 $ 紧邻非空白，避免把货币金额误判成公式 */
const mathInlineExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    return src.indexOf('$');
  },
  tokenizer(src) {
    const match = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (match) {
      return { type: 'mathInline', raw: match[0], text: match[1] };
    }
    return undefined;
  },
  renderer(token) {
    return `<span class="math math-inline">${renderMath(token.text, false)}</span>`;
  },
};

/* ------------------------------------------------------------------ *
 * marked 实例
 * ------------------------------------------------------------------ */
function createMarked() {
  const instance = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
  });

  instance.use({ extensions: [mathBlockExtension, mathInlineExtension] });

  // 代码块：先输出占位结构，语法高亮由 CodeBlock 组件异步接管
  instance.use({
    renderer: {
      code({ text, lang }) {
        const language = (lang || '').trim().split(/\s+/)[0];
        const encoded = encodeURIComponent(text);
        // data-* 承载原始内容，交给 React 组件渲染
        return `<div class="code-placeholder" data-lang="${escapeAttr(language)}" data-code="${encoded}"></div>`;
      },
      // 标题加锚点 id，供 TOC 跳转
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slugify(stripTags(text));
        return `<h${depth} id="${escapeAttr(id)}">${text}</h${depth}>\n`;
      },
    },
  });

  return instance;
}

const marked = createMarked();

const pipelineDiagnostics = {
  preprocessCount: 0,
  lexCount: 0,
  renderCount: 0,
  sanitizeCount: 0,
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '');
}

/** 生成标题锚点 id（保留中文，去掉标点） */
export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ *
 * 净化：默认开启（安全默认值取严的一侧）
 * ------------------------------------------------------------------ */
const PURIFY_CONFIG = {
  ADD_TAGS: [
    // KaTeX 输出 MathML，必须放行这些标签
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msubsup',
    'mfrac', 'msqrt', 'mroot', 'mstyle', 'mtext', 'mspace', 'munder', 'mover',
    'munderover', 'mtable', 'mtr', 'mtd', 'annotation', 'mpadded', 'mphantom',
    'menclose', 'mfenced', 'ms',
  ],
  ADD_ATTR: ['id', 'data-lang', 'data-code', 'class', 'align', 'display', 'mathvariant', 'stretchy'],
  // 禁止内联样式与事件，避免样式注入。
  // 注意不能禁 input：GFM 任务列表 - [x] 依赖 <input type="checkbox">，
  // 下面的 hook 会把它强制改为 disabled 只读，非 checkbox 的 input 一律移除。
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
};

// 任务列表：只放行只读 checkbox，其他 input 类型全部移除
DOMPurify.addHook('afterSanitizeElements', (node) => {
  if (node.nodeName === 'INPUT') {
    const type = (node.getAttribute('type') || '').toLowerCase();
    if (type !== 'checkbox') {
      node.remove();
      return;
    }
    // 阅读器里任务列表不可交互
    node.setAttribute('disabled', 'disabled');
  }

});

// 链接安全：target=_blank 必须补 rel=noopener（防 tabnabbing）
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    // 只允许安全协议
    if (/^(javascript|data|vbscript):/i.test(href.trim())) {
      node.removeAttribute('href');
      return;
    }
    if (href && !href.startsWith('#')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

/**
 * 把 Markdown 源码渲染为已净化的 HTML 字符串。
 */
function lexMarkdown(source) {
  pipelineDiagnostics.lexCount += 1;
  return marked.lexer(source);
}

function renderTokensToSafeHtml(tokens) {
  pipelineDiagnostics.renderCount += 1;
  const html = marked.parser(tokens);
  pipelineDiagnostics.sanitizeCount += 1;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

function extractTocFromTokens(tokens) {
  const toc = [];
  for (const token of tokens) {
    if (token.type !== 'heading') continue;
    const text = stripTags(marked.parseInline(token.text, { async: false }));
    toc.push({ level: token.depth, text, id: slugify(text) });
  }
  return toc;
}

/**
 * 为一次正文 generation 建立共享快照。正文 HTML 与 TOC 从同一份 block
 * tokens 派生，调用方只需按 content identity 缓存这个对象。
 */
export function createMarkdownSnapshot(source) {
  const normalizedSource = String(source || '');
  pipelineDiagnostics.preprocessCount += 1;
  const tokens = lexMarkdown(preprocess(normalizedSource));
  return Object.freeze({
    source: normalizedSource,
    tokens,
    safeHtml: renderTokensToSafeHtml(tokens),
    toc: extractTocFromTokens(tokens),
  });
}

export function getMarkdownPipelineDiagnostics() {
  return { ...pipelineDiagnostics };
}

export function resetMarkdownPipelineDiagnostics() {
  Object.keys(pipelineDiagnostics).forEach((key) => {
    pipelineDiagnostics[key] = 0;
  });
}

export function renderToSafeHtml(source) {
  return renderTokensToSafeHtml(lexMarkdown(String(source || '')));
}

/**
 * 抽取文档大纲（TOC）。
 * 用 marked 的 lexer 而非正则扫描，避免把代码块里的 # 误判成标题。
 *
 * 注意先剥掉 YAML frontmatter：其结束标记 `---` 会被 lexer 当成 setext
 * 下划线，把上一行（如 `version: 0.1.0`）升格为标题，导致目录首项出现
 * 形如「title: xxx author: ...」的脏条目。正文渲染不受影响——那条路径
 * 已由 preprocess 把 frontmatter 转成表格。
 */
export function extractToc(source) {
  return createMarkdownSnapshot(source).toc;
}
