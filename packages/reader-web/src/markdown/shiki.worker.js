/**
 * shiki Worker：在后台线程做语法高亮。
 * highlighter 单例，按需加载语言，避免重复初始化 WASM。
 */
import { createHighlighter, bundledLanguages } from 'shiki';

const THEMES = { light: 'github-light', dark: 'github-dark' };

let highlighterPromise = null;
const loadedLangs = new Set();

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [],
    });
  }
  return highlighterPromise;
}

/** 语言别名归一 + 是否受支持 */
function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase().trim();
  if (!l) return null;
  const alias = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    py: 'python',
    rb: 'ruby',
    golang: 'go',
    'c++': 'cpp',
    'c#': 'csharp',
    text: null,
    plaintext: null,
    plain: null,
  };
  const mapped = l in alias ? alias[l] : l;
  if (!mapped) return null;
  return mapped in bundledLanguages ? mapped : null;
}

self.onmessage = async (e) => {
  const { id, code, lang, theme } = e.data || {};
  try {
    const normalized = normalizeLang(lang);
    if (!normalized) {
      self.postMessage({ id, html: null });
      return;
    }
    const hl = await getHighlighter();
    if (!loadedLangs.has(normalized)) {
      await hl.loadLanguage(normalized);
      loadedLangs.add(normalized);
    }
    const html = hl.codeToHtml(code, {
      lang: normalized,
      theme: theme === 'dark' ? THEMES.dark : THEMES.light,
    });
    self.postMessage({ id, html });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
