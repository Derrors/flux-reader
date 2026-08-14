const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyChangedFiles } = require('../affected-projects');

function flags(result) {
  return {
    fnos: result.fnos,
    macos: result.macos,
    windows: result.windows,
  };
}

test('fans shared renderer and safe-save contract changes out to all consumers', () => {
  assert.deepEqual(flags(classifyChangedFiles(['packages/reader-web/src/markdown/pipeline.js'])), {
    fnos: true,
    macos: true,
    windows: true,
  });
  assert.deepEqual(flags(classifyChangedFiles(['contracts/safe-save/v1/scenarios.json'])), {
    fnos: true,
    macos: true,
    windows: true,
  });
});

test('keeps platform application and version changes isolated', () => {
  assert.deepEqual(flags(classifyChangedFiles(['apps/macos/FluxReader/App/FluxReaderApp.swift'])), {
    fnos: false,
    macos: true,
    windows: false,
  });
  assert.deepEqual(flags(classifyChangedFiles(['versions/windows'])), {
    fnos: false,
    macos: false,
    windows: true,
  });
});

test('does not spend platform CI on documentation-only changes', () => {
  assert.deepEqual(flags(classifyChangedFiles(['README.md', 'docs/TECHNICAL.md'])), {
    fnos: false,
    macos: false,
    windows: false,
  });
});

test('fails safe for manual, empty, or unknown project changes', () => {
  for (const files of [[], ['tools/new-build-system.js']]) {
    assert.deepEqual(flags(classifyChangedFiles(files)), {
      fnos: true,
      macos: true,
      windows: true,
    });
  }
});
