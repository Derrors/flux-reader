/** 文档大纲：点击跳转，滚动时高亮当前章节。 */
import { useEffect, useState } from 'react';

export default function Toc({ items, pinned = false, onTogglePinned }) {
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    if (!items?.length) return;

    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter(Boolean);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // 取当前视口内最靠上的标题作为 active
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );

    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [items]);

  const jump = (id, event) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 鼠标点击后移除焦点，让未固定的目录在指针移开时正常自动隐藏；
    // 键盘触发的 click.detail 为 0，保留焦点以维持键盘导航。
    if (event?.detail > 0) event.currentTarget.blur();
  };

  const togglePinned = (event) => {
    onTogglePinned?.();
    // 鼠标取消固定后立即交还给自动隐藏；键盘操作则保留焦点，方便继续导航。
    if (event.detail > 0) event.currentTarget.blur();
  };

  if (!items?.length) return null;

  // 以文档中最小的标题层级作为缩进基准
  const minLevel = Math.min(...items.map((i) => i.level));

  return (
    <div className="toc">
      <div className="toc-header">
        <div className="toc-title">目录</div>
        <button
          type="button"
          className="toc-pin"
          aria-label={pinned ? '恢复目录自动隐藏' : '固定展开目录'}
          aria-pressed={pinned}
          title={pinned ? '恢复自动隐藏' : '固定展开'}
          onClick={togglePinned}
        >
          {pinned ? '›' : '‹'}
        </button>
      </div>
      <ul className="toc-list">
        {items.map((item, idx) => (
          <li key={`${item.id}-${idx}`}>
            <button
              type="button"
              className={`toc-link${activeId === item.id ? ' active' : ''}`}
              style={{ paddingLeft: 8 + (item.level - minLevel) * 12 }}
              onClick={(event) => jump(item.id, event)}
              title={item.text}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
