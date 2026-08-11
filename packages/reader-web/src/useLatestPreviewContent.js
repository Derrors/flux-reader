import { useCallback, useEffect, useRef, useState } from 'react';

export const SPLIT_PREVIEW_DELAY_MS = 120;

/**
 * 分栏编辑时合并连续输入；离开分栏或显式 flush 时立即发布最新正文。
 * 编辑器本身始终使用同步 draft，此 hook 只延后昂贵的预览 generation。
 */
export function useLatestPreviewContent(
  content,
  deferred,
  delay = SPLIT_PREVIEW_DELAY_MS,
) {
  const latestRef = useRef(content);
  const timerRef = useRef(null);
  const [publishedContent, setPublishedContent] = useState(content);
  latestRef.current = content;

  const clearTimer = useCallback(() => {
    if (timerRef.current == null) return;
    globalThis.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    setPublishedContent(latestRef.current);
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    if (!deferred) {
      setPublishedContent(content);
      return undefined;
    }

    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = null;
      setPublishedContent(latestRef.current);
    }, delay);
    return clearTimer;
  }, [clearTimer, content, deferred, delay]);

  useEffect(() => clearTimer, [clearTimer]);

  return {
    previewContent: deferred ? publishedContent : content,
    flushPreviewContent: flush,
  };
}
