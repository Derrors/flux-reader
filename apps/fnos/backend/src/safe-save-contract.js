const CONTRACT_VERSION = 1;

const REJECTION_REASONS = Object.freeze([
  'conflict',
  'permission',
  'invalidTarget',
  'tooLarge',
  'invalidUTF8',
  'resourceExhausted',
  'unavailable',
  'cancelled',
  'internal',
]);

const CONFLICT_REASONS = new Set([
  'FILE_CONFLICT',
  'FILE_CHANGED_DURING_SAVE',
  'PATH_CHANGED_DURING_AUTHORIZATION',
  'PATH_CHANGED_DURING_OPEN',
  'PATH_CHANGED_DURING_SAVE',
  'OPENED_FD_RESOLUTION_FAILED',
  'SHARED_AUTHORIZATION_CHANGED',
  'RECOVERY_TARGET_CHANGED',
  'RECOVERY_IN_PROGRESS',
]);

const PERMISSION_REASONS = new Set([
  'USER_ACL_WRITE_DENIED',
  'USER_ACL_DENIED',
  'NO_AUTHORIZED_PATH',
  'PATH_NOT_AUTHORIZED',
  'PATH_OPEN_DENIED',
  'STORAGE_WRITE_DENIED',
]);

const INVALID_TARGET_REASONS = new Set([
  'INVALID_PATH',
  'INVALID_TARGET_TYPE',
  'INVALID_CONTENT',
  'INVALID_EXPECTED_REVISION',
  'INVALID_RECOVERY_ID',
  'INVALID_RECOVERY_VERSION',
  'PATH_NOT_FOUND',
  'RECOVERY_NOT_FOUND',
  'SYMLINK_SAVE_DENIED',
  'UNSUPPORTED_DOCUMENT_TYPE',
]);

const RESOURCE_EXHAUSTED_REASONS = new Set([
  'RECOVERY_BASELINE_TOO_LARGE',
  'RECOVERY_QUOTA_EXCEEDED',
  'STORAGE_FULL',
]);

const UNAVAILABLE_REASONS = new Set([
  'PATH_OPEN_FAILED',
  'PATH_OPEN_UNAVAILABLE',
  'PRECISE_FILE_STATE_UNAVAILABLE',
  'RECOVERY_STORAGE_UNAVAILABLE',
  'SECURE_FD_ACL_UNAVAILABLE',
  'SECURE_FD_PATH_UNAVAILABLE',
  'SHARED_AUTHORIZATION_FAILED',
  'STORAGE_WRITE_UNAVAILABLE',
]);

function validVersion(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validRecoveryId(value) {
  return typeof value === 'string' && /^[a-f0-9]{48}$/u.test(value)
    ? value
    : null;
}

function classifySaveError(error) {
  const reason = typeof error?.reason === 'string' ? error.reason : '';
  if (error?.name === 'AbortError') return 'cancelled';
  if (reason === 'FILE_TOO_LARGE') return 'tooLarge';
  if (reason === 'INVALID_UTF8') return 'invalidUTF8';
  if (CONFLICT_REASONS.has(reason)) return 'conflict';
  if (PERMISSION_REASONS.has(reason)) return 'permission';
  if (INVALID_TARGET_REASONS.has(reason)) return 'invalidTarget';
  if (RESOURCE_EXHAUSTED_REASONS.has(reason)) return 'resourceExhausted';
  if (UNAVAILABLE_REASONS.has(reason)) return 'unavailable';

  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'permission';
  if (['ENOSPC', 'EDQUOT'].includes(error?.code)) return 'resourceExhausted';
  if (['EMFILE', 'ENFILE', 'ENOMEM', 'ESTALE', 'EBUSY', 'ETIMEDOUT'].includes(error?.code)) {
    return 'unavailable';
  }
  return 'internal';
}

function recoveryReferences(error, publicRecovery) {
  const recovery = publicRecovery ?? error?.recovery;
  const recoveryId = validRecoveryId(recovery?.recoveryId);
  if (!recoveryId) return [];
  return [{
    kind: 'privateJournal',
    reference: recoveryId,
    ...(typeof recovery.phase === 'string' && recovery.phase
      ? { phase: recovery.phase }
      : {}),
  }];
}

function committedSaveOutcome(result, { locator, includeContent = false } = {}) {
  const content = typeof result?.content === 'string' ? result.content : null;
  const byteCount = Number.isSafeInteger(result?.size) && result.size >= 0
    ? result.size
    : Buffer.byteLength(content ?? '', 'utf8');
  // A committed save must never be turned into an HTTP failure merely because
  // an adapter cannot read optional metadata. Production writes always return
  // revision; this fallback keeps the already-committed result honest.
  const version = validVersion(result?.revision)
    ?? `committed:${String(result?.mtime ?? 'unknown')}:${byteCount}`;
  const recovery = result?.recoveryCleanupPending
    ? [{ kind: 'cleanupPending', reference: 'fnos-private-journal-cleanup' }]
    : [];
  const snapshot = {
    locator: typeof locator === 'string' && locator ? locator : 'authorized-document',
    version,
    contentIncluded: Boolean(includeContent && content !== null),
    byteCount,
    capabilities: {
      readable: true,
      writable: result?.writable !== false,
      supportsCreate: false,
      supportsSaveAs: false,
    },
    implementationSemantics: {
      writeVisibility: 'recoverableInPlace',
      recoveryLocation: 'private',
    },
  };
  if (includeContent && content !== null) snapshot.content = content;
  return {
    contractVersion: CONTRACT_VERSION,
    kind: 'committed',
    snapshot,
    recoveryReferences: recovery,
  };
}

function failedSaveOutcome(error, { publicRecovery } = {}) {
  const currentVersion = validVersion(error?.currentRevision);
  if (error?.recoveryRequired || error?.reason === 'SAVE_RECOVERY_REQUIRED') {
    const phase = publicRecovery?.phase ?? error?.recovery?.phase;
    const commitState = phase === 'committed'
      ? 'committed'
      : phase === 'prepared'
        ? 'notCommitted'
        : 'unknown';
    return {
      contractVersion: CONTRACT_VERSION,
      kind: 'recoveryRequired',
      commitState,
      recoveryReferences: recoveryReferences(error, publicRecovery),
      ...(currentVersion ? { currentVersion } : {}),
    };
  }
  return {
    contractVersion: CONTRACT_VERSION,
    kind: 'rejected',
    reason: classifySaveError(error),
    ...(currentVersion ? { currentVersion } : {}),
  };
}

module.exports = {
  CONTRACT_VERSION,
  REJECTION_REASONS,
  classifySaveError,
  committedSaveOutcome,
  failedSaveOutcome,
};
