import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownView from './markdown/MarkdownView';
import { createMarkdownSnapshot } from './markdown/pipeline';
import { api } from './api';
import { initSdk, pickFolder, pickMarkdownFile, setTitle } from './trim-sdk';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import Toc from './components/Toc';
import DocumentFindBar, { findTextMatches, replaceTextMatch } from './components/DocumentFindBar';
import DocumentTabs from './components/DocumentTabs';
import {
  MAX_RECENT_DOCUMENTS,
  prependRecentDocument,
  readRecentDocuments,
  writeRecentDocuments,
} from './recent-documents';
import { readDraft, removeDraft, writeDraft } from './draft-storage';
import {
  MAX_DOCUMENT_TABS,
  readDocumentSession,
  writeDocumentSession,
} from './document-session';
import {
  MAX_EDITABLE_DOCUMENT_BYTES,
  MAX_EDITABLE_DOCUMENT_MIB,
} from './limits';
import { isSaveConflict, requiresSaveRecovery } from './saveOutcome';
import { useLatestPreviewContent } from './useLatestPreviewContent';
import {
  basenameHostPath,
  containsHostPath,
  dirnameHostPath,
  isAbsoluteHostPath,
  normalizeHostRoot,
} from './platform/path';

const MAX_WORKSPACES = 8;
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const FOCUS_REFRESH_DELAY_MS = 150;
const FILE_CHANGE_REFRESH_DELAY_MS = 120;
const FILE_CHANGE_BLOCKED_RETRY_MS = 500;
const SEARCH_DELAY_MS = 250;
const DRAFT_PERSIST_DELAY_MS = 500;
const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

/** Read an absolute Markdown path supplied by a host file association. */
function readLaunchPath() {
  try {
    const params = new URLSearchParams(window.location.search);
    const filePath = params.get('path') || params.get('file');
    if (!isAbsoluteHostPath(filePath) || filePath.includes('\0') || !MARKDOWN_PATH.test(filePath)) {
      return null;
    }
    return filePath;
  } catch {
    return null;
  }
}

function basename(filePath) {
  return basenameHostPath(filePath);
}

function dirname(filePath) {
  return dirnameHostPath(filePath);
}

function normalizeWorkspacePath(value) {
  return normalizeHostRoot(value);
}

function containsPath(rootPath, filePath) {
  return containsHostPath(rootPath, filePath);
}

function workspaceActualPath(workspace) {
  return workspace?.actualPath || workspace?.path || '';
}

function fileRevision(value) {
  return value?.revision ?? null;
}

function fileMetadataChanged(current, state) {
  const actualPath = state.actualPath || current.actualPath || current.path;
  const comparable = [current.size, current.mtime, current.ctime]
    .every((value) => value != null) &&
    [state.size, state.mtime, state.ctime].every((value) => value != null);
  if (fileRevision(state) != null && current.revision != null) {
    return fileRevision(state) !== current.revision ||
      actualPath !== (current.actualPath || current.path);
  }
  return !comparable ||
    current.size !== state.size ||
    current.mtime !== state.mtime ||
    current.ctime !== state.ctime ||
    actualPath !== (current.actualPath || current.path);
}

function DecisionDialog({ prompt, saving, error, onSave, onDiscard, onCancel }) {
  if (!prompt) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
        <h2 id="unsaved-title">保存修改？</h2>
        <p>{prompt.message}</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={saving}>取消</button>
          <button type="button" onClick={onDiscard} disabled={saving}>放弃修改</button>
          <button type="button" className="primary-btn" onClick={onSave} disabled={saving} autoFocus>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConflictDialog({ conflict, onReload, onKeep }) {
  if (!conflict) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title">文稿已在其他位置修改</h2>
        <p>磁盘版本与当前草稿不同。重新加载会放弃草稿；保留草稿后可再次保存并覆盖最新磁盘版本。</p>
        <div className="dialog-actions">
          <button type="button" onClick={onReload}>重新加载</button>
          <button type="button" className="primary-btn" onClick={onKeep} autoFocus>保留草稿</button>
        </div>
      </section>
    </div>
  );
}

function RecoveryDialog({ recovery, onUseDisk, onRestore }) {
  if (!recovery) return null;
  const diskUnreadable = recovery.diskReadable === false;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <h2 id="recovery-title">发现未保存草稿</h2>
        <p>
          {diskUnreadable
            ? '服务端恢复版本已写入磁盘，但该磁盘正文超过阅读上限或不是有效 UTF-8，当前无法预览。你的本地草稿仍然完整，可以继续查看、复制和编辑。'
            : '草稿创建后磁盘文件发生过变化，因此没有自动恢复。请选择要继续使用的版本。'}
        </p>
        {diskUnreadable && recovery.diskError && (
          <p className="dialog-error">磁盘正文不可预览：{recovery.diskError}</p>
        )}
        <div className="dialog-actions">
          {!diskUnreadable && (
            <button type="button" onClick={onUseDisk}>使用磁盘版本</button>
          )}
          <button type="button" className="primary-btn" onClick={onRestore} autoFocus>
            {diskUnreadable ? '继续编辑本地草稿' : '恢复草稿'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ServerRecoveryDialog({ recovery, busy, error, onDiscard, onRestore }) {
  if (!recovery) return null;
  const { record } = recovery;
  const canRead = record.targetMatches !== false && !recovery.cleanupOnly;
  const canWrite = recovery.document?.writable !== false;
  const hasRecoverableVersion = Boolean(
    record.baselineAvailable || record.attemptedAvailable,
  );
  const mustRestoreUnreadableDisk = (
    canRead && recovery.diskReadable === false && hasRecoverableVersion
  );
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-recovery-title"
      >
        <h2 id="server-recovery-title">发现未完成的保存</h2>
        <p>
          {recovery.cleanupOnly
            ? '恢复版本已安全写入磁盘，但旧恢复记录尚未清理。'
            : canRead
              ? mustRestoreUnreadableDisk
                ? '上次保存没有完整结束，当前磁盘正文无法安全读取。请先通过 revision 校验恢复一个服务端版本；本地未保存草稿会继续保留，稍后再由你选择。'
                : '上次保存没有完整结束，当前磁盘正文可能为空、残缺或已被其他程序修改。恢复会先重新校验磁盘 revision，再写入所选版本；放弃恢复记录不可撤销。'
              : '这条恢复记录属于同路径下的旧文件，不能读取旧正文。你只能清理该记录。'}
        </p>
        {recovery.metadataUnavailable && canRead && (
          <p>
            当前尚未取得磁盘 metadata/revision；恢复时会重新读取 fresh revision，
            若仍无法取得就会安全停止，不会绕过 CAS 覆盖磁盘。
          </p>
        )}
        {canRead && !canWrite && (
          <p>当前文稿上次检查为只读；修改授权后可直接点击恢复，应用会重新检查权限。</p>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            操作失败：{error}。恢复记录和本地草稿均已保留，你可以修正问题后重试。
          </p>
        )}
        <div className="dialog-actions">
          {!mustRestoreUnreadableDisk && (
            <button type="button" onClick={onDiscard} disabled={busy}>
              {canRead ? '放弃恢复记录' : '清理旧记录'}
            </button>
          )}
          {canRead && record.baselineAvailable && (
            <button
              type="button"
              onClick={() => onRestore('baseline')}
              disabled={busy}
            >
              恢复保存前版本
            </button>
          )}
          {canRead && record.attemptedAvailable && (
            <button
              type="button"
              className="primary-btn"
              onClick={() => onRestore('attempted')}
              disabled={busy}
              autoFocus
            >
              {busy ? '恢复中…' : '恢复待保存版本'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function deepestWorkspace(workspaces, filePath) {
  return workspaces
    .filter((workspace) => containsPath(workspaceActualPath(workspace), filePath))
    .sort((left, right) => (
      workspaceActualPath(right).length - workspaceActualPath(left).length
    ))[0] || null;
}

function actionableServerRecoveryRecords(value) {
  if (!value?.available || !Array.isArray(value.records)) return [];
  return value.records.filter((record) => (
    record &&
    typeof record.recoveryId === 'string' &&
    !record.inProgress &&
    // A committed record means the target already contains the attempted
    // bytes and only best-effort cleanup was interrupted. It can be removed
    // without asking the user to recover an already visible version.
    record.phase !== 'committed'
  ));
}

function explicitCleanupRecoveryRecords(value, env) {
  if (
    env?.capabilities?.recoveryPolicy?.cleanupMode !== 'explicit'
    || !value?.available
    || !Array.isArray(value.records)
  ) return [];
  return value.records.filter((record) => (
    record &&
    typeof record.recoveryId === 'string' &&
    !record.inProgress &&
    // 路径后来被外部版本占用时也必须保留明确的清理入口；是否仍匹配
    // attempted 只决定诊断，不能让 sidecar 永久卡住恢复配额。
    record.phase === 'committed'
  ));
}

function recoveryRecordsForUI(value, env) {
  return [
    ...actionableServerRecoveryRecords(value),
    ...explicitCleanupRecoveryRecords(value, env),
  ];
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
      !isAbsoluteHostPath(path) ||
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
  const [draft, setDraft] = useState(null);
  const [viewMode, setViewMode] = useState('preview');
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [activeFindMatch, setActiveFindMatch] = useState(0);
  const [previewFindMatchCount, setPreviewFindMatchCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const [transitionPrompt, setTransitionPrompt] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [serverRecovery, setServerRecovery] = useState(null);
  const [serverRecoveryBusy, setServerRecoveryBusy] = useState(false);
  const [serverRecoveryError, setServerRecoveryError] = useState('');
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
  const documentOpenAbortRef = useRef(null);
  const documentPollAbortRef = useRef(null);
  const recentHydrationAbortRef = useRef(null);
  const serverRecoveryAbortRef = useRef(null);
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
  const contentRef = useRef(content);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const savingRef = useRef(null);
  const conflictRef = useRef(null);
  const recoveryRef = useRef(null);
  const serverRecoveryRef = useRef(null);
  const transitionPromptRef = useRef(null);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const editorRef = useRef(null);
  const previewPaneRef = useRef(null);
  const editorPaneRef = useRef(null);
  const scrollSyncRef = useRef({ source: null });
  const sessionRestoredRef = useRef(false);
  const isDirty = draft !== null && (
    content !== null
      ? draft !== content
      : current?.contentUnavailable === true
  );
  const safeSaveAvailable = env?.capabilities?.safeSave !== false;
  const sessionScopedAuthorization = env?.capabilities?.sessionScopedAuthorization === true;
  const renderedContent = draft ?? content;
  const { previewContent, flushPreviewContent } = useLatestPreviewContent(
    renderedContent,
    viewMode === 'split',
  );
  const searchableContent = renderedContent ?? '';
  const findMatches = useMemo(
    () => findTextMatches(searchableContent, findQuery, findCaseSensitive),
    [findCaseSensitive, findQuery, searchableContent],
  );
  envRef.current = env;
  workspacesRef.current = workspaces;
  currentRef.current = current;
  contentRef.current = content;
  draftRef.current = draft;
  dirtyRef.current = isDirty;
  conflictRef.current = conflict;
  recoveryRef.current = recovery;
  serverRecoveryRef.current = serverRecovery;
  transitionPromptRef.current = transitionPrompt;
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const updateConflict = useCallback((value) => {
    conflictRef.current = value;
    setConflict(value);
  }, []);

  const updateRecovery = useCallback((value) => {
    recoveryRef.current = value;
    setRecovery(value);
  }, []);

  const updateServerRecovery = useCallback((value) => {
    serverRecoveryRef.current = value;
    setServerRecovery(value);
    setServerRecoveryError('');
  }, []);

  useEffect(() => {
    setActiveFindMatch((index) => (
      findMatches.length === 0 ? 0 : Math.min(index, findMatches.length - 1)
    ));
  }, [findMatches.length, findQuery, findCaseSensitive]);

  const selectFindMatchInEditor = useCallback((match) => {
    const editor = editorRef.current;
    if (!editor || !match) return;
    editor.focus();
    editor.setSelectionRange(match.start, match.end);
    const lineCount = searchableContent.slice(0, match.start).split('\n').length;
    const approximateLineHeight = 24;
    editor.scrollTop = Math.max(0, (lineCount - 4) * approximateLineHeight);
  }, [searchableContent]);

  const navigateFind = useCallback((direction) => {
    const matchCount = viewMode === 'preview' ? previewFindMatchCount : findMatches.length;
    if (matchCount === 0) return;
    setActiveFindMatch((previous) => {
      const next = (previous + direction + matchCount) % matchCount;
      if (viewMode !== 'preview') {
        window.requestAnimationFrame(() => selectFindMatchInEditor(findMatches[next]));
      }
      return next;
    });
  }, [findMatches, previewFindMatchCount, selectFindMatchInEditor, viewMode]);

  const commitDraftChange = useCallback((nextDraft, selection) => {
    if (currentRef.current?.writable === false || typeof nextDraft !== 'string') return false;
    draftRef.current = nextDraft;
    dirtyRef.current = nextDraft !== contentRef.current;
    setDraft(nextDraft);
    setSaveNotice('');
    if (selection) {
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setSelectionRange(selection.start, selection.end);
      });
    }
    return true;
  }, []);

  const replaceCurrentMatch = useCallback(() => {
    const match = findMatches[activeFindMatch];
    if (!match || currentRef.current?.writable === false) return;
    const nextDraft = replaceTextMatch(searchableContent, match, replaceQuery);
    if (viewMode === 'preview') setViewMode('edit');
    commitDraftChange(nextDraft, {
      start: match.start,
      end: match.start + replaceQuery.length,
    });
  }, [
    activeFindMatch,
    commitDraftChange,
    findMatches,
    replaceQuery,
    searchableContent,
    viewMode,
  ]);

  const replaceAllMatches = useCallback(() => {
    if (findMatches.length === 0 || currentRef.current?.writable === false) return;
    let nextDraft = searchableContent;
    for (let index = findMatches.length - 1; index >= 0; index -= 1) {
      nextDraft = replaceTextMatch(nextDraft, findMatches[index], replaceQuery);
    }
    if (viewMode === 'preview') setViewMode('edit');
    commitDraftChange(nextDraft, { start: 0, end: 0 });
    setActiveFindMatch(0);
  }, [commitDraftChange, findMatches, replaceQuery, searchableContent, viewMode]);

  const syncDocumentScroll = useCallback((source, target) => {
    if (!source || !target || scrollSyncRef.current.source) return;
    const sourceMaximum = Math.max(source.scrollHeight - source.clientHeight, 0);
    const targetMaximum = Math.max(target.scrollHeight - target.clientHeight, 0);
    if (sourceMaximum <= 0 || targetMaximum <= 0) return;
    scrollSyncRef.current.source = source;
    target.scrollTop = (source.scrollTop / sourceMaximum) * targetMaximum;
    window.requestAnimationFrame(() => {
      if (scrollSyncRef.current.source === source) scrollSyncRef.current.source = null;
    });
  }, []);

  const updateTabs = useCallback((updater) => {
    const previous = tabsRef.current;
    const next = typeof updater === 'function' ? updater(previous) : updater;
    tabsRef.current = Array.isArray(next) ? next.slice(0, MAX_DOCUMENT_TABS) : previous;
    setTabs(tabsRef.current);
    return tabsRef.current;
  }, []);

  const activeTabSnapshot = useCallback(() => {
    const document = currentRef.current;
    if (!document?.path) return null;
    return {
      id: activeTabIdRef.current || document.path,
      path: document.path,
      actualPath: document.actualPath || null,
      name: document.name || basename(document.path),
      displayPath: document.displayPath || document.path,
      type: 'file',
      loaded: true,
      document,
      content: contentRef.current,
      draft: draftRef.current,
      viewMode,
      saveNotice,
      dirty: dirtyRef.current,
    };
  }, [saveNotice, viewMode]);

  const persistTabDraft = useCallback((tab) => {
    if (!tab?.dirty || typeof tab.draft !== 'string') return;
    const actualPath = tab.document?.actualPath || tab.actualPath || tab.path;
    if (!actualPath) return;
    writeDraft(
      envRef.current?.uid,
      actualPath,
      tab.draft,
      tab.document?.revision ?? null,
    );
  }, []);

  const captureActiveTab = useCallback(() => {
    const snapshot = activeTabSnapshot();
    if (!snapshot) return null;
    persistTabDraft(snapshot);
    updateTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === snapshot.id);
      if (index < 0) return [...previous, snapshot];
      const next = [...previous];
      next[index] = { ...next[index], ...snapshot };
      return next;
    });
    return snapshot;
  }, [activeTabSnapshot, persistTabDraft, updateTabs]);

  const applyTabSnapshot = useCallback((tab) => {
    if (!tab?.loaded || !tab.document) return false;
    documentRequestSeqRef.current += 1;
    documentOpenAbortRef.current?.abort();
    documentPollAbortRef.current?.abort();
    documentOpenAbortRef.current = null;
    documentPollAbortRef.current = null;
    currentRef.current = tab.document;
    contentRef.current = tab.content;
    draftRef.current = tab.draft;
    dirtyRef.current = tab.dirty === true || tab.draft !== tab.content;
    activeTabIdRef.current = tab.id;
    setActiveTabId(tab.id);
    setCurrent(tab.document);
    setContent(tab.content);
    setDraft(tab.draft);
    setViewMode(tab.viewMode || 'preview');
    setSaveNotice(tab.saveNotice || '');
    updateConflict(null);
    updateRecovery(null);
    updateServerRecovery(null);
    setError('');
    setLoading(false);
    setActiveFindMatch(0);
    void setTitle(tab.document.name || tab.document.displayPath || 'Flux Reader');
    return true;
  }, [updateConflict, updateRecovery, updateServerRecovery]);

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

  const clearStoredDraft = useCallback((document = currentRef.current) => {
    const actualPath = document?.actualPath || document?.path;
    if (actualPath) removeDraft(envRef.current?.uid, actualPath);
  }, []);

  const saveCurrent = useCallback(() => {
    flushPreviewContent();
    if (savingRef.current) return savingRef.current;
    if (
      conflictRef.current ||
      recoveryRef.current ||
      serverRecoveryRef.current
    ) return Promise.resolve(false);
    const selected = currentRef.current;
    const snapshotContent = draftRef.current;
    if (!selected?.path || snapshotContent == null || !dirtyRef.current) {
      return Promise.resolve(true);
    }
    if (envRef.current?.capabilities?.safeSave === false) {
      setError('当前平台尚未启用安全保存；修改已保留为本地恢复草稿');
      return Promise.resolve(false);
    }
    if (selected.writable === false) {
      setError(envRef.current?.capabilities?.sessionScopedAuthorization === true
        ? '当前文稿为只读；请检查 Windows 文件权限后重试'
        : '当前文稿为只读；请在 fnOS 应用设置中授予读写权限后重试');
      return Promise.resolve(false);
    }
    const contentBytes = new TextEncoder().encode(snapshotContent).byteLength;
    if (contentBytes > MAX_EDITABLE_DOCUMENT_BYTES) {
      setError(
        `文稿为 ${(contentBytes / 1024 / 1024).toFixed(1)} MiB，` +
        `超过 ${MAX_EDITABLE_DOCUMENT_MIB} MiB 保存上限`,
      );
      return Promise.resolve(false);
    }
    const requestSeq = documentRequestSeqRef.current;
    setSaving(true);
    setError('');
    setSaveNotice('');
    // Persist the exact request snapshot before crossing the process boundary.
    // A backend/browser crash can happen before the debounced draft effect or
    // the save response, so this synchronous checkpoint is part of the save
    // contract rather than a best-effort UI optimization.
    const recoveryPath = selected.actualPath || selected.path;
    if (!writeDraft(envRef.current?.uid, recoveryPath, snapshotContent, selected.revision)) {
      setSaveNotice('无法写入恢复草稿；保存失败时可能无法恢复本次修改');
    }
    const operation = (async () => {
      try {
        const response = await api.saveFile(
          selected.path,
          snapshotContent,
          selected.revision,
        );
        if (
          requestSeq !== documentRequestSeqRef.current ||
          currentRef.current?.path !== selected.path
        ) return false;

        const saved = response?.file || response || {};
        const nextRevision = fileRevision(saved) ?? selected.revision;
        const savedDocument = {
          ...selected,
          actualPath: saved.actualPath || selected.actualPath,
          size: saved.size ?? selected.size,
          mtime: saved.mtime ?? selected.mtime,
          ctime: saved.ctime ?? selected.ctime,
          revision: nextRevision,
          writable: saved.writable ?? selected.writable,
          resourceRevision: saved.mtime ?? ++resourceRevisionRef.current,
          contentUnavailable: false,
          contentUnavailableReason: null,
        };
        const cleanAfterSave = draftRef.current === snapshotContent;
        currentRef.current = savedDocument;
        contentRef.current = snapshotContent;
        dirtyRef.current = !cleanAfterSave;
        setContent(snapshotContent);
        setCurrent((previous) => (
          previous?.path === selected.path
            ? { ...previous, ...savedDocument }
            : previous
        ));
        updateConflict(null);
        const actualPath = saved.actualPath || selected.actualPath || selected.path;
        setSaveNotice(cleanAfterSave ? '已保存' : '已保存请求时的版本；仍有未保存修改');
        removeDraft(
          envRef.current?.uid,
          selected.actualPath || selected.path,
        );
        if (cleanAfterSave) {
          removeDraft(envRef.current?.uid, actualPath);
        } else {
          // Edits made while the request was in flight remain dirty and become
          // the next crash-recovery snapshot against the newly saved revision.
          writeDraft(envRef.current?.uid, actualPath, draftRef.current, nextRevision);
        }
        return cleanAfterSave;
      } catch (err) {
        if (
          requestSeq !== documentRequestSeqRef.current ||
          currentRef.current?.path !== selected.path
        ) return false;
        if (requiresSaveRecovery(err)) {
          try {
            const diskResult = await api.file(selected.path);
            if (
              requestSeq !== documentRequestSeqRef.current ||
              currentRef.current?.path !== selected.path
            ) return false;
            const diskContent = typeof diskResult.content === 'string' ? diskResult.content : '';
            const diskDocument = {
              ...selected,
              actualPath: diskResult.actualPath || selected.actualPath || selected.path,
              size: diskResult.size ?? null,
              mtime: diskResult.mtime ?? null,
              ctime: diskResult.ctime ?? null,
              revision: fileRevision(diskResult),
              writable: diskResult.writable ?? selected.writable,
              resourceRevision: diskResult.mtime ?? ++resourceRevisionRef.current,
              contentUnavailable: false,
              contentUnavailableReason: null,
            };
            const serverState = diskResult.recovery?.available
              ? diskResult.recovery
              : await api.recoveryState(selected.path);
            if (
              requestSeq !== documentRequestSeqRef.current ||
              currentRef.current?.path !== selected.path
            ) return false;
            const records = recoveryRecordsForUI(serverState, envRef.current);
            currentRef.current = diskDocument;
            contentRef.current = diskContent;
            dirtyRef.current = draftRef.current !== diskContent;
            setCurrent(diskDocument);
            setContent(diskContent);
            updateConflict(null);
            if (draftRef.current !== diskContent) {
              writeDraft(
                envRef.current?.uid,
                diskDocument.actualPath || diskDocument.path,
                draftRef.current,
                diskDocument.revision,
              );
            }
            if (records.length > 0) {
              const record = records[0];
              updateServerRecovery({
                document: diskDocument,
                records,
                record,
                cleanupOnly: record.phase === 'committed',
              });
            }
          } catch {
            try {
              const [diskState, serverState] = await Promise.all([
                api.fileState(selected.path),
                api.recoveryState(selected.path),
              ]);
              if (
                requestSeq !== documentRequestSeqRef.current ||
                currentRef.current?.path !== selected.path
              ) return false;
              const records = recoveryRecordsForUI(serverState, envRef.current);
              if (records.length > 0) {
                const record = records[0];
                const diskDocument = {
                  ...selected,
                  actualPath: diskState.actualPath || selected.actualPath || selected.path,
                  size: diskState.size ?? null,
                  mtime: diskState.mtime ?? null,
                  ctime: diskState.ctime ?? null,
                  revision: fileRevision(diskState),
                  writable: diskState.writable ?? selected.writable,
                  resourceRevision: diskState.mtime ?? ++resourceRevisionRef.current,
                };
                currentRef.current = diskDocument;
                contentRef.current = null;
                dirtyRef.current = true;
                setCurrent(diskDocument);
                setContent(null);
                updateConflict(null);
                updateServerRecovery({
                  document: diskDocument,
                  records,
                  record,
                  cleanupOnly: record.phase === 'committed',
                  diskReadable: false,
                });
              }
            } catch {
              // The request snapshot is already stored locally. If even the
              // metadata/recovery endpoints fail, retain the original error
              // and retry discovery on the next explicit open.
            }
          }
          setError(err.message);
        } else if (isSaveConflict(err)) {
          try {
            const diskResult = await api.file(selected.path);
            if (
              requestSeq !== documentRequestSeqRef.current ||
              currentRef.current?.path !== selected.path
            ) return false;
            const diskDocument = {
              ...selected,
              actualPath: diskResult.actualPath || selected.actualPath || selected.path,
              size: diskResult.size ?? null,
              mtime: diskResult.mtime ?? null,
              ctime: diskResult.ctime ?? null,
              revision: fileRevision(diskResult),
              writable: diskResult.writable ?? selected.writable,
              resourceRevision: diskResult.mtime ?? ++resourceRevisionRef.current,
              contentUnavailable: false,
              contentUnavailableReason: null,
            };
            updateConflict({
              draft: draftRef.current,
              diskContent: typeof diskResult.content === 'string' ? diskResult.content : '',
              diskDocument,
            });
            setError('');
          } catch (reloadError) {
            setError(`保存冲突，且无法读取最新磁盘版本：${reloadError.message}`);
          }
        } else {
          setError(err.message);
        }
        return false;
      } finally {
        if (savingRef.current === operation) savingRef.current = null;
        setSaving(false);
      }
    })();
    savingRef.current = operation;
    return operation;
  }, [flushPreviewContent, updateConflict, updateServerRecovery]);

  const discardCurrentDraft = useCallback(() => {
    clearStoredDraft();
    draftRef.current = contentRef.current;
    dirtyRef.current = false;
    setDraft(contentRef.current);
    updateConflict(null);
    updateRecovery(null);
    setSaveNotice('');
  }, [clearStoredDraft, updateConflict, updateRecovery]);

  const confirmDocumentTransition = useCallback((message) => {
    if (serverRecoveryRef.current) return Promise.resolve(false);
    if (!dirtyRef.current) return Promise.resolve(true);
    if (transitionPromptRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      setError('');
      const prompt = { message, resolve };
      transitionPromptRef.current = prompt;
      setTransitionPrompt(prompt);
    });
  }, []);

  const finishTransitionPrompt = useCallback((proceed) => {
    const active = transitionPromptRef.current;
    if (!active) return;
    transitionPromptRef.current = null;
    setTransitionPrompt(null);
    active.resolve(proceed);
  }, []);

  const saveBeforeTransition = useCallback(async () => {
    const cleanAfterSave = await saveCurrent();
    if (cleanAfterSave) finishTransitionPrompt(true);
  }, [finishTransitionPrompt, saveCurrent]);

  const discardBeforeTransition = useCallback(() => {
    discardCurrentDraft();
    finishTransitionPrompt(true);
  }, [discardCurrentDraft, finishTransitionPrompt]);

  const cancelTransition = useCallback(() => {
    finishTransitionPrompt(false);
  }, [finishTransitionPrompt]);

  useEffect(() => {
    const actualPath = current?.actualPath || current?.path;
    if (!isDirty || env?.uid == null || !actualPath || draft == null) return undefined;
    const timerId = window.setTimeout(() => {
      if (!writeDraft(env.uid, actualPath, draft, current.revision)) {
        setSaveNotice('无法写入恢复草稿，请尽快保存当前修改');
      }
    }, DRAFT_PERSIST_DELAY_MS);
    return () => window.clearTimeout(timerId);
  }, [current?.actualPath, current?.path, current?.revision, draft, env?.uid, isDirty]);

  useEffect(() => {
    const document = current;
    const tabId = activeTabIdRef.current;
    if (!document?.path || !tabId) return;
    updateTabs((previous) => previous.map((tab) => (
      tab.id === tabId
        ? {
          ...tab,
          path: document.path,
          actualPath: document.actualPath || null,
          name: document.name || basename(document.path),
          displayPath: document.displayPath || document.path,
          loaded: true,
          document,
          content,
          draft,
          viewMode,
          saveNotice,
          dirty: isDirty,
        }
        : tab
    )));
  }, [content, current, draft, isDirty, saveNotice, updateTabs, viewMode]);

  useEffect(() => {
    if (!sessionRestoredRef.current || env?.uid == null) return;
    writeDocumentSession(env.uid, tabs, activeTabId);
  }, [activeTabId, env?.uid, tabs]);

  useEffect(() => {
    const actualPath = current?.actualPath || current?.path;
    if (
      content !== null &&
      !isDirty &&
      !recovery &&
      !serverRecovery &&
      !conflict &&
      env?.uid != null &&
      actualPath
    ) {
      removeDraft(env.uid, actualPath);
    }
  }, [
    conflict,
    content,
    current?.actualPath,
    current?.path,
    env?.uid,
    isDirty,
    recovery,
    serverRecovery,
  ]);

  useEffect(() => {
    const persistNow = () => {
      const selected = currentRef.current;
      const actualPath = selected?.actualPath || selected?.path;
      if (dirtyRef.current && actualPath && draftRef.current != null) {
        writeDraft(envRef.current?.uid, actualPath, draftRef.current, selected.revision);
      }
      const activeId = activeTabIdRef.current;
      const sessionTabs = tabsRef.current.map((tab) => (
        tab.id === activeId && selected?.path
          ? {
            ...tab,
            path: selected.path,
            actualPath: selected.actualPath || null,
            name: selected.name || basename(selected.path),
            displayPath: selected.displayPath || selected.path,
            dirty: dirtyRef.current,
          }
          : tab
      ));
      for (const tab of sessionTabs) {
        const tabPath = tab.document?.actualPath || tab.actualPath || tab.path;
        if (tab.dirty && typeof tab.draft === 'string' && tabPath) {
          writeDraft(
            envRef.current?.uid,
            tabPath,
            tab.draft,
            tab.document?.revision ?? null,
          );
        }
      }
      writeDocumentSession(envRef.current?.uid, sessionTabs, activeId);
    };
    const onBeforeUnload = (event) => {
      const hasDirtyTab = dirtyRef.current || tabsRef.current.some((tab) => tab.dirty);
      if (!hasDirtyTab) return;
      persistNow();
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => persistNow();
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const command = event.metaKey || event.ctrlKey;
      if (!command) {
        if (event.key === 'Escape' && findOpen) setFindOpen(false);
        return;
      }
      switch (event.key.toLowerCase()) {
      case 's':
        event.preventDefault();
        void saveCurrent();
        break;
      case 'f':
        event.preventDefault();
        setFindOpen(true);
        setReplaceOpen(false);
        break;
      case 'h':
        if (!currentRef.current) return;
        event.preventDefault();
        setFindOpen(true);
        setReplaceOpen(true);
        break;
      case 'g':
        if (!findOpen) return;
        event.preventDefault();
        navigateFind(event.shiftKey ? -1 : 1);
        break;
      default:
        break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [findOpen, navigateFind, saveCurrent]);

  const reloadConflictFromDisk = useCallback(() => {
    const active = conflictRef.current;
    if (!active || currentRef.current?.path !== active.diskDocument.path) return;
    clearStoredDraft();
    clearStoredDraft(active.diskDocument);
    currentRef.current = active.diskDocument;
    contentRef.current = active.diskContent;
    draftRef.current = active.diskContent;
    dirtyRef.current = false;
    setContent(active.diskContent);
    setDraft(active.diskContent);
    setCurrent(active.diskDocument);
    updateConflict(null);
    setSaveNotice('已重新加载磁盘版本');
    if (transitionPromptRef.current) finishTransitionPrompt(true);
  }, [clearStoredDraft, finishTransitionPrompt, updateConflict]);

  const keepConflictDraft = useCallback(() => {
    const active = conflictRef.current;
    if (!active || currentRef.current?.path !== active.diskDocument.path) return;
    const retainedDraft = draftRef.current ?? active.draft;
    clearStoredDraft();
    currentRef.current = active.diskDocument;
    contentRef.current = active.diskContent;
    draftRef.current = retainedDraft;
    dirtyRef.current = retainedDraft !== active.diskContent;
    setContent(active.diskContent);
    setDraft(retainedDraft);
    setCurrent(active.diskDocument);
    updateConflict(null);
    if (retainedDraft === active.diskContent) {
      clearStoredDraft(active.diskDocument);
    } else {
      const actualPath = active.diskDocument.actualPath || active.diskDocument.path;
      writeDraft(
        envRef.current?.uid,
        actualPath,
        retainedDraft,
        active.diskDocument.revision,
      );
    }
    setSaveNotice('已保留草稿；再次保存将覆盖最新磁盘版本');
  }, [clearStoredDraft, updateConflict]);

  const useDiskRecovery = useCallback(() => {
    if (!recovery || recovery.diskReadable === false) return;
    clearStoredDraft(recovery.diskDocument);
    currentRef.current = recovery.diskDocument;
    contentRef.current = recovery.diskContent;
    draftRef.current = recovery.diskContent;
    dirtyRef.current = false;
    setCurrent(recovery.diskDocument);
    setContent(recovery.diskContent);
    setDraft(recovery.diskContent);
    updateRecovery(null);
    setSaveNotice('已使用磁盘版本');
  }, [clearStoredDraft, recovery, updateRecovery]);

  const restoreRecoveryDraft = useCallback(() => {
    if (!recovery) return;
    const diskUnreadable = recovery.diskReadable === false;
    const restoredDraft = recovery.draft.content;
    const diskDocument = {
      ...recovery.diskDocument,
      contentUnavailable: diskUnreadable,
      contentUnavailableReason: diskUnreadable ? recovery.diskError || null : null,
    };
    currentRef.current = diskDocument;
    contentRef.current = diskUnreadable ? null : recovery.diskContent;
    draftRef.current = restoredDraft;
    dirtyRef.current = diskUnreadable || restoredDraft !== recovery.diskContent;
    setCurrent(diskDocument);
    setContent(diskUnreadable ? null : recovery.diskContent);
    setDraft(restoredDraft);
    updateRecovery(null);
    writeDraft(
      envRef.current?.uid,
      diskDocument.actualPath || diskDocument.path,
      restoredDraft,
      diskDocument.revision,
    );
    if (diskUnreadable) {
      setViewMode('edit');
      setError(
        `磁盘正文无法预览${recovery.diskError ? `：${recovery.diskError}` : ''}。` +
        '当前显示本地草稿；保存时将用最新 revision 做冲突校验。',
      );
      setSaveNotice('已恢复本地草稿；保存时将覆盖当前不可预览的磁盘版本');
    } else {
      setSaveNotice('已恢复草稿；保存时将覆盖当前磁盘版本');
    }
  }, [recovery, updateRecovery]);

  const discardServerRecovery = useCallback(async () => {
    const active = serverRecoveryRef.current;
    if (!active || serverRecoveryBusy) return;
    // Recovery authorization is tied to the exact user-requested path. The
    // canonical actualPath is only an identity/display key and can legitimately
    // sit below an authorized symlink/alias that the backend must resolve itself.
    const documentPath = active.document.path;
    const controller = new AbortController();
    serverRecoveryAbortRef.current?.abort();
    serverRecoveryAbortRef.current = controller;
    setServerRecoveryBusy(true);
    setError('');
    setServerRecoveryError('');
    try {
      await api.discardRecovery(
        documentPath,
        active.record.recoveryId,
        { signal: controller.signal },
      );
      if (serverRecoveryRef.current !== active) return;
      const remaining = active.records.filter(
        (record) => record.recoveryId !== active.record.recoveryId,
      );
      updateServerRecovery(remaining.length > 0
        ? { ...active, records: remaining, record: remaining[0] }
        : null);
      setSaveNotice(remaining.length > 0 ? '已清理一条恢复记录' : '已保留当前磁盘版本');
    } catch (err) {
      if (err?.name !== 'AbortError' && serverRecoveryRef.current === active) {
        setServerRecoveryError(err.message);
      }
    } finally {
      if (serverRecoveryAbortRef.current === controller) {
        serverRecoveryAbortRef.current = null;
        setServerRecoveryBusy(false);
      }
    }
  }, [serverRecoveryBusy, updateServerRecovery]);

  const restoreServerRecovery = useCallback(async (version) => {
    const active = serverRecoveryRef.current;
    if (
      !active ||
      serverRecoveryBusy ||
      active.cleanupOnly ||
      active.record.targetMatches === false
    ) return;
    const available = version === 'attempted'
      ? active.record.attemptedAvailable
      : active.record.baselineAvailable;
    if (!available) return;
    const documentPath = active.document.path;
    const draftIdentity = active.document.actualPath || documentPath;
    const requestSeq = documentRequestSeqRef.current;
    const controller = new AbortController();
    serverRecoveryAbortRef.current?.abort();
    serverRecoveryAbortRef.current = controller;
    setServerRecoveryBusy(true);
    setError('');
    setServerRecoveryError('');
    try {
      // The restore transaction never moves recovery bytes through browser JSON.
      // Capture a fresh inode-bound revision, then ask the backend to commit the
      // opaque recovery artifact under the same ACL/path/inode CAS as a save.
      const diskState = await api.fileState(
        documentPath,
        { signal: controller.signal },
      );
      if (
        serverRecoveryRef.current !== active ||
        requestSeq !== documentRequestSeqRef.current ||
        currentRef.current?.path !== documentPath
      ) return;
      if (diskState.writable === false) {
        throw new Error('当前文稿仍为只读；请在 fnOS 应用设置中授予读写权限后重试');
      }
      const expectedRevision = fileRevision(diskState);
      if (!expectedRevision) throw new Error('无法取得当前磁盘 revision，恢复已取消');
      const response = await api.commitRecovery(
        documentPath,
        active.record.recoveryId,
        version,
        expectedRevision,
        { signal: controller.signal },
      );
      if (
        serverRecoveryRef.current !== active ||
        requestSeq !== documentRequestSeqRef.current ||
        currentRef.current?.path !== documentPath
      ) return;

      // Best-effort reload keeps small UTF-8 versions previewable. A committed
      // oversized or non-UTF-8 recovery is still a success: the dedicated
      // endpoint has already restored it without weakening ordinary read limits.
      let restored = null;
      let previewError = null;
      try {
        restored = await api.file(documentPath, { signal: controller.signal });
      } catch (reloadError) {
        if (reloadError?.name === 'AbortError') throw reloadError;
        previewError = reloadError;
      }
      if (
        serverRecoveryRef.current !== active ||
        requestSeq !== documentRequestSeqRef.current ||
        currentRef.current?.path !== documentPath
      ) return;
      const saved = response?.file || response || {};
      const restoredContent = typeof restored?.content === 'string' ? restored.content : null;
      const savedDocument = {
        ...active.document,
        path: documentPath,
        actualPath: restored?.actualPath || saved.actualPath || diskState.actualPath
          || active.document.actualPath || documentPath,
        size: restored?.size ?? saved.size ?? diskState.size ?? null,
        mtime: restored?.mtime ?? saved.mtime ?? diskState.mtime ?? null,
        ctime: restored?.ctime ?? saved.ctime ?? diskState.ctime ?? null,
        revision: fileRevision(restored) ?? fileRevision(saved) ?? expectedRevision,
        writable: restored?.writable ?? saved.writable ?? diskState.writable
          ?? active.document.writable,
        resourceRevision: restored?.mtime ?? saved.mtime ?? ++resourceRevisionRef.current,
        contentUnavailable: restoredContent == null,
        contentUnavailableReason: restoredContent == null ? previewError?.message || null : null,
      };
      const pendingLocal = recoveryRef.current?.draft?.content ?? (
        dirtyRef.current ? draftRef.current : null
      ) ?? readDraft(envRef.current?.uid, draftIdentity)?.content ?? null;

      currentRef.current = savedDocument;
      contentRef.current = restoredContent;
      setCurrent(savedDocument);
      setContent(restoredContent);
      if (restoredContent != null && pendingLocal != null && pendingLocal !== restoredContent) {
        draftRef.current = pendingLocal;
        dirtyRef.current = true;
        setDraft(pendingLocal);
        updateRecovery({
          draft: { content: pendingLocal },
          diskContent: restoredContent,
          diskDocument: savedDocument,
        });
        writeDraft(
          envRef.current?.uid,
          savedDocument.actualPath || savedDocument.path,
          pendingLocal,
          savedDocument.revision,
        );
      } else if (restoredContent != null) {
        draftRef.current = restoredContent;
        dirtyRef.current = false;
        setDraft(restoredContent);
        updateRecovery(null);
        clearStoredDraft(savedDocument);
      } else {
        // The disk now contains the requested recovery bytes, but this reader
        // cannot safely decode/preview them. Never synthesize an empty baseline
        // or discard an unrelated local draft.
        draftRef.current = null;
        dirtyRef.current = false;
        setDraft(null);
        if (pendingLocal != null) {
          writeDraft(
            envRef.current?.uid,
            savedDocument.actualPath || savedDocument.path,
            pendingLocal,
            savedDocument.revision,
          );
          updateRecovery({
            draft: {
              content: pendingLocal,
              sourceRevision: savedDocument.revision,
            },
            diskContent: null,
            diskDocument: savedDocument,
            diskReadable: false,
            diskError: previewError?.message || '当前磁盘正文无法在应用内预览',
          });
        } else {
          updateRecovery(null);
        }
      }

      try {
        await api.discardRecovery(
          documentPath,
          active.record.recoveryId,
          { signal: controller.signal },
        );
        if (serverRecoveryRef.current !== active) return;
        updateServerRecovery(null);
        if (previewError) {
          setSaveNotice('恢复版本已写入磁盘，但当前版本无法在应用内预览');
          setError(`版本已恢复，但无法读取用于预览：${previewError.message}`);
        } else {
          setSaveNotice('恢复版本已通过 revision 校验并写入磁盘');
        }
      } catch (cleanupError) {
        if (cleanupError?.name === 'AbortError') throw cleanupError;
        if (serverRecoveryRef.current !== active) return;
        updateServerRecovery({
          ...active,
          document: savedDocument,
          cleanupOnly: true,
        });
        setServerRecoveryError(`版本已恢复，但旧恢复记录清理失败：${cleanupError.message}`);
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && serverRecoveryRef.current === active) {
        setServerRecoveryError(err.message);
      }
    } finally {
      if (serverRecoveryAbortRef.current === controller) {
        serverRecoveryAbortRef.current = null;
        setServerRecoveryBusy(false);
      }
    }
  }, [
    clearStoredDraft,
    serverRecoveryBusy,
    updateRecovery,
    updateServerRecovery,
  ]);

  const hydrateRecents = useCallback(async (nextEnv) => {
    const requestSeq = ++recentHydrationSeqRef.current;
    recentHydrationAbortRef.current?.abort();
    const controller = new AbortController();
    recentHydrationAbortRef.current = controller;
    removedRecentIdentitiesRef.current.clear();
    const stored = readRecentDocuments(nextEnv?.uid);
    if (!stored.length) {
      if (recentHydrationAbortRef.current === controller) {
        recentHydrationAbortRef.current = null;
      }
      deferredRecentsRef.current = [];
      setRecents([]);
      return;
    }

    // Metadata remains hidden until each path passes the same backend ACL and
    // realpath validation as a normal open. Keep this metadata-only validation
    // bounded so startup never downloads bodies or fans out twelve NAS reads.
    const validations = await allSettledBounded(
      stored,
      (item) => api.fileState(item.path, { signal: controller.signal }),
      3,
    );
    if (recentHydrationAbortRef.current === controller) {
      recentHydrationAbortRef.current = null;
    }
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
  const openFile = useCallback(async (
    item,
    { standalone = false, forceReload = false, tabId = null } = {},
  ) => {
    const targetId = tabId || item.path;
    const existingTab = tabsRef.current.find((tab) => (
      tab.id === targetId ||
      tab.path === item.path ||
      (item.actualPath && (tab.actualPath === item.actualPath || tab.document?.actualPath === item.actualPath))
    ));
    if (!forceReload && existingTab?.loaded) {
      captureActiveTab();
      // captureActiveTab updates tabsRef synchronously. Re-read the target so
      // a click on the already-open document cannot reapply a stale draft
      // snapshot from before the latest editor change.
      const refreshedTab = tabsRef.current.find((tab) => tab.id === existingTab.id);
      applyTabSnapshot(refreshedTab || existingTab);
      return true;
    }
    if (!existingTab && tabsRef.current.length >= MAX_DOCUMENT_TABS) {
      setError(`最多同时打开 ${MAX_DOCUMENT_TABS} 个文稿，请先关闭一个标签页。`);
      return false;
    }
    const previousTabId = activeTabIdRef.current;
    const createdPlaceholder = !existingTab;
    if (createdPlaceholder) {
      updateTabs((previous) => [...previous, {
        id: targetId,
        path: item.path,
        actualPath: item.actualPath || null,
        name: item.name || basename(item.path),
        displayPath: item.displayPath || item.path,
        type: 'file',
        loaded: false,
        dirty: false,
      }]);
    }
    const requestSeq = ++documentRequestSeqRef.current;
    documentOpenAbortRef.current?.abort();
    documentPollAbortRef.current?.abort();
    const controller = new AbortController();
    documentOpenAbortRef.current = controller;
    pendingOpenRef.current = null;
    setLoading(true);
    setError('');
    try {
      const result = await api.file(item.path, { signal: controller.signal });
      if (requestSeq !== documentRequestSeqRef.current) return false;
      if (!result || typeof result !== 'object' || typeof result.content !== 'string') {
        throw new Error('文件服务返回了无效的文稿内容');
      }

      const text = result.content;
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
        revision: fileRevision(result),
        // New backends always return this capability. Missing means an older
        // compatible backend, whose save endpoint remains the final authority.
        writable: result.writable !== false,
        resourceRevision: result.mtime ?? ++resourceRevisionRef.current,
        contentUnavailable: false,
        contentUnavailableReason: null,
      };
      const storedDraft = readDraft(envRef.current?.uid, actualPath);
      const serverRecords = recoveryRecordsForUI(result.recovery, envRef.current);
      const committedRecords = result.recovery?.available && Array.isArray(result.recovery.records)
        ? result.recovery.records.filter((record) => (
          record?.phase === 'committed'
          && record.currentMatchesAttempt === true
          && envRef.current?.capabilities?.recoveryPolicy?.cleanupMode !== 'explicit'
        ))
        : [];
      let nextDraft = text;
      let nextRecovery = null;
      let nextSaveNotice = '';
      if (storedDraft?.content === text) {
        removeDraft(envRef.current?.uid, actualPath);
      } else if (
        storedDraft &&
        storedDraft.sourceRevision != null &&
        storedDraft.sourceRevision === nextCurrent.revision
      ) {
        nextDraft = storedDraft.content;
        nextSaveNotice = '已恢复未保存草稿';
      } else if (storedDraft) {
        nextRecovery = { draft: storedDraft, diskContent: text, diskDocument: nextCurrent };
      }
      captureActiveTab();
      activeTabIdRef.current = existingTab?.id || targetId;
      setActiveTabId(activeTabIdRef.current);
      currentRef.current = nextCurrent;
      contentRef.current = text;
      draftRef.current = nextDraft;
      dirtyRef.current = nextDraft !== text;
      setContent(text);
      setDraft(nextDraft);
      setCurrent(nextCurrent);
      updateConflict(null);
      updateRecovery(nextRecovery);
      if (serverRecords.length > 0) {
        const record = serverRecords[0];
        updateServerRecovery({
          document: nextCurrent,
          records: serverRecords,
          record,
          cleanupOnly: record.phase === 'committed',
        });
      } else {
        updateServerRecovery(null);
      }
      for (const record of committedRecords) {
        if (typeof record?.recoveryId === 'string') {
          void api.discardRecovery(nextCurrent.path, record.recoveryId).catch(() => {});
        }
      }
      setViewMode('preview');
      setSaveNotice(nextSaveNotice);
      updateTabs((previous) => previous.map((tab) => (
        tab.id === activeTabIdRef.current
          ? {
            ...tab,
            id: activeTabIdRef.current,
            path: nextCurrent.path,
            actualPath: nextCurrent.actualPath,
            name: nextCurrent.name,
            displayPath: nextCurrent.displayPath,
            loaded: true,
            document: nextCurrent,
            content: text,
            draft: nextDraft,
            viewMode: 'preview',
            saveNotice: nextSaveNotice,
            dirty: nextDraft !== text,
          }
          : tab
      )));
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
      if (err?.name === 'AbortError') return false;
      if (requestSeq !== documentRequestSeqRef.current) return false;
      setError(err.message);
      if (err.status === 403) {
        pendingOpenRef.current = { item, standalone };
      } else if (err.status !== 404) {
        try {
          const [fileStateResult, serverStateResult] = await Promise.allSettled([
            api.fileState(item.path, { signal: controller.signal }),
            api.recoveryState(item.path, { signal: controller.signal }),
          ]);
          if (requestSeq !== documentRequestSeqRef.current) return false;
          const serverState = serverStateResult.status === 'fulfilled'
            ? serverStateResult.value
            : null;
          const records = recoveryRecordsForUI(serverState, envRef.current);
          const fileState = fileStateResult.status === 'fulfilled'
            ? fileStateResult.value
            : null;
          const actualPath = fileState?.actualPath || item.actualPath || item.path;
          const storedDraft = fileState && [413, 422].includes(err.status)
            ? readDraft(envRef.current?.uid, actualPath)
            : null;
          if (records.length > 0 || storedDraft) {
            const workspace = deepestWorkspace(workspacesRef.current, actualPath);
            const recoveryDocument = {
              ...item,
              path: item.path,
              actualPath,
              name: item.name || basename(item.path),
              displayPath: item.displayPath || item.path,
              type: 'file',
              workspacePath: workspace?.path || null,
              workspaceActualPath: workspace ? workspaceActualPath(workspace) : null,
              size: fileState?.size ?? null,
              mtime: fileState?.mtime ?? null,
              ctime: fileState?.ctime ?? null,
              revision: fileRevision(fileState),
              writable: fileState ? fileState.writable !== false : undefined,
              resourceRevision: fileState?.mtime ?? ++resourceRevisionRef.current,
              contentUnavailable: true,
              contentUnavailableReason: err.message,
            };
            captureActiveTab();
            activeTabIdRef.current = existingTab?.id || targetId;
            setActiveTabId(activeTabIdRef.current);
            currentRef.current = recoveryDocument;
            contentRef.current = null;
            draftRef.current = null;
            dirtyRef.current = false;
            setCurrent(recoveryDocument);
            setContent(null);
            setDraft(null);
            updateConflict(null);
            updateRecovery(storedDraft ? {
              draft: storedDraft,
              diskContent: null,
              diskDocument: recoveryDocument,
              diskReadable: false,
              diskError: err.message,
            } : null);
            if (records.length > 0) {
              const record = records[0];
              updateServerRecovery({
                document: recoveryDocument,
                records,
                record,
                cleanupOnly: record.phase === 'committed',
                diskReadable: false,
                metadataUnavailable: fileState === null,
              });
            } else {
              updateServerRecovery(null);
            }
            setViewMode('preview');
            setSaveNotice(records.length > 0
              ? fileState
                ? '磁盘正文无法直接读取，请先处理服务端恢复版本'
                : '已找到服务端恢复记录；恢复前将重新获取磁盘 revision'
              : '磁盘正文无法预览；已找到可继续编辑的本地草稿');
            updateTabs((previous) => previous.map((tab) => (
              tab.id === activeTabIdRef.current
                ? {
                  ...tab,
                  loaded: true,
                  document: recoveryDocument,
                  content: null,
                  draft: null,
                  viewMode: 'preview',
                  dirty: Boolean(storedDraft),
                }
                : tab
            )));
            await setTitle(recoveryDocument.name || recoveryDocument.displayPath || 'Flux Reader');
            if (requestSeq !== documentRequestSeqRef.current) return false;
            if (standalone) {
              for (const workspaceItem of workspacesRef.current) {
                nextWorkspaceRequest(workspaceItem.path);
              }
              workspaceStateRef.current.clear();
              setWorkspaces([]);
              setSidebarOpen(false);
            }
            return true;
          }
        } catch {
          // A normal read error remains authoritative when no authorized,
          // inode-matching recovery record can be established.
        }
      }
      if (createdPlaceholder) {
        updateTabs((previous) => previous.filter((tab) => tab.id !== targetId));
      }
      if (previousTabId && activeTabIdRef.current !== previousTabId) {
        const previous = tabsRef.current.find((tab) => tab.id === previousTabId);
        if (previous?.loaded) applyTabSnapshot(previous);
      }
      return false;
    } finally {
      if (documentOpenAbortRef.current === controller) {
        documentOpenAbortRef.current = null;
      }
      if (requestSeq === documentRequestSeqRef.current) setLoading(false);
    }
  }, [
    applyTabSnapshot,
    captureActiveTab,
    nextWorkspaceRequest,
    recordRecent,
    updateTabs,
    updateConflict,
    updateRecovery,
    updateServerRecovery,
  ]);

  const openFileWithGuard = useCallback(async (item, options = {}) => {
    if (savingRef.current) {
      setError('当前文稿正在保存，请稍后再打开其他文稿。');
      return false;
    }
    const selectedPath = currentRef.current?.actualPath || currentRef.current?.path;
    const targetPath = item?.actualPath || item?.path;
    if (selectedPath !== targetPath || options.forceReload !== true) {
      return openFile(item, options);
    }
    const message = selectedPath === targetPath
      ? '重新加载当前文稿前，需要处理尚未保存的修改。'
      : '打开其他文稿前，需要处理当前尚未保存的修改。';
    if (!await confirmDocumentTransition(message)) return false;
    return openFile(item, options);
  }, [confirmDocumentTransition, openFile]);

  const activateTab = useCallback(async (tabId) => {
    if (!tabId || tabId === activeTabIdRef.current) return true;
    if (
      savingRef.current || conflictRef.current || recoveryRef.current ||
      serverRecoveryRef.current || transitionPromptRef.current
    ) {
      setError('请先完成当前文稿操作，再切换标签页。');
      return false;
    }
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    captureActiveTab();
    if (tab.loaded) return applyTabSnapshot(tab);
    return openFile(tab, { tabId: tab.id });
  }, [applyTabSnapshot, captureActiveTab, openFile]);

  const clearActiveDocument = useCallback(() => {
    documentRequestSeqRef.current += 1;
    documentOpenAbortRef.current?.abort();
    documentPollAbortRef.current?.abort();
    currentRef.current = null;
    contentRef.current = null;
    draftRef.current = null;
    dirtyRef.current = false;
    activeTabIdRef.current = null;
    setCurrent(null);
    setContent(null);
    setDraft(null);
    setActiveTabId(null);
    setViewMode('preview');
    setSaveNotice('');
    updateConflict(null);
    updateRecovery(null);
    updateServerRecovery(null);
    setFindOpen(false);
    void setTitle('Flux Reader');
  }, [updateConflict, updateRecovery, updateServerRecovery]);

  const closeTab = useCallback(async (tabId) => {
    let tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    if (tabId !== activeTabIdRef.current) {
      const tabIsDirty = tab.dirty === true || (
        typeof tab.draft === 'string' && typeof tab.content === 'string'
          ? tab.draft !== tab.content
          : false
      );
      if (!tabIsDirty) {
        updateTabs((previous) => previous.filter((candidate) => candidate.id !== tabId));
        return true;
      }
      if (!await activateTab(tabId)) return false;
      tab = tabsRef.current.find((candidate) => candidate.id === tabId) || tab;
    }
    if (dirtyRef.current) {
      const proceed = await confirmDocumentTransition(
        `关闭“${tab.name || tab.path}”前，需要处理尚未保存的修改。`,
      );
      if (!proceed) return false;
    }

    const previousTabs = tabsRef.current;
    const index = previousTabs.findIndex((candidate) => candidate.id === tabId);
    const remaining = previousTabs.filter((candidate) => candidate.id !== tabId);
    updateTabs(remaining);
    if (remaining.length === 0) {
      clearActiveDocument();
      return true;
    }
    const nextTab = remaining[Math.min(index, remaining.length - 1)];
    if (nextTab.loaded) {
      applyTabSnapshot(nextTab);
      return true;
    }
    clearActiveDocument();
    return openFile(nextTab, { tabId: nextTab.id });
  }, [
    activateTab,
    applyTabSnapshot,
    clearActiveDocument,
    confirmDocumentTransition,
    openFile,
    updateTabs,
  ]);

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
      await openFileWithGuard(
        { path: filePath, name: basename(filePath), displayPath: filePath, type: 'file' },
        { standalone: true },
      );
    } catch (err) {
      setError(err.message);
    } finally {
      pickerActiveRef.current = false;
      setPickingFile(false);
    }
  }, [openFileWithGuard]);

  useEffect(() => {
    const openFileFromMenu = () => void onOpenStandaloneFile();
    const openFolderFromMenu = () => void onOpenFolder();
    window.addEventListener('flux-reader:open-file', openFileFromMenu);
    window.addEventListener('flux-reader:open-folder', openFolderFromMenu);
    return () => {
      window.removeEventListener('flux-reader:open-file', openFileFromMenu);
      window.removeEventListener('flux-reader:open-folder', openFolderFromMenu);
    };
  }, [onOpenFolder, onOpenStandaloneFile]);

  const closeWorkspace = useCallback((rawPath) => {
    const path = normalizeWorkspacePath(rawPath);
    if (!path) return;
    // Closing a workspace only removes it from the navigation sidebar. The
    // current document intentionally remains open, so there is no document
    // transition and its draft must not be discarded or saved implicitly.
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
    if (!selected?.path || pickerActiveRef.current || documentOpenAbortRef.current) return;
    const requestSeq = documentRequestSeqRef.current;
    const pickerGeneration = pickerGenerationRef.current;
    documentPollAbortRef.current?.abort();
    const controller = new AbortController();
    documentPollAbortRef.current = controller;
    const isCurrent = () => (
      !pickerActiveRef.current &&
      !transitionPromptRef.current &&
      !conflictRef.current &&
      !recoveryRef.current &&
      !serverRecoveryRef.current &&
      pickerGeneration === pickerGenerationRef.current &&
      requestSeq === documentRequestSeqRef.current &&
      currentRef.current?.path === selected.path &&
      currentRef.current?.revision === selected.revision
    );
    try {
      const fileState = await api.fileState(selected.path, { signal: controller.signal });
      if (!isCurrent()) return;

      const stateWritable = fileState.writable !== false;
      if (selected.writable !== stateWritable) {
        const capabilityDocument = { ...currentRef.current, writable: stateWritable };
        currentRef.current = capabilityDocument;
        setCurrent((previous) => (
          previous?.path === selected.path
            ? { ...previous, writable: stateWritable }
            : previous
        ));
        if (!stateWritable && dirtyRef.current) {
          setError('当前文稿已变为只读；草稿仍保留，恢复读写权限后可继续保存');
        }
      }

      const stateRecoveryRecords = recoveryRecordsForUI(fileState.recovery, envRef.current);
      if (stateRecoveryRecords.length > 0) {
        const record = stateRecoveryRecords[0];
        updateServerRecovery({
          document: currentRef.current,
          records: stateRecoveryRecords,
          record,
          cleanupOnly: record.phase === 'committed',
        });
        return;
      }

      const actualPath = fileState.actualPath || selected.actualPath || selected.path;
      if (!fileMetadataChanged(selected, fileState)) {
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

      // The compare-and-swap save endpoint is authoritative while a save is in
      // flight. Let it report a conflict instead of racing a poll against it.
      if (savingRef.current) return;

      const result = await api.file(selected.path, { signal: controller.signal });
      if (!isCurrent()) return;

      const text = typeof result.content === 'string' ? result.content : '';
      const diskDocument = {
        ...selected,
        actualPath: result.actualPath || actualPath,
        size: result.size ?? fileState.size ?? selected.size,
        mtime: result.mtime ?? fileState.mtime ?? selected.mtime,
        ctime: result.ctime ?? fileState.ctime ?? selected.ctime,
        revision: fileRevision(result) ?? fileRevision(fileState),
        writable: result.writable ?? fileState.writable ?? selected.writable,
        resourceRevision: result.mtime ?? ++resourceRevisionRef.current,
        contentUnavailable: false,
        contentUnavailableReason: null,
      };
      if (dirtyRef.current) {
        const pendingRevision = conflictRef.current?.diskDocument?.revision;
        if (!conflictRef.current || pendingRevision !== diskDocument.revision) {
          updateConflict({
            draft: draftRef.current,
            diskContent: text,
            diskDocument,
          });
        }
        setError('');
        return;
      }
      currentRef.current = diskDocument;
      contentRef.current = text;
      draftRef.current = text;
      dirtyRef.current = false;
      setContent(text);
      setDraft(text);
      setCurrent((previous) => (
        previous?.path === selected.path
          ? { ...previous, ...diskDocument }
          : previous
      ));
      setError('');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (!isCurrent()) return;
      if ([400, 403, 404, 413, 422].includes(err.status) && !dirtyRef.current) {
        documentRequestSeqRef.current += 1;
        pendingOpenRef.current = null;
        currentRef.current = null;
        contentRef.current = null;
        draftRef.current = null;
        dirtyRef.current = false;
        setCurrent(null);
        setContent(null);
        setDraft(null);
        void Promise.resolve(setTitle('Flux Reader')).catch(() => {});
      }
      setError(err.message);
    } finally {
      if (documentPollAbortRef.current === controller) {
        documentPollAbortRef.current = null;
      }
    }
  }, [updateConflict, updateServerRecovery]);

  const runRefreshCycle = useCallback(async ({ forceWorkspaces = false } = {}) => {
    if (
      pollInFlightRef.current ||
      pickerActiveRef.current ||
      transitionPromptRef.current ||
      conflictRef.current ||
      recoveryRef.current ||
      serverRecoveryRef.current ||
      document.visibilityState === 'hidden'
    ) return;

    pollInFlightRef.current = true;
    try {
      const snapshot = [...workspacesRef.current];
      // Recursive state scans can be expensive on a NAS. Keep them sequential
      // and let the recursive timer wait for the whole cycle, avoiding both a
      // burst across eight roots and overlap with the next cycle.
      for (const workspace of snapshot) {
        if (
          pickerActiveRef.current ||
          transitionPromptRef.current ||
          conflictRef.current ||
          recoveryRef.current ||
          serverRecoveryRef.current ||
          document.visibilityState === 'hidden'
        ) return;
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
      if (
        pickerActiveRef.current ||
        transitionPromptRef.current ||
        conflictRef.current ||
        recoveryRef.current ||
        serverRecoveryRef.current ||
        document.visibilityState === 'hidden'
      ) return;

      const retry = pendingOpenRef.current;
      if (retry) {
        const opened = await openFileWithGuard(
          retry.item,
          { standalone: retry.standalone },
        );
        // A guard that the user explicitly cancels leaves the original pending
        // object untouched. Clear only that attempt so the 15s poll does not
        // repeatedly reopen the same dialog. A renewed 403 creates a different
        // pending object in openFile and remains eligible for a later retry.
        if (!opened && pendingOpenRef.current === retry) pendingOpenRef.current = null;
      } else {
        await pollCurrentDocument();
      }
    } finally {
      pollInFlightRef.current = false;
    }
  }, [openFileWithGuard, pollCurrentDocument, pollWorkspace, refreshWorkspace]);

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

  useEffect(() => {
    if (!env || sessionRestoredRef.current) return;
    if (launchPathRef.current) {
      sessionRestoredRef.current = true;
      return;
    }
    const session = readDocumentSession(env.uid);
    sessionRestoredRef.current = true;
    if (session.tabs.length === 0) return;
    const restoredTabs = session.tabs.map((tab) => ({ ...tab, loaded: false }));
    tabsRef.current = restoredTabs;
    setTabs(restoredTabs);
    const targetId = session.activeId || restoredTabs[0].id;
    const target = restoredTabs.find((tab) => tab.id === targetId) || restoredTabs[0];
    void openFile(target, { tabId: target.id });
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
    let fileChangeTimerId = null;
    let fileChangePending = false;
    let stopFileWatching = null;
    let active = true;

    const refreshIsBlocked = () => (
      pollInFlightRef.current ||
      pickerActiveRef.current ||
      transitionPromptRef.current ||
      conflictRef.current ||
      recoveryRef.current ||
      serverRecoveryRef.current
    );

    const scheduleFileChangeRefresh = (delay = FILE_CHANGE_REFRESH_DELAY_MS) => {
      fileChangePending = true;
      if (fileChangeTimerId !== null || !active) return;
      fileChangeTimerId = window.setTimeout(async () => {
        fileChangeTimerId = null;
        if (!active) return;
        if (document.visibilityState === 'hidden') return;
        if (refreshIsBlocked()) {
          scheduleFileChangeRefresh(FILE_CHANGE_BLOCKED_RETRY_MS);
          return;
        }
        fileChangePending = false;
        await runRefreshCycle({ forceWorkspaces: true });
        if (fileChangePending) scheduleFileChangeRefresh();
      }, delay);
    };

    const handleNativeFileChange = () => {
      const selected = currentRef.current;
      if (selected?.path) {
        // 原生事件不携带私有路径。即使单文件授权无法查询父目录状态，也要让图片 URL
        // 立即失效，避免 WebView2 继续复用变更前的本地资源。
        const resourceRevision = `file-event:${++resourceRevisionRef.current}`;
        currentRef.current = { ...selected, resourceRevision };
        setCurrent((previous) => (
          previous?.path === selected.path
            ? { ...previous, resourceRevision }
            : previous
        ));
      }
      scheduleFileChangeRefresh();
    };

    const scheduleFocusRefresh = () => {
      if (document.visibilityState === 'hidden' || pickerActiveRef.current) return;
      if (focusTimerId !== null) window.clearTimeout(focusTimerId);
      focusTimerId = window.setTimeout(() => {
        focusTimerId = null;
        fileChangePending = false;
        void runRefreshCycle({ forceWorkspaces: true }).finally(() => {
          if (fileChangePending) scheduleFileChangeRefresh();
        });
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
    if (env.capabilities?.fileWatching === true) {
      void api.subscribeFileChanges(handleNativeFileChange).then((unsubscribe) => {
        if (!active) {
          void Promise.resolve(unsubscribe?.()).catch(() => {});
          return;
        }
        stopFileWatching = unsubscribe;
      }).catch((err) => {
        if (active) setError(err.message);
      });
    } else {
      schedulePoll();
    }
    return () => {
      active = false;
      window.removeEventListener('focus', scheduleFocusRefresh);
      document.removeEventListener('visibilitychange', scheduleFocusRefresh);
      void Promise.resolve(stopFileWatching?.()).catch(() => {});
      if (focusTimerId !== null) window.clearTimeout(focusTimerId);
      if (pollTimerId !== null) window.clearTimeout(pollTimerId);
      if (fileChangeTimerId !== null) window.clearTimeout(fileChangeTimerId);
    };
  }, [env, runRefreshCycle]);

  useEffect(
    () => () => {
      if (transitionPromptRef.current) {
        transitionPromptRef.current.resolve(false);
        transitionPromptRef.current = null;
      }
      documentRequestSeqRef.current += 1;
      searchRequestSeqRef.current += 1;
      recentHydrationSeqRef.current += 1;
      documentOpenAbortRef.current?.abort();
      documentOpenAbortRef.current = null;
      documentPollAbortRef.current?.abort();
      documentPollAbortRef.current = null;
      recentHydrationAbortRef.current?.abort();
      recentHydrationAbortRef.current = null;
      serverRecoveryAbortRef.current?.abort();
      serverRecoveryAbortRef.current = null;
      for (const workspace of workspacesRef.current) nextWorkspaceRequest(workspace.path);
    },
    [nextWorkspaceRequest],
  );

  const onOpenRecent = useCallback((item) => {
    void openFileWithGuard(item);
  }, [openFileWithGuard]);

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
    recentHydrationAbortRef.current?.abort();
    recentHydrationAbortRef.current = null;
    deferredRecentsRef.current = [];
    removedRecentIdentitiesRef.current.clear();
    storeRecents(() => []);
  }, [storeRecents]);

  const rendersPreview = viewMode !== 'edit';
  const markdownSnapshot = useMemo(
    () => (
      rendersPreview && typeof previewContent === 'string'
        ? createMarkdownSnapshot(previewContent)
        : null
    ),
    [previewContent, rendersPreview],
  );
  const toc = markdownSnapshot?.toc || [];
  const hasDocument = current !== null && (content !== null || draft !== null);
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
          {isDirty ? ' •' : ''}
        </h1>
        <div className="app-header-actions">
          {hasDocument && (
            <>
              <div className="view-mode-control" role="group" aria-label="文稿视图">
                {['preview', 'edit', 'split'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={viewMode === mode ? 'is-active' : undefined}
                    aria-pressed={viewMode === mode}
                    disabled={mode !== 'preview' && current?.writable === false}
                    onClick={() => setViewMode(mode)}
                  >
                    {mode === 'edit' && current?.writable === false
                      ? '只读'
                      : { preview: '预览', edit: '编辑', split: '分栏' }[mode]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-pressed={findOpen}
                title="文档内查找（⌘/Ctrl+F）"
                onClick={() => setFindOpen((value) => !value)}
              >
                查找
              </button>
              <button
                type="button"
                className={isDirty ? 'primary-btn' : undefined}
                onClick={() => void saveCurrent()}
                disabled={!isDirty || saving || current?.writable === false || !safeSaveAvailable}
                title={safeSaveAvailable ? '保存（⌘/Ctrl+S）' : '当前平台尚未启用安全保存'}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          )}
          {env?.openApiAvailable && (
            <button
              type="button"
              className={!hasDocument && workspaces.length === 0 ? 'primary-btn' : undefined}
              onClick={onOpenStandaloneFile}
              disabled={pickingFile || pickingFolder}
              title={sessionScopedAuthorization
                ? '选择一个 Markdown 文件并授权本次会话访问'
                : '直接选择一个已在应用设置中授权的 Markdown 文件'}
            >
              {pickingFile ? '选择中…' : '打开文件'}
            </button>
          )}
          {!isFileLaunch && env?.openApiAvailable && (
            <button
              type="button"
              onClick={onOpenFolder}
              disabled={pickingFolder || pickingFile}
              title={sessionScopedAuthorization
                ? `选择文件夹并授权本次会话访问（最多 ${MAX_WORKSPACES} 个工作区）`
                : `选择已授权文件夹（最多 ${MAX_WORKSPACES} 个工作区）`}
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

      <DocumentTabs
        tabs={tabs}
        activeId={activeTabId}
        disabled={saving || Boolean(conflict || recovery || serverRecovery || transitionPrompt)}
        onActivate={(tabId) => void activateTab(tabId)}
        onClose={(tabId) => void closeTab(tabId)}
      />

      {hasDocument && findOpen && (
        <DocumentFindBar
          query={findQuery}
          replacement={replaceQuery}
          replaceVisible={replaceOpen}
          caseSensitive={findCaseSensitive}
          currentIndex={activeFindMatch}
          matchCount={viewMode === 'preview' ? previewFindMatchCount : findMatches.length}
          canReplace={current?.writable !== false}
          onQueryChange={(value) => {
            setFindQuery(value);
            setActiveFindMatch(0);
          }}
          onReplacementChange={setReplaceQuery}
          onToggleReplace={() => {
            setReplaceOpen((value) => {
              const next = !value;
              if (next && viewMode === 'preview' && current?.writable !== false) {
                setViewMode('edit');
              }
              return next;
            });
          }}
          onToggleCase={() => setFindCaseSensitive((value) => !value)}
          onPrevious={() => navigateFind(-1)}
          onNext={() => navigateFind(1)}
          onReplace={replaceCurrentMatch}
          onReplaceAll={replaceAllMatches}
          onClose={() => setFindOpen(false)}
        />
      )}

      <div className="app-body">
        {showSidebar && (
          <aside className="app-sidebar">
            <WorkspaceSidebar
              workspaces={workspaces}
              currentPath={current?.actualPath || current?.path}
              refreshingPaths={refreshingPaths}
              onOpenFile={openFileWithGuard}
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

        <main className={`app-main${viewMode === 'split' ? ' is-split' : ''}`}>
          {error && (
            <div className="notice notice-error">
              <strong>提示：</strong>
              {error}
            </div>
          )}

          {loading && <div className="notice">加载中…</div>}

          {hasDocument && saveNotice && !error && (
            <div className="save-status" role="status">{saveNotice}</div>
          )}

          {hasDocument && current?.writable === false && !error && (
            <div className="notice" role="status">
              {sessionScopedAuthorization
                ? '当前文稿只读。如需编辑，请在 Windows 文件属性或安全设置中授予写入权限。'
                : (
                  <>当前文稿只读。如需编辑，请在 fnOS「系统设置 → 应用 → Flux Reader →
                    访问权限」中将目录调整为读写。</>
                )}
            </div>
          )}

          {hasDocument && !safeSaveAvailable && !error && current?.writable !== false && (
            <div className="notice" role="status">
              当前平台尚未启用安全保存；可以阅读和编辑，修改会进入现有恢复草稿，
              但暂不能提交到原文件。
            </div>
          )}

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

          {hasDocument && viewMode === 'preview' && (
            <MarkdownView
              content={previewContent}
              snapshot={markdownSnapshot}
              theme={theme}
              resolveImageSource={current?.path ? resolveImageSource : undefined}
              findQuery={findOpen ? findQuery : ''}
              findCaseSensitive={findCaseSensitive}
              activeFindMatch={activeFindMatch}
              onFindMatchCountChange={setPreviewFindMatchCount}
            />
          )}

          {hasDocument && viewMode === 'edit' && (
            <textarea
              ref={editorRef}
              className="markdown-editor"
              aria-label="Markdown 编辑器"
              value={draft ?? ''}
              readOnly={current?.writable === false}
              onChange={(event) => commitDraftChange(event.target.value)}
              spellCheck="false"
              autoCapitalize="off"
              autoCorrect="off"
            />
          )}

          {hasDocument && viewMode === 'split' && (
            <div className="document-split" aria-label="编辑与预览分栏">
              <section className="document-split-pane editor-pane" aria-label="编辑器面板">
                <textarea
                  ref={(node) => {
                    editorRef.current = node;
                    editorPaneRef.current = node;
                  }}
                  className="markdown-editor split-editor"
                  aria-label="Markdown 编辑器"
                  value={draft ?? ''}
                  readOnly={current?.writable === false}
                  onChange={(event) => commitDraftChange(event.target.value)}
                  onScroll={(event) => syncDocumentScroll(
                    event.currentTarget,
                    previewPaneRef.current,
                  )}
                  spellCheck="false"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </section>
              <section
                ref={previewPaneRef}
                className="document-split-pane preview-pane"
                aria-label="预览面板"
                onScroll={(event) => syncDocumentScroll(
                  event.currentTarget,
                  editorPaneRef.current,
                )}
              >
                <MarkdownView
                  content={previewContent}
                  snapshot={markdownSnapshot}
                  theme={theme}
                  resolveImageSource={current?.path ? resolveImageSource : undefined}
                  findQuery={findOpen ? findQuery : ''}
                  findCaseSensitive={findCaseSensitive}
                  activeFindMatch={activeFindMatch}
                  onFindMatchCountChange={setPreviewFindMatchCount}
                />
              </section>
            </div>
          )}
        </main>

        {hasDocument && viewMode !== 'edit' && toc.length > 1 && (
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

      <DecisionDialog
        // A save requested by this dialog can discover a disk conflict. Keep
        // the pending transition, but show exactly one modal until the user
        // resolves that conflict. Keeping the draft reveals this dialog again;
        // reloading the disk version completes the pending transition.
        prompt={conflict || recovery || serverRecovery ? null : transitionPrompt}
        saving={saving}
        error={error}
        onSave={saveBeforeTransition}
        onDiscard={discardBeforeTransition}
        onCancel={cancelTransition}
      />
      <ConflictDialog
        conflict={serverRecovery ? null : conflict}
        onReload={reloadConflictFromDisk}
        onKeep={keepConflictDraft}
      />
      <RecoveryDialog
        recovery={serverRecovery || conflict ? null : recovery}
        onUseDisk={useDiskRecovery}
        onRestore={restoreRecoveryDraft}
      />
      <ServerRecoveryDialog
        recovery={serverRecovery}
        busy={serverRecoveryBusy}
        error={serverRecoveryError}
        onDiscard={discardServerRecovery}
        onRestore={restoreServerRecovery}
      />
    </div>
  );
}
