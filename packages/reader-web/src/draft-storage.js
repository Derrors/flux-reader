import { MAX_EDITABLE_DOCUMENT_BYTES } from './limits';

const DRAFT_STORAGE_PREFIX = 'flux-reader:draft:v1';
// JavaScript 字符数不会大于同一内容的 UTF-8 字节数，因此这个上限能容纳
// 所有满足可编辑文稿字节限制的草稿，同时避免异常存储值无限膨胀。
export const MAX_DRAFT_CHARACTERS = MAX_EDITABLE_DOCUMENT_BYTES;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function draftStorageKey(uid, actualPath) {
  if (uid == null || typeof actualPath !== 'string' || !actualPath.startsWith('/')) return null;
  return `${DRAFT_STORAGE_PREFIX}:${encodeURIComponent(String(uid))}:${encodeURIComponent(actualPath)}`;
}

export function readDraft(uid, actualPath) {
  const key = draftStorageKey(uid, actualPath);
  if (!key) return null;
  try {
    const parsed = JSON.parse(storage()?.getItem(key) || 'null');
    if (
      !parsed ||
      parsed.actualPath !== actualPath ||
      typeof parsed.content !== 'string' ||
      parsed.content.length > MAX_DRAFT_CHARACTERS ||
      typeof parsed.updatedAt !== 'number'
    ) return null;
    return {
      actualPath,
      content: parsed.content,
      sourceRevision: parsed.sourceRevision ?? null,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeDraft(uid, actualPath, content, sourceRevision) {
  const key = draftStorageKey(uid, actualPath);
  if (!key || typeof content !== 'string' || content.length > MAX_DRAFT_CHARACTERS) return false;
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(key, JSON.stringify({
      actualPath,
      content,
      sourceRevision: sourceRevision ?? null,
      updatedAt: Date.now(),
    }));
    return true;
  } catch {
    return false;
  }
}

export function removeDraft(uid, actualPath) {
  const key = draftStorageKey(uid, actualPath);
  if (!key) return;
  try {
    storage()?.removeItem(key);
  } catch {
    // Draft cleanup is best effort. A storage failure must not break saving.
  }
}
