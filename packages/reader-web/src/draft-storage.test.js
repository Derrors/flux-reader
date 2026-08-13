import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DRAFT_CHARACTERS,
  draftStorageKey,
  readDraft,
  removeDraft,
  writeDraft,
} from './draft-storage';

beforeEach(() => {
  const values = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    },
  });
});

describe('Web App 崩溃恢复草稿', () => {
  it('按 uid 与后端规范路径隔离，并保留来源 revision', () => {
    const revision = 'a'.repeat(64);
    expect(writeDraft('1000', '/volume/docs/a.md', '# 草稿', revision)).toBe(true);

    expect(readDraft('1000', '/volume/docs/a.md')).toMatchObject({
      actualPath: '/volume/docs/a.md',
      content: '# 草稿',
      sourceRevision: revision,
    });
    expect(readDraft('2000', '/volume/docs/a.md')).toBeNull();
    expect(readDraft('1000', '/share/alias.md')).toBeNull();
    expect(draftStorageKey('1000', '/volume/docs/a.md')).not.toBe(
      draftStorageKey('2000', '/volume/docs/a.md'),
    );
  });

  it('成功保存或放弃修改后可删除对应草稿', () => {
    writeDraft('1000', '/volume/docs/a.md', 'draft', 'a'.repeat(64));
    removeDraft('1000', '/volume/docs/a.md');
    expect(readDraft('1000', '/volume/docs/a.md')).toBeNull();
  });

  it('Windows 规范路径使用独立且可恢复的草稿键', () => {
    const path = 'C:/Users/Alice/Notes/a.md';
    expect(writeDraft('windows-local', path, 'draft', 'b'.repeat(64))).toBe(true);
    expect(readDraft('windows-local', path)).toMatchObject({
      actualPath: path,
      content: 'draft',
    });
    expect(draftStorageKey('windows-local', path)).not.toBeNull();
  });

  it('忽略损坏、路径不匹配或超过阅读上限的存储值', () => {
    const key = draftStorageKey('1000', '/volume/docs/a.md');
    window.localStorage.setItem(key, '{bad json');
    expect(readDraft('1000', '/volume/docs/a.md')).toBeNull();

    window.localStorage.setItem(key, JSON.stringify({
      actualPath: '/volume/docs/b.md', content: 'x', updatedAt: Date.now(),
    }));
    expect(readDraft('1000', '/volume/docs/a.md')).toBeNull();

    window.localStorage.setItem(key, JSON.stringify({
      actualPath: '/volume/docs/a.md',
      content: 'x'.repeat(MAX_DRAFT_CHARACTERS + 1),
      updatedAt: Date.now(),
    }));
    expect(readDraft('1000', '/volume/docs/a.md')).toBeNull();
  });
});
