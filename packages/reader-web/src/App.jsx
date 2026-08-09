import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownView from './markdown/MarkdownView';
import { extractToc } from './markdown/pipeline';
import { api } from './api';
import { initSdk, pickFolder, pickMarkdownFile, setTitle } from './trim-sdk';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import Toc from './components/Toc';
import {
  MAX_RECENT_DOCUMENTS,
  prependRecentDocument,
  readRecentDocuments,
  writeRecentDocuments,
} from './recent-documents';

const MAX_WORKSPACES = 8;
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const FOCUS_REFRESH_DELAY_MS = 150;
const SEARCH_DELAY_MS = 250;
const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

/** Read an absolute Markdown path supplied by the fnOS file association. */
function readLaunchPath() {
  try {
    const params = new URLSearchParams(window.location.search);
    const filePath = params.get('path') || params.get('file');
    if (!filePath || !filePath.startsWith('/')) return null;
    if (filePath.includes('\0') || !MARKDOWN_PATH.test(filePath)) return null;
    return filePath;
  } catch {
    return null;
  }
}

function basename(filePath) {
  return String(filePath).split('/').filter(Boolean).pop() || filePath;
}

function dirname(filePath) {
  const normalized = String(filePath || '').replace(/\/+$/, '');
  const boundary = normalized.lastIndexOf('/');
  return boundary <= 0 ? '/' : normalized.slice(0, boundary);
}

function normalizeWorkspacePath(value) {
  const path = typeof value === 'string' ? value : '';
  if (!path.startsWith('/') || path.includes('\0')) return null;
  return path === '/' ? path : path.replace(/\/+$/, '');
}

function containsPath(rootPath, filePath) {
  if (!rootPath || !filePath) return false;
  return rootPath === '/' || filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function workspaceActualPath(workspace) {
  return workspace?.actualPath || workspace?.path || '';
}

function deepestWorkspace(workspaces, filePath) {
  return workspaces
    .filter((workspace) => containsPath(workspaceActualPath(workspace), filePath))
    .sort((left, right) => (
      workspaceActualPath(right).length - workspaceActualPath(left).length
    ))[0] || null;
}

function upsertWorkspace(workspaces, nextWorkspace) {
  const matchingIndexes = workspaces.flatMap((workspace, index) => (
    workspace.path === nextWorkspace.path ||
    workspaceActualPath(workspace) === workspaceActualPath(nextWorkspace)
      ? [index]
      : []
  ));
  const insertionIndex = matchingIndexes.length > 0
    ? Math.min(...matchingIndexes)
    : workspaces.length;
  const next = workspaces.filter((workspace) => (
    workspace.path !== nextWorkspace.path &&
    workspaceActualPath(workspace) !== workspaceActualPath(nextWorkspace)
  ));
  next.splice(Math.min(insertionIndex, next.length), 0, nextWorkspace);
  return next;
}

async function allSettledBounded(values, worker, limit = 3) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(values[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

function normalizeSearchResults(data, workspaces) {
  const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
  const seen = new Set();
  const values = Array.isArray(data?.results) ? data.results : [];

  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const path = typeof value.path === 'string' ? value.path : '';
    if (
      !path.startsWith('/') ||
      path.length > 4096 ||
      path.includes('\0') ||
      !MARKDOWN_PATH.test(path) ||
      seen.has(path)
    ) return [];

    const declaredWorkspace = workspaceByPath.get(value.workspacePath);
    const workspace = declaredWorkspace && containsPath(workspaceActualPath(declaredWorkspace), path)
      ? declaredWorkspace
      : deepestWorkspace(workspaces, path);
    if (!workspace) return [];

    seen.add(path);
    const name = typeof value.name === 'string' && value.name.trim()
      ? value.name.trim().slice(0, 512)
      : basename(path);
    return [{
      path,
      name,
      displayPath: typeof value.displayPath === 'string'
        ? value.displayPath.slice(0, 4096)
        : path,
      type: 'file',
      isFile: true,
      snippet: typeof value.snippet === 'string' ? value.snippet.slice(0, 600) : '',
      matchKind: value.matchKind === 'fileName' ? 'fileName' : 'content',
      workspacePath: workspace.path,
      workspaceActualPath: workspaceActualPath(workspace),
      workspaceName: workspace.name,
    }];
  }).slice(0, 100);
}

export default function App() {
  const [theme, setTheme] = useState('light');
  const [env, setEnv] = useState(null);
  // Workspaces are deliberately session-only. Ordinary startup never enumerates
  // previously authorized shares without a fresh, explicit folder choice.
  const [workspaces, setWorkspaces] = useState([]);
  const [current, setCurrent] = useState(null);
  // null means no successful document; an empty string is a valid empty file.
  const [content, setContent] = useState(null);
  const [recents, setRecents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const [refreshingPaths, setRefreshingPaths] = useState(() => new Set());
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tocPinned, setTocPinned] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const launchPathRef = useRef(readLaunchPath());
  const isFileLaunch = launchPathRef.current !== null;
  const launchHandledRef = useRef(false);
  const pendingOpenRef = useRef(null);
  const documentRequestSeqRef = useRef(0);
  const workspaceRequestSeqRef = useRef(new Map());
  const workspaceStateRef = useRef(new Map());
  const workspaceRevisionRef = useRef(0);
  const resourceRevisionRef = useRef(0);
  const pickerActiveRef = useRef(false);
  const pickerGenerationRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const recentHydrationSeqRef = useRef(0);
  const deferredRecentsRef = useRef([]);
  const removedRecentIdentitiesRef = useRef(new Set());
  const searchRequestSeqRef = useRef(0);
  const envRef = useRef(env);
  const workspacesRef = useRef(workspaces);
  const currentRef = useRef(current);
  envRef.current = env;
  workspacesRef.current = workspaces;
  currentRef.current = current;

  const nextWorkspaceRequest = useCallback((path) => {
    const next = (workspaceRequestSeqRef.current.get(path) || 0) + 1;
    workspaceRequestSeqRef.current.set(path, next);
    return next;
  }, []);

  const workspaceRequestIsCurrent = useCallback((path, requestSeq) => (
    workspaceRequestSeqRef.current.get(path) === requestSeq
  ), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const storeRecents = useCallback((updater) => {
    setRecents((previous) => {
      const next = updater(previous);
      writeRecentDocuments(envRef.current?.uid, [
        ...next,
        ...deferredRecentsRef.current,
      ]);
      return next;
    });
  }, []);

  const recordRecent = useCallback((item) => {
    if (!item?.path) return;
    const identity = item.actualPath || item.path;
    removedRecentIdentitiesRef.current.delete(item.path);
    removedRecentIdentitiesRef.current.delete(identity);
    deferredRecentsRef.current = deferredRecentsRef.current.filter(
      (deferred) => (
        deferred.path !== item.path &&
        (deferred.actualPath || deferred.path) !== identity
      ),
    );
    storeRecents((previous) => {
      const withoutSameDocument = previous.filter((recent) => (
        recent.path !== item.path &&
        (recent.actualPath || recent.path) !== identity
      ));
      const next = prependRecentDocument(withoutSameDocument, {
        path: item.path,
        name: item.name || basename(item.path),
        displayPath: item.displayPath || item.path,
        type: 'file',
      });
      return next.map((recent, index) => (
        index === 0 ? { ...recent, actualPath: identity } : recent
      ));
    });
  }, [storeRecents]);

  const hydrateRecents = useCallback(async (nextEnv) => {
    const requestSeq = ++recentHydrationSeqRef.current;
    removedRecentIdentitiesRef.current.clear();
    const stored = readRecentDocuments(nextEnv?.uid);
    if (!stored.length) {
      deferredRecentsRef.current = [];
      setRecents([]);
      return;
    }

    // Metadata remains hidden until each path passes the same backend ACL and
    // realpath validation as a normal open. Keep this metadata-only validation
    // bounded so startup never downloads bodies or fans out twelve NAS reads.
    const validations = await allSettledBounded(
      stored,
      (item) => api.fileState(item.path),
      3,
    );
    if (requestSeq !== recentHydrationSeqRef.current || envRef.current?.uid !== nextEnv?.uid) {
      return;
    }
    const valid = stored.flatMap((item, index) => {
      const validation = validations[index];
      if (validation.status !== 'fulfilled') return [];
      return [{
        ...item,
        actualPath: validation.value?.actualPath || item.path,
      }];
    });
    const definitelyInvalid = new Set([400, 403, 404, 413]);
    const deferred = stored.filter((_item, index) => {
      const validation = validations[index];
      return validation.status === 'rejected' && !definitelyInvalid.has(validation.reason?.status);
    });
    setRecents((previous) => {
      const removed = removedRecentIdentitiesRef.current;
      const allowedValid = valid.filter((item) => (
        !removed.has(item.path) && !removed.has(item.actualPath || item.path)
      ));
      const existingIdentities = new Set(previous.flatMap((item) => [
        item.path,
        item.actualPath || item.path,
      ]));
      const newlyAccepted = [];
      for (const item of allowedValid) {
        const identity = item.actualPath || item.path;
        if (existingIdentities.has(item.path) || existingIdentities.has(identity)) continue;
        newlyAccepted.push(item);
        existingIdentities.add(item.path);
        existingIdentities.add(identity);
      }
      const merged = [
        ...previous,
        ...newlyAccepted,
      ].slice(0, MAX_RECENT_DOCUMENTS);
      const mergedIdentities = new Set(merged.flatMap((item) => [
        item.path,
        item.actualPath || item.path,
      ]));
      const stillDeferred = deferred.filter((item) => (
        !mergedIdentities.has(item.path) &&
        !mergedIdentities.has(item.actualPath || item.path) &&
        !removed.has(item.path) &&
        !removed.has(item.actualPath || item.path)
      ));
      deferredRecentsRef.current = stillDeferred;
      // Keep transient failures hidden for this session without destroying
      // their storage record; a later launch can validate them again.
      writeRecentDocuments(nextEnv?.uid, [...merged, ...stillDeferred]);
      return merged;
    });
  }, []);

  /** Open a document with latest-wins semantics across files and retries. */
  const openFile = useCallback(async (item, { standalone = false } = {}) => {
    const requestSeq = ++documentRequestSeqRef.current;
    pendingOpenRef.current = null;
    setLoading(true);
    setError('');
    try {
      const result = await api.file(item.path);
      if (requestSeq !== documentRequestSeqRef.current) return false;

      const text = typeof result.content === 'string' ? result.content : '';
      const actualPath = result.actualPath || item.actualPath || item.path;
      const workspace = deepestWorkspace(workspacesRef.current, actualPath);
      const nextCurrent = {
        ...item,
        path: item.path,
        actualPath,
        name: item.name || basename(item.path),
        displayPath: item.displayPath || item.path,
        type: 'file',
        workspacePath: workspace?.path || null,
        workspaceActualPath: workspace ? workspaceActualPath(workspace) : null,
        size: result.size ?? null,
        mtime: result.mtime ?? null,
        ctime: result.ctime ?? null,
        resourceRevision: result.mtime ?? ++resourceRevisionRef.current,
      };
      setContent(text);
      setCurrent(nextCurrent);
      recordRecent(nextCurrent);
      await setTitle(nextCurrent.name || nextCurrent.displayPath || 'Flux Reader');
      if (requestSeq !== documentRequestSeqRef.current) return false;

      if (standalone) {
        // Only successful direct-file opens clear directory browsing. A slower
        // request cannot erase workspaces selected by a newer action.
        for (const workspaceItem of workspacesRef.current) {
          nextWorkspaceRequest(workspaceItem.path);
        }
        workspaceStateRef.current.clear();
        setWorkspaces([]);
        setSidebarOpen(false);
      }
      window.scrollTo({ top: 0 });
      return true;
    } catch (err) {
      if (requestSeq !== documentRequestSeqRef.current) return false;
      setError(err.message);
      if (err.status === 403) pendingOpenRef.current = { item, standalone };
      return false;
    } finally {
      if (requestSeq === documentRequestSeqRef.current) setLoading(false);
    }
  }, [nextWorkspaceRequest, recordRecent]);

  const openFolderPath = useCallback(async (rawPath) => {
    if (isFileLaunch) return false;
    const folderPath = normalizeWorkspacePath(rawPath);
    if (!folderPath) {
      setError('文件夹路径无效');
      return false;
    }

    const requestSeq = nextWorkspaceRequest(folderPath);
    setError('');
    try {
      const statePromise = api.workspaceState(folderPath).catch(() => null);
      const [listResult, workspaceState] = await Promise.all([
        api.list(folderPath),
        statePromise,
      ]);
      if (!workspaceRequestIsCurrent(folderPath, requestSeq)) return false;

      const actualPath = normalizeWorkspacePath(
        listResult.actualPath || workspaceState?.actualPath || folderPath,
      ) || folderPath;
      const alreadyOpen = workspacesRef.current.some((item) => (
        item.path === folderPath || workspaceActualPath(item) === actualPath
      ));
      if (!alreadyOpen && workspacesRef.current.length >= MAX_WORKSPACES) {
        setError(`最多同时打开 ${MAX_WORKSPACES} 个工作区，请先关闭一个再添加。`);
        return false;
      }
      for (const existing of workspacesRef.current) {
        if (existing.path !== folderPath && workspaceActualPath(existing) === actualPath) {
          nextWorkspaceRequest(existing.path);
          workspaceStateRef.current.delete(existing.path);
        }
      }
      const revision = ++workspaceRevisionRef.current;
      const root = {
        path: folderPath,
        actualPath,
        name: basename(folderPath),
        displayPath: folderPath,
        type: 'directory',
        initialChildren: Array.isArray(listResult.entries) ? listResult.entries : [],
        revision,
        stateRevision: workspaceState?.revision ?? null,
      };
      if (workspaceState?.revision != null) {
        workspaceStateRef.current.set(folderPath, workspaceState.revision);
      } else {
        workspaceStateRef.current.delete(folderPath);
      }
      setWorkspaces((previous) => upsertWorkspace(previous, root));
      setSidebarOpen(true);
      return true;
    } catch (err) {
      if (!workspaceRequestIsCurrent(folderPath, requestSeq)) return false;
      setError(err.message);
      return false;
    }
  }, [isFileLaunch, nextWorkspaceRequest, workspaceRequestIsCurrent]);

  const onOpenFolder = useCallback(async () => {
    if (isFileLaunch || pickerActiveRef.current) return;
    pickerActiveRef.current = true;
    pickerGenerationRef.current += 1;
    setPickingFolder(true);
    try {
      const folderPath = await pickFolder();
      if (folderPath) await openFolderPath(folderPath);
    } catch (err) {
      setError(err.message);
    } finally {
      pickerActiveRef.current = false;
      setPickingFolder(false);
    }
  }, [isFileLaunch, openFolderPath]);

  const onOpenStandaloneFile = useCallback(async () => {
    if (pickerActiveRef.current) return;
    pickerActiveRef.current = true;
    pickerGenerationRef.current += 1;
    setPickingFile(true);
    try {
      const filePath = await pickMarkdownFile();
      if (!filePath) return;
      await openFile(
        { path: filePath, name: basename(filePath), displayPath: filePath, type: 'file' },
        { standalone: true },
      );
    } catch (err) {
      setError(err.message);
    } finally {
      pickerActiveRef.current = false;
      setPickingFile(false);
    }
  }, [openFile]);

  const closeWorkspace = useCallback((rawPath) => {
    const path = normalizeWorkspacePath(rawPath);
    if (!path) return;
    nextWorkspaceRequest(path);
    workspaceStateRef.current.delete(path);
    setWorkspaces((previous) => previous.filter((workspace) => workspace.path !== path));
    setRefreshingPaths((previous) => {
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
  }, [nextWorkspaceRequest]);

  const refreshWorkspace = useCallback(async (rawPath, { background = false } = {}) => {
    const path = normalizeWorkspacePath(rawPath);
    if (!path || !workspacesRef.current.some((workspace) => workspace.path === path)) return false;
    if (background && pickerActiveRef.current) return false;

    const requestSeq = nextWorkspaceRequest(path);
    const pickerGeneration = pickerGenerationRef.current;
    if (!background) {
      setError('');
      setRefreshingPaths((previous) => new Set(previous).add(path));
    }
    try {
      const selected = workspacesRef.current.find((workspace) => workspace.path === path);
      const statePromise = api.workspaceState(path).catch(() => null);
      const [listResult, workspaceState] = await Promise.all([api.list(path), statePromise]);
      if (
        !workspaceRequestIsCurrent(path, requestSeq) ||
        pickerGeneration !== pickerGenerationRef.current ||
        (background && pickerActiveRef.current)
      ) return false;

      if (workspaceState?.revision != null) {
        workspaceStateRef.current.set(path, workspaceState.revision);
      }
      const actualPath = normalizeWorkspacePath(
        listResult.actualPath || workspaceState?.actualPath || workspaceActualPath(selected),
      ) || workspaceActualPath(selected);
      for (const existing of workspacesRef.current) {
        if (existing.path !== path && workspaceActualPath(existing) === actualPath) {
          nextWorkspaceRequest(existing.path);
          workspaceStateRef.current.delete(existing.path);
        }
      }
      const revision = ++workspaceRevisionRef.current;
      setWorkspaces((previous) => {
        const workspace = previous.find((item) => item.path === path);
        if (!workspace) return previous;
        return upsertWorkspace(previous, {
          ...workspace,
          actualPath,
          initialChildren: Array.isArray(listResult.entries) ? listResult.entries : [],
          revision,
          stateRevision: workspaceState?.revision ?? workspace.stateRevision,
        });
      });
      return true;
    } catch (err) {
      if (
        !workspaceRequestIsCurrent(path, requestSeq) ||
        pickerGeneration !== pickerGenerationRef.current
      ) return false;
      if ([400, 403, 404, 413, 422].includes(err.status)) {
        workspaceStateRef.current.delete(path);
        setWorkspaces((previous) => previous.filter((workspace) => workspace.path !== path));
      }
      setError(err.message);
      return false;
    } finally {
      if (!background) {
        setRefreshingPaths((previous) => {
          const next = new Set(previous);
          next.delete(path);
          return next;
        });
      }
    }
  }, [nextWorkspaceRequest, workspaceRequestIsCurrent]);

  const pollWorkspace = useCallback(async (workspace) => {
    if (pickerActiveRef.current) return;
    const path = workspace.path;
    const requestSeq = nextWorkspaceRequest(path);
    const pickerGeneration = pickerGenerationRef.current;
    try {
      const state = await api.workspaceState(path);
      if (
        pickerActiveRef.current ||
        pickerGeneration !== pickerGenerationRef.current ||
        !workspaceRequestIsCurrent(path, requestSeq) ||
        !workspacesRef.current.some((item) => item.path === path)
      ) return;

      const stateActualPath = normalizeWorkspacePath(state.actualPath || workspaceActualPath(workspace))
        || workspaceActualPath(workspace);
      const hasBaseline = workspaceStateRef.current.has(path);
      if (
        hasBaseline &&
        workspaceStateRef.current.get(path) === state.revision &&
        stateActualPath === workspaceActualPath(workspace)
      ) return;

      const listResult = await api.list(path);
      if (
        pickerActiveRef.current ||
        pickerGeneration !== pickerGenerationRef.current ||
        !workspaceRequestIsCurrent(path, requestSeq) ||
        !workspacesRef.current.some((item) => item.path === path)
      ) return;

      if (state?.revision != null) {
        workspaceStateRef.current.set(path, state.revision);
      } else {
        workspaceStateRef.current.delete(path);
      }
      const actualPath = normalizeWorkspacePath(listResult.actualPath || stateActualPath)
        || stateActualPath;
      for (const existing of workspacesRef.current) {
        if (existing.path !== path && workspaceActualPath(existing) === actualPath) {
          nextWorkspaceRequest(existing.path);
          workspaceStateRef.current.delete(existing.path);
        }
      }
      const revision = ++workspaceRevisionRef.current;
      setWorkspaces((previous) => {
        const currentWorkspace = previous.find((item) => item.path === path);
        if (!currentWorkspace) return previous;
        return upsertWorkspace(previous, {
          ...currentWorkspace,
          actualPath,
          initialChildren: Array.isArray(listResult.entries) ? listResult.entries : [],
          revision,
          stateRevision: state.revision,
        });
      });
    } catch (err) {
      if (
        !workspaceRequestIsCurrent(path, requestSeq) ||
        pickerGeneration !== pickerGenerationRef.current
      ) return;
      if (err.status === 403 || err.status === 404) {
        workspaceStateRef.current.delete(path);
        setWorkspaces((previous) => previous.filter((item) => item.path !== path));
      }
      setError(err.message);
    }
  }, [nextWorkspaceRequest, workspaceRequestIsCurrent]);

  const pollCurrentDocument = useCallback(async () => {
    const selected = currentRef.current;
    if (!selected?.path || pickerActiveRef.current) return;
    const requestSeq = documentRequestSeqRef.current;
    const pickerGeneration = pickerGenerationRef.current;
    const isCurrent = () => (
      !pickerActiveRef.current &&
      pickerGeneration === pickerGenerationRef.current &&
      requestSeq === documentRequestSeqRef.current &&
      currentRef.current?.path === selected.path
    );
    try {
      const fileState = await api.fileState(selected.path);
      if (!isCurrent()) return;

      const actualPath = fileState.actualPath || selected.actualPath || selected.path;
      const hasComparableMetadata = [selected.size, selected.mtime, selected.ctime]
        .every((value) => value != null) &&
        [fileState.size, fileState.mtime, fileState.ctime].every((value) => value != null);
      if (
        hasComparableMetadata &&
        selected.size === fileState.size &&
        selected.mtime === fileState.mtime &&
        selected.ctime === fileState.ctime &&
        actualPath === (selected.actualPath || selected.path)
      ) {
        // A standalone document has no explicit workspace token. Treat its
        // canonical parent as an implicit resource root and only change image
        // URLs when that tree revision changes.
        if (!deepestWorkspace(workspacesRef.current, actualPath)) {
          try {
            const resourceState = await api.workspaceState(dirname(actualPath));
            if (!isCurrent()) return;
            if (resourceState.revision !== selected.resourceTreeRevision) {
              setCurrent((previous) => (
                previous?.path === selected.path
                  ? {
                    ...previous,
                    resourceTreeRevision: resourceState.revision,
                    resourceRevision: ++resourceRevisionRef.current,
                  }
                  : previous
              ));
            }
          } catch {
            // Resource polling is best effort; losing it must not hide a valid
            // standalone Markdown preview.
          }
        }
        setError('');
        return;
      }

      const result = await api.file(selected.path);
      if (!isCurrent()) return;

      const text = typeof result.content === 'string' ? result.content : '';
      setContent(text);
      setCurrent((previous) => (
        previous?.path === selected.path
          ? {
            ...previous,
            actualPath: result.actualPath || actualPath,
            size: result.size ?? fileState.size ?? previous.size,
            mtime: result.mtime ?? fileState.mtime ?? previous.mtime,
            ctime: result.ctime ?? fileState.ctime ?? previous.ctime,
            resourceRevision: result.mtime ?? ++resourceRevisionRef.current,
          }
          : previous
      ));
      setError('');
    } catch (err) {
      if (!isCurrent()) return;
      if ([400, 403, 404, 413, 422].includes(err.status)) {
        documentRequestSeqRef.current += 1;
        pendingOpenRef.current = null;
        setCurrent(null);
        setContent(null);
        void Promise.resolve(setTitle('Flux Reader')).catch(() => {});
      }
      setError(err.message);
    }
  }, []);

  const runRefreshCycle = useCallback(async ({ forceWorkspaces = false } = {}) => {
    if (
      pollInFlightRef.current ||
      pickerActiveRef.current ||
      document.visibilityState === 'hidden'
    ) return;

    pollInFlightRef.current = true;
    try {
      const snapshot = [...workspacesRef.current];
      // Recursive state scans can be expensive on a NAS. Keep them sequential
      // and let the recursive timer wait for the whole cycle, avoiding both a
      // burst across eight roots and overlap with the next cycle.
      for (const workspace of snapshot) {
        if (pickerActiveRef.current || document.visibilityState === 'hidden') return;
        try {
          if (forceWorkspaces) {
            await refreshWorkspace(workspace.path, { background: true });
          } else {
            await pollWorkspace(workspace);
          }
        } catch {
          // Individual helpers already surface current errors. One workspace
          // must not prevent later roots or the current document from refreshing.
        }
      }
      if (pickerActiveRef.current || document.visibilityState === 'hidden') return;

      const retry = pendingOpenRef.current;
      if (retry) {
        pendingOpenRef.current = null;
        await openFile(retry.item, { standalone: retry.standalone });
      } else {
        await pollCurrentDocument();
      }
    } finally {
      pollInFlightRef.current = false;
    }
  }, [openFile, pollCurrentDocument, pollWorkspace, refreshWorkspace]);

  useEffect(() => {
    let active = true;
    (async () => {
      await initSdk();
      if (!active) return;
      try {
        const nextEnv = await api.env();
        if (!active) return;
        envRef.current = nextEnv;
        setEnv(nextEnv);
        void hydrateRecents(nextEnv);
      } catch (err) {
        if (active) setError(err.message);
      }
    })();
    return () => {
      active = false;
      recentHydrationSeqRef.current += 1;
    };
  }, [hydrateRecents]);

  useEffect(() => {
    const target = launchPathRef.current;
    if (!target || launchHandledRef.current || !env) return;
    launchHandledRef.current = true;
    setWorkspaces([]);
    setSidebarOpen(false);
    void openFile(
      { path: target, name: basename(target), displayPath: target, type: 'file' },
      { standalone: true },
    );
  }, [env, openFile]);

  const workspaceSearchSignature = JSON.stringify(
    workspaces.map((workspace) => [
      workspace.path,
      workspaceActualPath(workspace),
      workspace.revision,
    ]),
  );

  useEffect(() => {
    const query = searchQuery.trim();
    const paths = workspaces.map((workspace) => workspace.path);
    const requestSeq = ++searchRequestSeqRef.current;
    if (!query || paths.length === 0) {
      setSearching(false);
      setSearchResults([]);
      setSearchError('');
      return undefined;
    }

    setSearching(true);
    setSearchError('');
    const controller = new AbortController();
    const timerId = window.setTimeout(async () => {
      try {
        const data = await api.search(paths, query, 100, { signal: controller.signal });
        if (requestSeq !== searchRequestSeqRef.current) return;
        setSearchResults(normalizeSearchResults(data, workspacesRef.current));
        setSearchError('');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (requestSeq !== searchRequestSeqRef.current) return;
        setSearchResults([]);
        setSearchError(err.message);
      } finally {
        if (requestSeq === searchRequestSeqRef.current) setSearching(false);
      }
    }, SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  // workspaceSearchSignature intentionally retriggers searches after tree refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, workspaceSearchSignature]);

  useEffect(() => {
    if (!env) return undefined;

    let focusTimerId = null;
    let pollTimerId = null;
    let active = true;

    const scheduleFocusRefresh = () => {
      if (document.visibilityState === 'hidden' || pickerActiveRef.current) return;
      if (focusTimerId !== null) window.clearTimeout(focusTimerId);
      focusTimerId = window.setTimeout(() => {
        focusTimerId = null;
        void runRefreshCycle({ forceWorkspaces: true });
      }, FOCUS_REFRESH_DELAY_MS);
    };

    const schedulePoll = () => {
      pollTimerId = window.setTimeout(async () => {
        if (!active) return;
        await runRefreshCycle();
        if (active) schedulePoll();
      }, AUTO_REFRESH_INTERVAL_MS);
    };

    window.addEventListener('focus', scheduleFocusRefresh);
    document.addEventListener('visibilitychange', scheduleFocusRefresh);
    schedulePoll();
    return () => {
      active = false;
      window.removeEventListener('focus', scheduleFocusRefresh);
      document.removeEventListener('visibilitychange', scheduleFocusRefresh);
      if (focusTimerId !== null) window.clearTimeout(focusTimerId);
      if (pollTimerId !== null) window.clearTimeout(pollTimerId);
    };
  }, [env, runRefreshCycle]);

  useEffect(
    () => () => {
      documentRequestSeqRef.current += 1;
      searchRequestSeqRef.current += 1;
      recentHydrationSeqRef.current += 1;
      for (const workspace of workspacesRef.current) nextWorkspaceRequest(workspace.path);
    },
    [nextWorkspaceRequest],
  );

  const onOpenRecent = useCallback((item) => {
    void openFile(item);
  }, [openFile]);

  const removeRecent = useCallback((item) => {
    const path = item?.path || item;
    const identity = item?.actualPath || path;
    removedRecentIdentitiesRef.current.add(path);
    removedRecentIdentitiesRef.current.add(identity);
    deferredRecentsRef.current = deferredRecentsRef.current.filter(
      (deferred) => (
        deferred.path !== path &&
        (deferred.actualPath || deferred.path) !== identity
      ),
    );
    storeRecents((previous) => previous.filter((recent) => (
      recent.path !== path &&
      (recent.actualPath || recent.path) !== identity
    )));
  }, [storeRecents]);

  const clearRecents = useCallback(() => {
    recentHydrationSeqRef.current += 1;
    deferredRecentsRef.current = [];
    removedRecentIdentitiesRef.current.clear();
    storeRecents(() => []);
  }, [storeRecents]);

  const toc = useMemo(
    () => (typeof content === 'string' && content ? extractToc(content) : []),
    [content],
  );
  const hasDocument = content !== null;
  const hasSidebarContent = workspaces.length > 0 || recents.length > 0;
  const showSidebar = Boolean(!isFileLaunch && hasSidebarContent && sidebarOpen);
  const imageWorkspace = useMemo(
    () => deepestWorkspace(workspaces, current?.actualPath || current?.path),
    [current?.actualPath, current?.path, workspaces],
  );
  const imageRevision = `${current?.resourceRevision ?? ''}:${
    imageWorkspace?.stateRevision ?? current?.resourceTreeRevision ?? ''
  }`;
  const resolveImageSource = useCallback((source) => (
    current?.path
      ? api.resourceUrl(
        current.path,
        source,
        imageWorkspace ? workspaceActualPath(imageWorkspace) : undefined,
        imageRevision,
      )
      : null
  ), [current?.path, imageRevision, imageWorkspace]);

  const sidebarToggleLabel = workspaces.length > 0
    ? (sidebarOpen ? '隐藏文件目录' : '显示文件目录')
    : (sidebarOpen ? '隐藏最近文稿' : '显示最近文稿');

  return (
    <div className="app fnos-reader" data-theme={theme}>
      <header className="app-header">
        {!isFileLaunch && hasSidebarContent && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSidebarOpen((value) => !value)}
            title={sidebarToggleLabel}
            aria-label={sidebarToggleLabel}
            aria-pressed={sidebarOpen}
          >
            ☰
          </button>
        )}
        <h1 className="app-title">
          {current ? current.name || current.displayPath : 'Flux Reader'}
        </h1>
        <div className="app-header-actions">
          {env?.openApiAvailable && (
            <button
              type="button"
              className={!hasDocument && workspaces.length === 0 ? 'primary-btn' : undefined}
              onClick={onOpenStandaloneFile}
              disabled={pickingFile || pickingFolder}
              title="直接选择一个已在应用设置中授权的 Markdown 文件"
            >
              {pickingFile ? '选择中…' : '打开文件'}
            </button>
          )}
          {!isFileLaunch && env?.openApiAvailable && (
            <button
              type="button"
              onClick={onOpenFolder}
              disabled={pickingFolder || pickingFile}
              title={`选择已授权文件夹（最多 ${MAX_WORKSPACES} 个工作区）`}
            >
              {pickingFolder ? '选择中…' : '打开文件夹'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            title="切换主题"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="app-body">
        {showSidebar && (
          <aside className="app-sidebar">
            <WorkspaceSidebar
              workspaces={workspaces}
              currentPath={current?.actualPath || current?.path}
              refreshingPaths={refreshingPaths}
              onOpenFile={openFile}
              onRefreshWorkspace={refreshWorkspace}
              onCloseWorkspace={closeWorkspace}
              recents={recents}
              onOpenRecent={onOpenRecent}
              onRemoveRecent={removeRecent}
              onClearRecents={clearRecents}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              searching={searching}
              searchResults={searchResults}
              searchError={searchError}
            />
          </aside>
        )}

        <main className="app-main">
          {error && (
            <div className="notice notice-error">
              <strong>提示：</strong>
              {error}
            </div>
          )}

          {loading && <div className="notice">加载中…</div>}

          {!loading && !hasDocument && !error && (
            <div className="empty-state">
              <h2>还没有打开文档</h2>
              <p>
                {env?.openApiAvailable
                  ? isFileLaunch
                    ? '点击「打开文件」选择另一个 Markdown 文档。'
                    : '点击「打开文件」直接阅读 Markdown，或点击「打开文件夹」浏览已授权目录。'
                  : '当前不在 fnOS 环境中，请安装到 fnOS 后打开已授权的 Markdown 文档。'}
              </p>
            </div>
          )}

          {hasDocument && (
            <MarkdownView
              content={content}
              theme={theme}
              resolveImageSource={current?.path ? resolveImageSource : undefined}
            />
          )}
        </main>

        {hasDocument && toc.length > 1 && (
          <aside className={`app-toc${tocPinned ? ' is-pinned' : ''}`}>
            <div className="app-toc-panel">
              <Toc
                items={toc}
                pinned={tocPinned}
                onTogglePinned={() => setTocPinned((value) => !value)}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
