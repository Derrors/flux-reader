const DEFAULTS = Object.freeze({
  viewportHighlighting: true,
  highlightCache: true,
  contentVisibility: true,
});

function parseBuildFlag(value, fallback) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

export function resolveRenderFeatureFlags({
  overrides = globalThis.__FLUX_READER_FEATURES__,
  env = import.meta.env,
  css = globalThis.CSS,
} = {}) {
  const configured = {
    viewportHighlighting: parseBuildFlag(
      env?.VITE_FLUX_VIEWPORT_HIGHLIGHTING,
      DEFAULTS.viewportHighlighting,
    ),
    highlightCache: parseBuildFlag(
      env?.VITE_FLUX_HIGHLIGHT_CACHE,
      DEFAULTS.highlightCache,
    ),
    contentVisibility: parseBuildFlag(
      env?.VITE_FLUX_CONTENT_VISIBILITY,
      DEFAULTS.contentVisibility,
    ),
  };

  for (const key of Object.keys(DEFAULTS)) {
    if (typeof overrides?.[key] === 'boolean') configured[key] = overrides[key];
  }

  configured.contentVisibility = Boolean(
    configured.contentVisibility
      && css?.supports?.('content-visibility', 'auto'),
  );
  return Object.freeze(configured);
}

export const RENDER_FEATURES = resolveRenderFeatureFlags();

export function applyRenderFeatureFlags(root = globalThis.document?.documentElement) {
  if (!root) return;
  root.dataset.contentVisibility = RENDER_FEATURES.contentVisibility
    ? 'enabled'
    : 'disabled';
}
