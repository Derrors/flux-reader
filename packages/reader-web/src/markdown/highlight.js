/**
 * 代码高亮调度器。
 *
 * Shiki 始终运行在单个 Web Worker 中。主线程负责：
 * - 按文稿 generation 取消过期任务；
 * - 合并同一 generation 内的重复请求；
 * - 缓存已经完成的结果，并用字节上限约束内存；
 * - Worker 异常或超时后稳定降级到纯文本。
*/

import { RENDER_FEATURES } from '../renderFeatures';

let worker = null;
let requestSequence = 0;
let sessionSequence = 0;
const pending = new Map();
const inFlight = new Map();
const activeSessions = new Set(['default']);
const resultCache = new Map();
const textEncoder = new TextEncoder();

export const HIGHLIGHT_PROTOCOL_VERSION = 1;
export const HIGHLIGHT_TIMEOUT_MS = 8_000;
export const MAX_HIGHLIGHT_CACHE_ENTRIES = 256;
export const MAX_HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_HIGHLIGHT_CACHE_ITEM_BYTES = 2 * 1024 * 1024;

/** 超大代码块不做高亮，直接降级纯文本（性能保护） */
export const HUGE_CODE_THRESHOLD = 100_000;
export const HUGE_LINE_THRESHOLD = 4_000;

let cacheBytes = 0;
const diagnostics = {
  cacheHits: 0,
  cacheMisses: 0,
  cancelled: 0,
  staleResults: 0,
  timedOut: 0,
  workerFailures: 0,
};

export function isHugeCode(code) {
  return (
    code.length > HUGE_CODE_THRESHOLD
    || code.split('\n').some((line) => line.length > HUGE_LINE_THRESHOLD)
  );
}

export function createHighlightSession() {
  sessionSequence += 1;
  const sessionId = `highlight-session-${sessionSequence}`;
  activeSessions.add(sessionId);
  return sessionId;
}

function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function normalizeLanguage(language) {
  return String(language || 'text').trim().toLowerCase() || 'text';
}

function resultKey(code, language, theme) {
  return JSON.stringify([
    HIGHLIGHT_PROTOCOL_VERSION,
    normalizeLanguage(language),
    normalizeTheme(theme),
    code,
  ]);
}

function inFlightKey(sessionId, key) {
  return `${sessionId}\0${key}`;
}

function cacheGet(key) {
  if (!RENDER_FEATURES.highlightCache) return undefined;
  const cached = resultCache.get(key);
  if (!cached) {
    diagnostics.cacheMisses += 1;
    return undefined;
  }
  diagnostics.cacheHits += 1;
  resultCache.delete(key);
  resultCache.set(key, cached);
  return cached.html;
}

function evictCache() {
  while (
    resultCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES
    || cacheBytes > MAX_HIGHLIGHT_CACHE_BYTES
  ) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = resultCache.get(oldestKey);
    resultCache.delete(oldestKey);
    cacheBytes -= oldest?.bytes || 0;
  }
}

function cacheSet(key, html) {
  if (!RENDER_FEATURES.highlightCache) return;
  if (typeof html !== 'string' || !html) return;
  const bytes = textEncoder.encode(key).byteLength + textEncoder.encode(html).byteLength;
  if (bytes > MAX_HIGHLIGHT_CACHE_ITEM_BYTES) return;

  const existing = resultCache.get(key);
  if (existing) cacheBytes -= existing.bytes;
  resultCache.delete(key);
  resultCache.set(key, { html, bytes });
  cacheBytes += bytes;
  evictCache();
}

function finishEntry(id, callback) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  inFlight.delete(entry.inFlightKey);
  clearTimeout(entry.timeout);
  callback(entry);
  return true;
}

function rejectAllPending(error) {
  for (const [id] of pending) {
    finishEntry(id, (entry) => entry.reject(error));
  }
}

function disposeWorker() {
  const current = worker;
  worker = null;
  current?.terminate?.();
}

function ensureWorker() {
  if (worker) return worker;
  const nextWorker = new Worker(new URL('./shiki.worker.js', import.meta.url), {
    type: 'module',
  });
  worker = nextWorker;

  nextWorker.onmessage = (event) => {
    const { requestId, html, error } = event.data || {};
    const didFinish = finishEntry(requestId, (entry) => {
      if (error) {
        entry.reject(new Error(error));
        return;
      }
      cacheSet(entry.cacheKey, html);
      entry.resolve(html ?? null);
    });
    if (!didFinish) diagnostics.staleResults += 1;
  };

  nextWorker.onerror = (event) => {
    diagnostics.workerFailures += 1;
    const error = new Error(event.message || 'shiki worker error');
    disposeWorker();
    rejectAllPending(error);
  };
  return nextWorker;
}

/**
 * 取消一个文稿 generation 的全部高亮请求。
 * 排队任务会由 Worker 丢弃；正在同步执行的任务只能在返回后丢弃结果。
 */
export function cancelHighlightSession(sessionId) {
  if (!sessionId || sessionId === 'default' || !activeSessions.has(sessionId)) return;
  activeSessions.delete(sessionId);
  worker?.postMessage({ type: 'cancel-session', sessionId });

  for (const [id, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    finishEntry(id, (current) => {
      diagnostics.cancelled += 1;
      current.resolve(null);
    });
  }
}

/**
 * 高亮一段代码，返回 Shiki 生成的 <pre> HTML。
 * null 表示主动跳过、任务取消或超时，调用方应保留纯文本。
 */
export function highlightCode(
  code,
  language,
  theme,
  { sessionId = 'default', priority = 0 } = {},
) {
  if (!code || isHugeCode(code) || !activeSessions.has(sessionId)) {
    return Promise.resolve(null);
  }

  const cacheKey = resultKey(code, language, theme);
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);

  const currentInFlightKey = inFlightKey(sessionId, cacheKey);
  const existing = inFlight.get(currentInFlightKey);
  if (existing) return existing;

  const currentWorker = ensureWorker();
  const requestId = ++requestSequence;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const didFinish = finishEntry(requestId, (entry) => entry.resolve(null));
      if (didFinish) {
        diagnostics.timedOut += 1;
        currentWorker.postMessage({ type: 'cancel-request', requestId, sessionId });
      }
    }, HIGHLIGHT_TIMEOUT_MS);

    pending.set(requestId, {
      resolve,
      reject,
      timeout,
      sessionId,
      cacheKey,
      inFlightKey: currentInFlightKey,
    });
    currentWorker.postMessage({
      type: 'highlight',
      requestId,
      sessionId,
      priority: Number.isFinite(priority) ? priority : 0,
      code,
      language: normalizeLanguage(language),
      theme: normalizeTheme(theme),
    });
  });
  inFlight.set(currentInFlightKey, promise);
  return promise;
}

export function getHighlightDiagnostics() {
  return {
    pending: pending.size,
    inFlight: inFlight.size,
    cacheEntries: resultCache.size,
    cacheBytes,
    workerActive: worker !== null,
    ...diagnostics,
  };
}

/** 测试和显式内存回收入口；普通文稿切换只取消 session，不清空复用缓存。 */
export function resetHighlighting() {
  disposeWorker();
  rejectAllPending(new Error('highlight scheduler reset'));
  inFlight.clear();
  pending.clear();
  activeSessions.clear();
  activeSessions.add('default');
  resultCache.clear();
  cacheBytes = 0;
  Object.keys(diagnostics).forEach((key) => {
    diagnostics[key] = 0;
  });
}
