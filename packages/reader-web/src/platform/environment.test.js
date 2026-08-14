import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRODUCT_POLICY,
  ENVIRONMENT_SCHEMA_VERSION,
  normalizeEnvironment,
  normalizeProductPolicy,
} from './environment';

describe('platform environment contract', () => {
  it('fills platform capabilities without overriding explicit host values', () => {
    expect(normalizeEnvironment({}, 'fnos')).toMatchObject({
      platform: 'fnos',
      capabilitySchemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      capabilities: {
        sessionScopedAuthorization: false,
        safeSave: true,
        fileWatching: false,
      },
    });
    expect(normalizeEnvironment({
      platform: 'windows',
      capabilities: { safeSave: false },
    })).toMatchObject({
      platform: 'windows',
      capabilities: {
        sessionScopedAuthorization: true,
        fileWatching: true,
        safeSave: false,
      },
    });
  });

  it('accepts bounded platform policy and rejects unreasonable values', () => {
    expect(normalizeProductPolicy({
      maxEditableDocumentBytes: 20 * 1024 * 1024,
      maxWorkspaces: 12,
      maxDocumentTabs: 20,
    })).toMatchObject({
      maxEditableDocumentBytes: 20 * 1024 * 1024,
      maxWorkspaces: 12,
      maxDocumentTabs: 20,
    });
    expect(normalizeProductPolicy({
      maxEditableDocumentBytes: Number.MAX_SAFE_INTEGER,
      maxWorkspaces: 0,
      maxDocumentTabs: 999,
    })).toEqual(DEFAULT_PRODUCT_POLICY);
  });
});
