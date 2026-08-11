import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIGHLIGHT_TIMEOUT_MS,
  HUGE_CODE_THRESHOLD,
  HUGE_LINE_THRESHOLD,
  MAX_HIGHLIGHT_CACHE_BYTES,
  cancelHighlightSession,
  createHighlightSession,
  getHighlightDiagnostics,
  highlightCode,
  isHugeCode,
  resetHighlighting,
} from './highlight';

class WorkerMock {
  static instances = [];

  constructor() {
    this.messages = [];
    this.terminated = false;
    WorkerMock.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  respond(message) {
    this.onmessage?.({ data: message });
  }

  fail(message = 'worker failed') {
    this.onerror?.({ message });
  }
}

beforeEach(() => {
  resetHighlighting();
  WorkerMock.instances = [];
  vi.stubGlobal('Worker', WorkerMock);
});

afterEach(() => {
  resetHighlighting();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('代码高亮性能保护阈值', () => {
  it('允许总长度 100,000 且单行不超过 4,000 的代码', () => {
    const code = [
      'x'.repeat(HUGE_LINE_THRESHOLD),
      ...Array.from({ length: 24 }, () => 'x'.repeat(HUGE_LINE_THRESHOLD - 1)),
    ].join('\n');

    expect(code).toHaveLength(HUGE_CODE_THRESHOLD);
    expect(isHugeCode(code)).toBe(false);
  });

  it('总长度超过 100,000 时跳过高亮', () => {
    const code = Array.from({ length: 26 }, () => 'x'.repeat(3_999)).join('\n');

    expect(code.length).toBeGreaterThan(HUGE_CODE_THRESHOLD);
    expect(code.split('\n').every((line) => line.length <= HUGE_LINE_THRESHOLD)).toBe(true);
    expect(isHugeCode(code)).toBe(true);
  });

  it('允许 4,000 字符单行，超过一个字符才跳过高亮', () => {
    expect(isHugeCode('x'.repeat(HUGE_LINE_THRESHOLD))).toBe(false);
    expect(isHugeCode('x'.repeat(HUGE_LINE_THRESHOLD + 1))).toBe(true);
  });
});

describe('代码高亮任务调度', () => {
  it('合并同一 session 的重复请求并复用内存缓存', async () => {
    const sessionId = createHighlightSession();
    const first = highlightCode('const value = 1;', 'js', 'light', { sessionId });
    const second = highlightCode('const value = 1;', 'js', 'light', { sessionId });

    expect(first).toBe(second);
    const worker = WorkerMock.instances[0];
    const request = worker.messages.find((message) => message.type === 'highlight');
    expect(worker.messages.filter((message) => message.type === 'highlight')).toHaveLength(1);

    worker.respond({ requestId: request.requestId, html: '<pre>highlighted</pre>' });
    await expect(first).resolves.toBe('<pre>highlighted</pre>');
    await expect(second).resolves.toBe('<pre>highlighted</pre>');
    expect(getHighlightDiagnostics()).toMatchObject({
      pending: 0,
      inFlight: 0,
      cacheEntries: 1,
    });

    await expect(
      highlightCode('const value = 1;', 'js', 'light', { sessionId }),
    ).resolves.toBe('<pre>highlighted</pre>');
    expect(worker.messages.filter((message) => message.type === 'highlight')).toHaveLength(1);
  });

  it('取消 session 时释放全部等待者并通知 Worker 丢弃旧队列', async () => {
    const sessionId = createHighlightSession();
    const first = highlightCode('const first = 1;', 'js', 'light', { sessionId });
    const second = highlightCode('const second = 2;', 'js', 'light', { sessionId });
    const worker = WorkerMock.instances[0];

    cancelHighlightSession(sessionId);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(worker.messages).toContainEqual({ type: 'cancel-session', sessionId });
    expect(getHighlightDiagnostics()).toMatchObject({
      pending: 0,
      inFlight: 0,
      cancelled: 2,
    });
    await expect(
      highlightCode('const stale = true;', 'js', 'light', { sessionId }),
    ).resolves.toBeNull();
  });

  it('超时会释放 pending 并取消对应 Worker 请求', async () => {
    vi.useFakeTimers();
    const sessionId = createHighlightSession();
    const result = highlightCode('const slow = true;', 'js', 'dark', { sessionId });
    const worker = WorkerMock.instances[0];
    const request = worker.messages.find((message) => message.type === 'highlight');

    await vi.advanceTimersByTimeAsync(HIGHLIGHT_TIMEOUT_MS);

    await expect(result).resolves.toBeNull();
    expect(worker.messages).toContainEqual({
      type: 'cancel-request',
      requestId: request.requestId,
      sessionId,
    });
    expect(getHighlightDiagnostics()).toMatchObject({ pending: 0, inFlight: 0 });
  });

  it('Worker 异常会拒绝等待者并允许下一次请求重建 Worker', async () => {
    const sessionId = createHighlightSession();
    const result = highlightCode('const broken = true;', 'js', 'light', { sessionId });
    WorkerMock.instances[0].fail();

    await expect(result).rejects.toThrow('worker failed');
    expect(WorkerMock.instances[0].terminated).toBe(true);

    const retried = highlightCode('const retried = true;', 'js', 'light', { sessionId });
    expect(WorkerMock.instances).toHaveLength(2);
    const request = WorkerMock.instances[1].messages.find((message) => message.type === 'highlight');
    WorkerMock.instances[1].respond({ requestId: request.requestId, html: '<pre>ok</pre>' });
    await expect(retried).resolves.toBe('<pre>ok</pre>');
    expect(getHighlightDiagnostics().workerFailures).toBe(1);
  });

  it('按 HTML 字节上限淘汰最旧结果，缓存不会随文稿切换无界增长', async () => {
    const sessionId = createHighlightSession();
    const worker = highlightCode('seed-0', 'js', 'light', { sessionId });
    const instance = WorkerMock.instances[0];
    let request = instance.messages.find((message) => message.type === 'highlight');
    instance.respond({ requestId: request.requestId, html: `0${'x'.repeat(1_049_999)}` });
    await worker;

    for (let index = 1; index < 9; index += 1) {
      const result = highlightCode(`seed-${index}`, 'js', 'light', { sessionId });
      request = instance.messages.at(-1);
      instance.respond({
        requestId: request.requestId,
        html: `${index}${'x'.repeat(1_049_999)}`,
      });
      await result;
    }

    const afterFill = getHighlightDiagnostics();
    expect(afterFill.cacheBytes).toBeLessThanOrEqual(MAX_HIGHLIGHT_CACHE_BYTES);
    expect(afterFill.cacheEntries).toBeLessThan(9);

    const requestCount = instance.messages.filter(
      (message) => message.type === 'highlight',
    ).length;
    const reloaded = highlightCode('seed-0', 'js', 'light', { sessionId });
    expect(instance.messages.filter(
      (message) => message.type === 'highlight',
    )).toHaveLength(requestCount + 1);
    request = instance.messages.at(-1);
    instance.respond({ requestId: request.requestId, html: '<pre>reloaded</pre>' });
    await expect(reloaded).resolves.toBe('<pre>reloaded</pre>');
  });

  it('取消后迟到的结果不进入跨 session 缓存', async () => {
    const firstSession = createHighlightSession();
    const first = highlightCode('const stale = true;', 'js', 'light', {
      sessionId: firstSession,
    });
    const instance = WorkerMock.instances[0];
    const firstRequest = instance.messages.at(-1);
    cancelHighlightSession(firstSession);
    await expect(first).resolves.toBeNull();

    instance.respond({ requestId: firstRequest.requestId, html: '<pre>stale</pre>' });
    expect(getHighlightDiagnostics().staleResults).toBe(1);

    const nextSession = createHighlightSession();
    const next = highlightCode('const stale = true;', 'js', 'light', {
      sessionId: nextSession,
    });
    const nextRequest = instance.messages.at(-1);
    expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
    instance.respond({ requestId: nextRequest.requestId, html: '<pre>fresh</pre>' });
    await expect(next).resolves.toBe('<pre>fresh</pre>');
  });
});
