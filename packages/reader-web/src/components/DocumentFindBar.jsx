import { useEffect, useRef } from 'react';

export function findTextMatches(content, query, caseSensitive = false) {
  if (typeof content !== 'string' || typeof query !== 'string' || !query) return [];
  const haystack = caseSensitive ? content : content.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  if (!needle) return [];

  const matches = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    matches.push({ start: index, end: index + query.length });
    offset = index + Math.max(needle.length, 1);
  }
  return matches;
}

export function replaceTextMatch(content, match, replacement) {
  if (typeof content !== 'string' || !match) return content;
  return `${content.slice(0, match.start)}${replacement}${content.slice(match.end)}`;
}

export default function DocumentFindBar({
  query,
  replacement,
  replaceVisible,
  caseSensitive,
  currentIndex,
  matchCount,
  canReplace,
  onQueryChange,
  onReplacementChange,
  onToggleReplace,
  onToggleCase,
  onPrevious,
  onNext,
  onReplace,
  onReplaceAll,
  onClose,
}) {
  const queryRef = useRef(null);

  useEffect(() => {
    queryRef.current?.focus();
    queryRef.current?.select();
  }, []);

  const resultLabel = query
    ? matchCount > 0
      ? `${Math.min(currentIndex + 1, matchCount)} / ${matchCount}`
      : '无结果'
    : '输入关键词';

  return (
    <section className="document-find-bar" role="search" aria-label="文档内查找与替换">
      <button
        type="button"
        className="find-toggle-replace"
        aria-label={replaceVisible ? '隐藏替换' : '显示替换'}
        aria-pressed={replaceVisible}
        onClick={onToggleReplace}
      >
        {replaceVisible ? '⌄' : '›'}
      </button>

      <div className="find-fields">
        <div className="find-row">
          <input
            ref={queryRef}
            type="search"
            value={query}
            placeholder="查找"
            aria-label="查找内容"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) onPrevious();
                else onNext();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <span className="find-result-count" role="status">{resultLabel}</span>
          <button
            type="button"
            className={caseSensitive ? 'is-active' : undefined}
            aria-label="区分大小写"
            aria-pressed={caseSensitive}
            onClick={onToggleCase}
          >
            Aa
          </button>
          <button type="button" aria-label="上一个匹配" onClick={onPrevious}>↑</button>
          <button type="button" aria-label="下一个匹配" onClick={onNext}>↓</button>
          <button type="button" aria-label="关闭查找" onClick={onClose}>×</button>
        </div>

        {replaceVisible && (
          <div className="find-row find-replace-row">
            <input
              type="text"
              value={replacement}
              placeholder="替换为"
              aria-label="替换内容"
              disabled={!canReplace}
              onChange={(event) => onReplacementChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canReplace) {
                  event.preventDefault();
                  onReplace();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
            <button type="button" disabled={!canReplace || matchCount === 0} onClick={onReplace}>
              替换
            </button>
            <button
              type="button"
              disabled={!canReplace || matchCount === 0}
              onClick={onReplaceAll}
            >
              全部替换
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
