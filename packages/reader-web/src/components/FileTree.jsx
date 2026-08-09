/** 文件树：展示用户本次主动打开的目录，懒加载其子目录。 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

function TreeNode({ node, depth, currentPath, onOpenFile }) {
  const [expanded, setExpanded] = useState(depth === 0);
  // 根目录已在“打开文件夹”时通过 /list 完成校验和读取，直接复用结果；
  // 子目录仍按需加载。root key 包含 revision，重新选择同一路径也会重建。
  const [children, setChildren] = useState(() => node.initialChildren ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isDir = node.type !== 'file' && !node.isFile;

  const loadChildren = useCallback(async () => {
    if (children || loading) return;
    setLoading(true);
    try {
      const { entries } = await api.list(node.path);
      setChildren(entries || []);
      setError('');
    } catch (err) {
      setError(err.message);
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [children, loading, node.path]);

  useEffect(() => {
    if (isDir && expanded) loadChildren();
  }, [isDir, expanded, loadChildren]);

  const label = node.name || node.displayPath || node.path;

  if (!isDir) {
    const active = currentPath === node.path;
    return (
      <button
        type="button"
        className={`tree-item tree-file${active ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onOpenFile({ ...node, name: label })}
        title={node.displayPath || node.path}
      >
        <span className="tree-icon">▤</span>
        <span className="tree-label">{label}</span>
      </button>
    );
  }

  return (
    <div className="tree-node">
      <button
        type="button"
        className="tree-item tree-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setExpanded((v) => !v)}
        title={node.displayPath || node.path}
      >
        <span className="tree-icon">{expanded ? '▾' : '▸'}</span>
        <span className="tree-label">{label}</span>
      </button>

      {expanded && (
        <div className="tree-children">
          {loading && <div className="tree-hint" style={{ paddingLeft: 22 + depth * 14 }}>加载中…</div>}
          {error && <div className="tree-hint tree-error" style={{ paddingLeft: 22 + depth * 14 }}>{error}</div>}
          {children?.length === 0 && !loading && !error && (
            <div className="tree-hint" style={{ paddingLeft: 22 + depth * 14 }}>没有 Markdown 文件</div>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ root, currentPath, onOpenFile }) {
  if (!root) return null;
  return (
    <nav className="file-tree">
      <TreeNode
        key={`${root.path}:${root.revision || 0}`}
        node={root}
        depth={0}
        currentPath={currentPath}
        onOpenFile={onOpenFile}
      />
    </nav>
  );
}
