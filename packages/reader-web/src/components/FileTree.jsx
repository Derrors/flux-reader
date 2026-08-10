/** 文件树：展示用户本次主动打开的目录，懒加载其子目录。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

const DIRECTORY_REQUEST_LIMIT = 4;

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * A queue belongs to one workspace tree. Queued work is removed immediately;
 * running work keeps its slot until the aborted fetch actually settles, so the
 * real network concurrency never exceeds the limit.
 */
export function createDirectoryRequestQueue(limit = DIRECTORY_REQUEST_LIMIT) {
  const maximum = Math.max(1, Math.floor(limit));
  const entries = new Set();
  const waiting = [];
  let active = 0;
  let disposed = false;

  const removeWaiting = (entry) => {
    const index = waiting.indexOf(entry);
    if (index >= 0) waiting.splice(index, 1);
  };

  const drain = () => {
    if (disposed) return;
    while (active < maximum && waiting.length > 0) {
      const entry = waiting.shift();
      if (entry.settled) continue;
      entry.started = true;
      active += 1;
      Promise.resolve()
        .then(() => {
          if (entry.settled) throw abortError();
          return entry.task(entry.controller.signal);
        })
        .then(
          (value) => entry.finish('resolve', value),
          (error) => entry.finish('reject', error),
        );
    }
  };

  const run = (task, { signal } = {}) => new Promise((resolve, reject) => {
    if (disposed || signal?.aborted) {
      reject(abortError());
      return;
    }

    const entry = {
      controller: new AbortController(),
      started: false,
      settled: false,
      task,
      finish(kind, value) {
        if (entry.settled) return;
        entry.settled = true;
        removeWaiting(entry);
        if (entry.started) active -= 1;
        entries.delete(entry);
        signal?.removeEventListener('abort', entry.abort);
        if (kind === 'resolve') resolve(value);
        else reject(value);
        drain();
      },
      abort() {
        if (entry.settled) return;
        entry.controller.abort();
        if (!entry.started) entry.finish('reject', abortError());
      },
    };

    signal?.addEventListener('abort', entry.abort, { once: true });
    entries.add(entry);
    waiting.push(entry);
    drain();
  });

  return {
    run,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries]) entry.abort();
    },
  };
}

function TreeNode({
  node,
  depth,
  currentPath,
  onOpenFile,
  workspacePath,
  revision,
  requestQueue,
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [children, setChildren] = useState(() => node.initialChildren ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestControllerRef = useRef(null);

  const isDir = node.type !== 'file' && !node.isFile;

  const abortRequest = useCallback(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }, []);

  const loadChildren = useCallback(async () => {
    abortRequest();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    try {
      const { entries } = await requestQueue.run(
        (signal) => api.list(node.path, { signal }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || requestControllerRef.current !== controller) return;
      setChildren(Array.isArray(entries) ? entries : []);
      setError('');
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      if (requestControllerRef.current !== controller) return;
      setError(err.message);
      setChildren([]);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [abortRequest, node.path, requestQueue]);

  // A root refresh replaces its immediate entries without remounting the node,
  // so expansion state survives. Expanded descendants refetch for the new
  // recursive workspace revision and cancel their previous fetch first.
  useEffect(() => {
    if (depth !== 0) return undefined;
    abortRequest();
    setChildren(node.initialChildren ?? []);
    setLoading(false);
    setError('');
    return undefined;
  }, [abortRequest, depth, node.initialChildren, revision]);

  useEffect(() => {
    if (!isDir || !expanded || depth === 0) return undefined;
    void loadChildren();
    return abortRequest;
  }, [abortRequest, depth, expanded, isDir, loadChildren, revision]);

  useEffect(() => abortRequest, [abortRequest]);

  const label = node.name || node.displayPath || node.path;

  if (!isDir) {
    const active = currentPath === node.path;
    return (
      <li className="tree-node tree-file-node">
        <button
          type="button"
          className={`tree-item tree-file${active ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onOpenFile({ ...node, name: label, workspacePath })}
          title={node.displayPath || node.path}
          aria-current={active ? 'page' : undefined}
        >
          <span className="tree-icon" aria-hidden="true">▤</span>
          <span className="tree-label">{label}</span>
        </button>
      </li>
    );
  }

  return (
    <li className="tree-node">
      <button
        type="button"
        className="tree-item tree-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setExpanded((value) => !value)}
        title={node.displayPath || node.path}
        aria-expanded={expanded}
      >
        <span className="tree-icon" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="tree-label">{label}</span>
      </button>

      {expanded && (
        <ul className="tree-children">
          {loading && (
            <li className="tree-hint" style={{ paddingLeft: 22 + depth * 14 }}>加载中…</li>
          )}
          {error && (
            <li className="tree-hint tree-error" style={{ paddingLeft: 22 + depth * 14 }}>
              {error}
            </li>
          )}
          {children?.length === 0 && !loading && !error && (
            <li className="tree-hint" style={{ paddingLeft: 22 + depth * 14 }}>
              没有 Markdown 文件
            </li>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              onOpenFile={onOpenFile}
              workspacePath={workspacePath}
              revision={revision}
              requestQueue={requestQueue}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function FileTree({ root, currentPath, onOpenFile }) {
  const requestQueue = useMemo(
    () => createDirectoryRequestQueue(DIRECTORY_REQUEST_LIMIT),
    [root?.path],
  );
  useEffect(() => () => requestQueue.dispose(), [requestQueue]);

  if (!root) return null;
  return (
    <ul className="file-tree" aria-label={`${root.name || root.path} 文件列表`}>
      <TreeNode
        key={root.path}
        node={root}
        depth={0}
        currentPath={currentPath}
        onOpenFile={onOpenFile}
        workspacePath={root.path}
        revision={root.revision || 0}
        requestQueue={requestQueue}
      />
    </ul>
  );
}
