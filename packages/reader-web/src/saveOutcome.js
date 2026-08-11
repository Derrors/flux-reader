const OUTCOME_KINDS = new Set(['committed', 'rejected', 'recoveryRequired']);

/**
 * Read the v1 safe-save result without coupling UI branches to platform error
 * names. Legacy fields remain as a temporary compatibility projection for
 * older fnOS backends during rolling upgrades.
 */
export function saveFailureOutcome(error) {
  const outcome = error?.details?.saveOutcome;
  if (
    outcome?.contractVersion === 1
    && OUTCOME_KINDS.has(outcome.kind)
  ) {
    return outcome;
  }
  if (error?.details?.recoveryRequired || error?.details?.recovery?.recoveryId) {
    return {
      contractVersion: 1,
      kind: 'recoveryRequired',
      commitState: 'unknown',
      recoveryReferences: [],
    };
  }
  if (error?.status === 409 && error?.code === 'FILE_CONFLICT') {
    return {
      contractVersion: 1,
      kind: 'rejected',
      reason: 'conflict',
    };
  }
  return null;
}

export function requiresSaveRecovery(error) {
  return saveFailureOutcome(error)?.kind === 'recoveryRequired';
}

export function isSaveConflict(error) {
  const outcome = saveFailureOutcome(error);
  return outcome?.kind === 'rejected' && outcome.reason === 'conflict';
}
