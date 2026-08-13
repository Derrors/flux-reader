import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DOCUMENT_TABS,
  documentSessionStorageKey,
  readDocumentSession,
  writeDocumentSession,
} from './document-session';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    values,
  };
}

describe('文稿标签会话持久化', () => {
  it('按 uid 隔离且只保存惰性元数据，不保存正文', () => {
    const storage = memoryStorage();
    const tabs = [{
      id: '/share/a.md',
      path: '/share/a.md',
      actualPath: '/real/a.md',
      name: 'a.md',
      displayPath: '/share/a.md',
      content: 'secret body',
      draft: 'secret draft',
      dirty: true,
    }];
    expect(writeDocumentSession('user-a', tabs, '/share/a.md', storage)).toBe(true);

    const raw = storage.values.get(documentSessionStorageKey('user-a'));
    expect(raw).not.toContain('secret body');
    expect(raw).not.toContain('secret draft');
    expect(JSON.parse(raw).tabs[0]).toEqual({
      id: '/share/a.md',
      path: '/share/a.md',
      actualPath: '/real/a.md',
      name: 'a.md',
      displayPath: '/share/a.md',
      type: 'file',
      dirty: true,
    });
    expect(documentSessionStorageKey('user-a')).not.toBe(documentSessionStorageKey('user-b'));
  });

  it('读取时过滤非法路径、重复项并限制标签数量', () => {
    const key = documentSessionStorageKey('user-a');
    const storage = memoryStorage({
      [key]: JSON.stringify({
        activeId: '/share/2.md',
        tabs: [
          { path: 'relative.md' },
          { path: '/share/not-markdown.txt' },
          { path: '/share/0.md' },
          { path: '/share/0.md' },
          ...Array.from({ length: 20 }, (_value, index) => ({ path: `/share/${index + 1}.md` })),
        ],
      }),
    });
    const session = readDocumentSession('user-a', storage);
    expect(session.tabs).toHaveLength(MAX_DOCUMENT_TABS);
    expect(new Set(session.tabs.map((tab) => tab.path)).size).toBe(MAX_DOCUMENT_TABS);
    expect(session.activeId).toBe('/share/2.md');
  });

  it('Windows 盘符路径可恢复且仍只保存惰性元数据', () => {
    const storage = memoryStorage();
    const path = 'C:/Users/Alice/Notes/a.md';
    expect(writeDocumentSession('windows-local', [{ path, actualPath: path }], path, storage))
      .toBe(true);
    expect(readDocumentSession('windows-local', storage)).toMatchObject({
      activeId: path,
      tabs: [{ id: path, path, actualPath: path }],
    });
  });
});
