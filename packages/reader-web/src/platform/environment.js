import {
  MAX_EDITABLE_DOCUMENT_BYTES,
} from '../limits';
import { MAX_DOCUMENT_TABS } from '../document-session';

export const ENVIRONMENT_SCHEMA_VERSION = 1;

export const DEFAULT_PRODUCT_POLICY = Object.freeze({
  maxEditableDocumentBytes: MAX_EDITABLE_DOCUMENT_BYTES,
  maxLocalImageBytes: 25 * 1024 * 1024,
  maxWorkspaces: 8,
  maxDocumentTabs: MAX_DOCUMENT_TABS,
});

const PLATFORM_CAPABILITIES = Object.freeze({
  fnos: Object.freeze({
    nativeDialog: true,
    sessionScopedAuthorization: false,
    requestCancellation: true,
    workspaceSearch: true,
    safeSave: true,
    recovery: true,
    localResources: true,
    fileWatching: false,
  }),
  windows: Object.freeze({
    nativeDialog: true,
    sessionScopedAuthorization: true,
    requestCancellation: true,
    workspaceSearch: true,
    safeSave: true,
    recovery: true,
    localResources: true,
    fileWatching: true,
  }),
});

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function normalizeProductPolicy(value) {
  const policy = value && typeof value === 'object' ? value : {};
  return Object.freeze({
    maxEditableDocumentBytes: boundedInteger(
      policy.maxEditableDocumentBytes,
      DEFAULT_PRODUCT_POLICY.maxEditableDocumentBytes,
      1024,
      64 * 1024 * 1024,
    ),
    maxLocalImageBytes: boundedInteger(
      policy.maxLocalImageBytes,
      DEFAULT_PRODUCT_POLICY.maxLocalImageBytes,
      1024,
      256 * 1024 * 1024,
    ),
    maxWorkspaces: boundedInteger(
      policy.maxWorkspaces,
      DEFAULT_PRODUCT_POLICY.maxWorkspaces,
      1,
      32,
    ),
    maxDocumentTabs: boundedInteger(
      policy.maxDocumentTabs,
      DEFAULT_PRODUCT_POLICY.maxDocumentTabs,
      1,
      64,
    ),
  });
}

export function normalizeEnvironment(value, fallbackPlatform = 'fnos') {
  const source = value && typeof value === 'object' ? value : {};
  const platform = source.platform === 'windows' || source.platform === 'fnos'
    ? source.platform
    : fallbackPlatform;
  const defaults = PLATFORM_CAPABILITIES[platform] || PLATFORM_CAPABILITIES.fnos;
  return Object.freeze({
    ...source,
    platform,
    capabilitySchemaVersion: ENVIRONMENT_SCHEMA_VERSION,
    capabilities: Object.freeze({
      ...defaults,
      ...(source.capabilities && typeof source.capabilities === 'object'
        ? source.capabilities
        : {}),
    }),
    policy: normalizeProductPolicy(source.policy),
  });
}
