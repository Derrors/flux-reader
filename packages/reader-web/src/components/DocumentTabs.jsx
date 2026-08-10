export default function DocumentTabs({
  tabs,
  activeId,
  disabled = false,
  onActivate,
  onClose,
}) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return (
    <nav className="document-tabs" role="tablist" aria-label="打开的文稿">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const dirty = tab.dirty === true || (
          typeof tab.draft === 'string' && typeof tab.content === 'string'
            ? tab.draft !== tab.content
            : false
        );
        return (
          <div className={`document-tab${active ? ' is-active' : ''}`} key={tab.id}>
            <button
              type="button"
              className="document-tab-select"
              role="tab"
              aria-selected={active}
              title={tab.displayPath || tab.path}
              disabled={disabled}
              onClick={() => onActivate(tab.id)}
            >
              <span className="document-tab-title">{tab.name || tab.path}</span>
              {dirty && <span className="document-tab-dirty" aria-label="未保存">●</span>}
            </button>
            <button
              type="button"
              className="document-tab-close"
              aria-label={`关闭 ${tab.name || tab.path}`}
              title="关闭标签页"
              disabled={disabled}
              onClick={() => onClose(tab.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </nav>
  );
}
