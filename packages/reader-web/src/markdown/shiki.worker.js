/**
 * Shiki Worker：串行调度高亮任务，允许按文稿 session 丢弃过期队列。
 * 已经进入 codeToHtml 的同步任务无法安全抢占，但其结果会在取消后丢弃。
 */
import { bundledLanguages, createHighlighter } from 'shiki';

const THEMES = { light: 'github-light', dark: 'github-dark' };

let highlighterPromise = null;
const loadedLanguages = new Set();
const queue = [];
const cancelledSessions = new Set();
const cancelledRequests = new Set();
let activeJob = null;
let enqueueSequence = 0;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [],
    });
  }
  return highlighterPromise;
}

function normalizeLanguage(language) {
  const value = String(language || '').toLowerCase().trim();
  if (!value) return null;
  const aliases = {
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
  const normalized = value in aliases ? aliases[value] : value;
  if (!normalized) return null;
  return normalized in bundledLanguages ? normalized : null;
}

function isCancelled(job) {
  return cancelledSessions.has(job.sessionId) || cancelledRequests.has(job.requestId);
}

function cleanupCancellation(job) {
  cancelledRequests.delete(job.requestId);
  if (
    cancelledSessions.has(job.sessionId)
    && activeJob?.sessionId !== job.sessionId
    && !queue.some((queued) => queued.sessionId === job.sessionId)
  ) {
    cancelledSessions.delete(job.sessionId);
  }
}

function sortQueue() {
  queue.sort((left, right) => (
    right.priority - left.priority || left.enqueueSequence - right.enqueueSequence
  ));
}

async function drainQueue() {
  if (activeJob) return;

  while (queue.length > 0) {
    const job = queue.shift();
    if (isCancelled(job)) {
      cleanupCancellation(job);
      continue;
    }

    activeJob = job;
    try {
      const normalized = normalizeLanguage(job.language);
      if (!normalized) {
        if (!isCancelled(job)) {
          self.postMessage({ requestId: job.requestId, html: null });
        }
        continue;
      }

      const highlighter = await getHighlighter();
      if (isCancelled(job)) continue;
      if (!loadedLanguages.has(normalized)) {
        await highlighter.loadLanguage(normalized);
        loadedLanguages.add(normalized);
      }
      if (isCancelled(job)) continue;

      const html = highlighter.codeToHtml(job.code, {
        lang: normalized,
        theme: job.theme === 'dark' ? THEMES.dark : THEMES.light,
      });
      if (!isCancelled(job)) {
        self.postMessage({ requestId: job.requestId, html });
      }
    } catch (error) {
      if (!isCancelled(job)) {
        self.postMessage({
          requestId: job.requestId,
          error: error?.message || String(error),
        });
      }
    } finally {
      activeJob = null;
      cleanupCancellation(job);
    }
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  switch (message.type) {
  case 'highlight':
    if (cancelledSessions.has(message.sessionId)) return;
    queue.push({
      requestId: message.requestId,
      sessionId: message.sessionId,
      priority: Number.isFinite(message.priority) ? message.priority : 0,
      enqueueSequence: ++enqueueSequence,
      code: message.code,
      language: message.language,
      theme: message.theme,
    });
    sortQueue();
    void drainQueue();
    break;
  case 'cancel-session':
    cancelledSessions.add(message.sessionId);
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].sessionId === message.sessionId) queue.splice(index, 1);
    }
    if (activeJob?.sessionId !== message.sessionId) {
      cancelledSessions.delete(message.sessionId);
    }
    break;
  case 'cancel-request':
    cancelledRequests.add(message.requestId);
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].requestId === message.requestId) queue.splice(index, 1);
    }
    if (activeJob?.requestId !== message.requestId) {
      cancelledRequests.delete(message.requestId);
    }
    break;
  default:
    break;
  }
};
