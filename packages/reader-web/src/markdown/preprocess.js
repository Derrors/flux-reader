/**
 * Markdown 源码预处理：在解析前做的字符串级改写。
 *
 * 这些都发生在 marked 解析之前，属于纯字符串变换。
 * 说明：AI 对话类产品常见的那套「截断语法自动修复」插件是为流式输出
 * （逐 token 到达、语法可能半截）设计的；阅读器场景文档始终完整，
 * 因此不需要，这里只保留对完整文档同样有意义的几项。
 */

/**
 * 在 setext 下划线（--- / ===）前补空行。
 *
 * 目的：形如
 *     一段正文
 *     ---
 * 会被 Markdown 规范解析成「一段正文」是 h2 标题，而作者本意
 * 通常是分隔线。补一个空行让它回归 <hr>。
 *
 * 跳过 fenced code 块内部，避免破坏代码内容。
 */
export function breakSetextHeadings(src) {
  const lines = src.split('\n');
  const out = [];
  let inFence = false;
  let fenceMark = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);

    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1][0];
      } else if (fence[1][0] === fenceMark) {
        inFence = false;
        fenceMark = '';
      }
      out.push(line);
      continue;
    }

    // 仅在代码块外处理：当前行是纯 --- / === 且上一行是非空文本
    if (!inFence && /^\s*(-{3,}|={3,})\s*$/.test(line)) {
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.trim() !== '') {
        out.push('');
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 把 YAML frontmatter 转成一个 Markdown 表格展示，
 * 而不是隐藏它或原样输出。
 */
export function convertFrontmatterToTable(src) {
  const match = src.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!match) return src;

  const body = match[1];
  const rows = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    // 表格单元格内的 | 需转义，否则会把列拆错
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/\|/g, '\\|');
    if (key) rows.push(`| ${key} | ${value} |`);
  }
  if (rows.length === 0) return src.slice(match[0].length);

  const table = ['| 字段 | 值 |', '| --- | --- |', ...rows].join('\n');
  return `${table}\n\n${src.slice(match[0].length)}`;
}

/** 组合全部预处理 */
export function preprocess(src) {
  if (!src) return '';
  let out = src.replace(/\r\n/g, '\n');
  out = convertFrontmatterToTable(out);
  out = breakSetextHeadings(out);
  return out;
}

/**
 * TOC 抽取专用预处理。
 *
 * 与 preprocess 的区别：frontmatter 是**剥掉**而非转成表格 —— 目录里不需要
 * 元信息，转成表格反而会让其首行被 lexer 当成标题。setext 修正必须与正文
 * 保持一致，否则「一行文字 + ---」在正文是分隔线、在目录却成了标题条目。
 */
export function preprocessForToc(src) {
  if (!src) return '';
  let out = src.replace(/\r\n/g, '\n');
  out = out.replace(/^---\s*\n[\s\S]*?\n---\s*(\n|$)/, '');
  out = breakSetextHeadings(out);
  return out;
}
