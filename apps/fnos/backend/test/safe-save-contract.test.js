const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONTRACT_VERSION,
  REJECTION_REASONS,
  classifySaveError,
  committedSaveOutcome,
  failedSaveOutcome,
} = require('../src/safe-save-contract');

const contractRoot = path.resolve(__dirname, '../../../../contracts/safe-save/v1');
const schema = JSON.parse(fs.readFileSync(path.join(contractRoot, 'schema.json'), 'utf8'));
const corpus = JSON.parse(fs.readFileSync(path.join(contractRoot, 'scenarios.json'), 'utf8'));

function outcomeForSignal(signal) {
  if (signal === 'COMMITTED') {
    return committedSaveOutcome({ content: '# saved', size: 7, revision: 'a'.repeat(64) }, {
      locator: '/authorized/notes.md',
    });
  }
  const error = new Error(signal);
  error.reason = signal;
  if (signal === 'SAVE_RECOVERY_REQUIRED') {
    error.recoveryRequired = true;
    error.recovery = {
      recoveryId: 'b'.repeat(48),
      phase: 'recovery-required',
    };
  }
  return failedSaveOutcome(error);
}

test('adapter rejection reasons stay exhaustive with the shared schema', () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.deepEqual(
    [...REJECTION_REASONS].sort(),
    [...schema.$defs.rejectionReason.enum].sort(),
  );
});

test('fnOS adapter maps every shared scenario to its contract outcome', () => {
  assert.equal(corpus.contractVersion, CONTRACT_VERSION);
  assert.equal(new Set(corpus.scenarios.map(({ id }) => id)).size, corpus.scenarios.length);

  for (const scenario of corpus.scenarios) {
    const outcome = outcomeForSignal(scenario.platformSignals.fnos);
    assert.equal(outcome.kind, scenario.expected.kind, scenario.id);
    if (scenario.expected.reason) {
      assert.equal(outcome.reason, scenario.expected.reason, scenario.id);
    }
    if (scenario.expected.commitState) {
      assert.equal(outcome.commitState, scenario.expected.commitState, scenario.id);
    }
  }
});

test('known fnOS errors map without status or message inspection', () => {
  const cases = [
    ['FILE_CONFLICT', 'conflict'],
    ['PATH_CHANGED_DURING_SAVE', 'conflict'],
    ['USER_ACL_WRITE_DENIED', 'permission'],
    ['STORAGE_WRITE_DENIED', 'permission'],
    ['SYMLINK_SAVE_DENIED', 'invalidTarget'],
    ['FILE_TOO_LARGE', 'tooLarge'],
    ['INVALID_UTF8', 'invalidUTF8'],
    ['RECOVERY_QUOTA_EXCEEDED', 'resourceExhausted'],
    ['STORAGE_WRITE_UNAVAILABLE', 'unavailable'],
    ['UNCLASSIFIED_FAILURE', 'internal'],
  ];
  for (const [reason, expected] of cases) {
    assert.equal(classifySaveError({ reason }), expected, reason);
  }
  assert.equal(classifySaveError({ name: 'AbortError' }), 'cancelled');
});

test('recovery outcome exposes only an opaque reference', () => {
  const error = Object.assign(new Error('recovery'), {
    reason: 'SAVE_RECOVERY_REQUIRED',
    recoveryRequired: true,
    currentRevision: 'c'.repeat(64),
    recovery: {
      recoveryId: 'd'.repeat(48),
      phase: 'recovery-required',
      previousVersion: '/private/secret/baseline.bin',
    },
  });
  const outcome = failedSaveOutcome(error);
  assert.deepEqual(outcome, {
    contractVersion: 1,
    kind: 'recoveryRequired',
    commitState: 'unknown',
    recoveryReferences: [{
      kind: 'privateJournal',
      reference: 'd'.repeat(48),
      phase: 'recovery-required',
    }],
    currentVersion: 'c'.repeat(64),
  });
  assert.doesNotMatch(JSON.stringify(outcome), /private\/secret/u);
});
