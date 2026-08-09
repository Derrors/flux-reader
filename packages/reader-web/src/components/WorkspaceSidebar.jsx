import FileTree from './FileTree';

function ResultItem({ result, onOpenFile }) {
  const kind = result.matchKind === 'fileName' ? '文件名' : '正文';
  return (
    <button
      type="button"
      className="sidebar-document search-result"
      onClick={() => onOpenFile(result)}
      title={result.displayPath || result.path}
    >
      <span className="sidebar-document-title">{result.name}</span>
      <span className="search-result-meta">
        {kind} · {result.workspaceName} · {result.displayPath}
      </span>
      {result.snippet && <span className="search-result-snippet">{result.snippet}</span>}
    </button>
  );
}

function SearchSection({
  query,
  onQueryChange,
  searching,
  searchResults,
  searchError,
  hasWorkspaces,
  onOpenFile,
}) {
  const trimmedQuery = query.trim();
  return (
    <section className="sidebar-section workspace-search">
      <label className="workspace-search-field">
        <span className="visually-hidden">搜索文件名和正文</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索文件名和正文"
          disabled={!hasWorkspaces}
        />
      </label>

      {trimmedQuery && (
        <div className="search-results" aria-busy={searching}>
          {searching && (
            <div className="sidebar-hint" role="status">搜索中…</div>
          )}
          {!searching && searchError && (
            <div className="sidebar-hint sidebar-error">{searchError}</div>
          )}
          {!searching && !searchError && searchResults.length === 0 && (
            <div className="sidebar-hint">没有匹配的 Markdown 文稿</div>
          )}
          {searchResults.map((result) => (
            <ResultItem key={result.path} result={result} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </section>
  );
}

function RecentSection({ recents, onOpenRecent, onRemoveRecent, onClearRecents }) {
  if (!recents.length) return null;
  return (
    <section className="sidebar-section recent-documents" aria-labelledby="recent-heading">
      <div className="sidebar-section-header">
        <h2 id="recent-heading">最近文稿</h2>
        <button type="button" className="sidebar-text-action" onClick={onClearRecents}>
          清空
        </button>
      </div>
      <div className="sidebar-document-list">
        {recents.map((item) => (
          <div className="sidebar-document-row" key={item.path}>
            <button
              type="button"
              className="sidebar-document"
              onClick={() => onOpenRecent(item)}
              title={item.displayPath || item.path}
            >
              <span className="sidebar-document-title">{item.name}</span>
              <span className="sidebar-document-path">{item.displayPath || item.path}</span>
            </button>
            <button
              type="button"
              className="sidebar-icon-action"
              onClick={() => onRemoveRecent(item)}
              aria-label={`从最近文稿移除 ${item.name}`}
              title="从最近文稿移除"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkspaceSection({
  workspace,
  currentPath,
  refreshing,
  onOpenFile,
  onRefreshWorkspace,
  onCloseWorkspace,
}) {
  return (
    <section className="sidebar-section workspace-section" aria-label={`工作区 ${workspace.name}`}>
      <div className="workspace-section-header" title={workspace.displayPath || workspace.path}>
        <span className="workspace-section-title">{workspace.name}</span>
        <button
          type="button"
          className="sidebar-icon-action"
          onClick={() => onRefreshWorkspace(workspace.path)}
          disabled={refreshing}
          aria-label={`刷新工作区 ${workspace.name}`}
          title="刷新工作区"
        >
          {refreshing ? '…' : '↻'}
        </button>
        <button
          type="button"
          className="sidebar-icon-action"
          onClick={() => onCloseWorkspace(workspace.path)}
          aria-label={`关闭工作区 ${workspace.name}`}
          title="关闭工作区"
        >
          ×
        </button>
      </div>
      <FileTree
        root={workspace}
        currentPath={currentPath}
        onOpenFile={onOpenFile}
      />
    </section>
  );
}

export default function WorkspaceSidebar({
  workspaces,
  currentPath,
  refreshingPaths,
  onOpenFile,
  onRefreshWorkspace,
  onCloseWorkspace,
  recents,
  onOpenRecent,
  onRemoveRecent,
  onClearRecents,
  searchQuery,
  onSearchQueryChange,
  searching,
  searchResults,
  searchError,
}) {
  return (
    <nav className="workspace-browser" aria-label="工作区与最近文稿">
      <SearchSection
        query={searchQuery}
        onQueryChange={onSearchQueryChange}
        searching={searching}
        searchResults={searchResults}
        searchError={searchError}
        hasWorkspaces={workspaces.length > 0}
        onOpenFile={onOpenFile}
      />

      <RecentSection
        recents={recents}
        onOpenRecent={onOpenRecent}
        onRemoveRecent={onRemoveRecent}
        onClearRecents={onClearRecents}
      />

      {workspaces.map((workspace) => (
        <WorkspaceSection
          key={workspace.path}
          workspace={workspace}
          currentPath={currentPath}
          refreshing={refreshingPaths.has(workspace.path)}
          onOpenFile={onOpenFile}
          onRefreshWorkspace={onRefreshWorkspace}
          onCloseWorkspace={onCloseWorkspace}
        />
      ))}
    </nav>
  );
}
