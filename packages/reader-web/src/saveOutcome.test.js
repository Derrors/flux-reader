import { describe, expect, it } from 'vitest';
import {
  isSaveConflict,
  requiresSaveRecovery,
  saveFailureOutcome,
} from './saveOutcome';

describe('safe save outcome compatibility', () => {
  it('prefers the shared structured outcome over HTTP status and error code', () => {
    const error = {
      status: 500,
      code: 'SAVE_FAILED',
      details: {
        saveOutcome: {
          contractVersion: 1,
          kind: 'rejected',
          reason: 'conflict',
        },
      },
    };
    expect(isSaveConflict(error)).toBe(true);
    expect(requiresSaveRecovery(error)).toBe(false);
  });

  it('recognizes recoveryRequired without inspecting an error message', () => {
    const error = {
      details: {
        saveOutcome: {
          contractVersion: 1,
          kind: 'recoveryRequired',
          commitState: 'unknown',
          recoveryReferences: [],
        },
      },
    };
    expect(requiresSaveRecovery(error)).toBe(true);
  });

  it('keeps legacy backends compatible while ignoring malformed outcomes', () => {
    expect(isSaveConflict({ status: 409, code: 'FILE_CONFLICT' })).toBe(true);
    expect(requiresSaveRecovery({ details: { recoveryRequired: true } })).toBe(true);
    expect(saveFailureOutcome({ details: { saveOutcome: { kind: 'rejected' } } })).toBeNull();
  });
});
