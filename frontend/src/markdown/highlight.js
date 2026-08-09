/**
 * 代码高亮：shiki 跑在 Web Worker 里。
 *
 * 为什么用 Worker：shiki 要加载 WASM 正则引擎与语法定义，在 NAS 这类
 * 较弱的硬件上同步高亮会明显卡住主线程。策略是：
 * 先让纯文本快速上屏，再把 tokenize 结果异步回填。
 */

let worker = null;
let seq = 0;
const pending = new Map();

/** 超大代码块不做高亮，直接降级纯文本（性能保护） */
export const HUGE_CODE_THRESHOLD = 50_000;
export const HUGE_LINE_THRESHOLD = 2_000;

export function isHugeCode(code) {
  return (
    code.length > HUGE_CODE_THRESHOLD ||
    code.split('\n').some((l) => l.length > HUGE_LINE_THRESHOLD)
  );
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./shiki.worker.js', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e) => {
    const { id, html, error } = e.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve(html);
  };
  worker.onerror = (e) => {
    // Worker 整体挂掉时让所有等待者失败，调用方会降级为纯文本
    for (const [, entry] of pending) entry.reject(new Error(e.message || 'shiki worker error'));
    pending.clear();
  };
  return worker;
}

/**
 * 高亮一段代码，返回 <pre> HTML。
 * @param {string} code
 * @param {string} lang
 * @param {'light'|'dark'} theme
 * @returns {Promise<string|null>} null 表示放弃高亮（调用方回退纯文本）
 */
export function highlightCode(code, lang, theme) {
  if (!code || isHugeCode(code)) return Promise.resolve(null);
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, code, lang: lang || 'text', theme });
    // 超时保护：NAS 上首次加载 WASM 可能较慢，给足时间但不无限等
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve(null);
      }
    }, 8000);
  });
}
