export const DEFAULT_RENDER_PAYLOAD = Object.freeze({
  generation: '',
  content: '',
  title: 'Flux Reader',
  theme: 'light',
  resourceToken: '',
  findQuery: '',
  findCaseSensitive: false,
  activeFindMatch: 0,
});

const LOCAL_RESOURCE_SCHEME = 'flux-reader-resource';

export function resolveMacOSImageSource(source, resourceToken = '') {
  const src = String(source || '').trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) return null;

  const token = encodeURIComponent(String(resourceToken || 'document'));
  return `${LOCAL_RESOURCE_SCHEME}://image/${token}?path=${encodeURIComponent(src)}`;
}

export function normalizeRenderPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_RENDER_PAYLOAD };
  }

  return {
    generation:
      typeof value.generation === 'string' ? value.generation.slice(0, 128) : '',
    content: typeof value.content === 'string' ? value.content : '',
    title:
      typeof value.title === 'string' && value.title.trim()
        ? value.title
        : DEFAULT_RENDER_PAYLOAD.title,
    theme: value.theme === 'dark' ? 'dark' : 'light',
    resourceToken:
      typeof value.resourceToken === 'string' ? value.resourceToken.slice(0, 128) : '',
    findQuery: typeof value.findQuery === 'string' ? value.findQuery.slice(0, 4_096) : '',
    findCaseSensitive: value.findCaseSensitive === true,
    activeFindMatch: Number.isSafeInteger(value.activeFindMatch) && value.activeFindMatch >= 0
      ? value.activeFindMatch
      : 0,
  };
}
