import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RECENT_DOCUMENTS,
  normalizeRecentDocument,
  prependRecentDocument,
  readRecentDocuments,
  recentStorageKey,
  writeRecentDocuments,
} from './recent-documents';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    values,
  };
}

function recent(path, extra = {}) {
  return {
    path,
    name: path.split('/').pop(),
    displayPath: path,
    type: 'file',
    openedAt: 1,
    ...extra,
  };
}

describe('最近文稿持久化', () => {
  it('按 fnOS uid 隔离，无法识别用户时拒绝创建共享存储桶', () => {
    expect(recentStorageKey('user-a')).not.toBe(recentStorageKey('user-b'));
    expect(recentStorageKey(null)).toBeNull();
    expect(recentStorageKey('')).toBeNull();
  });

  it('拒绝篡改的路径和类型，不截断后误指向另一个文件', () => {
    expect(normalizeRecentDocument(recent('relative.md'))).toBeNull();
    expect(normalizeRecentDocument(recent('/share/a.txt'))).toBeNull();
    expect(normalizeRecentDocument(recent('/share/a.md', { type: 'directory' }))).toBeNull();
    expect(normalizeRecentDocument(recent(`/share/${'a'.repeat(4090)}.md`))).toBeNull();
    expect(normalizeRecentDocument(recent('/share/good.md\0evil'))).toBeNull();
  });

  it('读取时过滤篡改和重复项，并限制为 12 条', () => {
    const key = recentStorageKey('user-a');
    const stored = memoryStorage({
      [key]: JSON.stringify([
        recent('/share/0.md'),
        recent('/share/0.md', { name: 'duplicate' }),
        recent('/share/not-markdown.png'),
        ...Array.from({ length: 20 }, (_value, index) => recent(`/share/${index + 1}.md`)),
      ]),
    });

    const result = readRecentDocuments('user-a', stored);
    expect(result).toHaveLength(MAX_RECENT_DOCUMENTS);
    expect(result[0].path).toBe('/share/0.md');
    expect(new Set(result.map((item) => item.path)).size).toBe(MAX_RECENT_DOCUMENTS);
  });

  it('只写入惰性展示元数据，正文与额外字段不会落盘', () => {
    const stored = memoryStorage();
    expect(writeRecentDocuments('user-a', [recent('/share/a.md', {
      content: 'secret body',
      token: 'secret token',
    })], stored)).toBe(true);

    const payload = JSON.parse(stored.values.get(recentStorageKey('user-a')));
    expect(payload).toEqual([{
      path: '/share/a.md',
      name: 'a.md',
      displayPath: '/share/a.md',
      type: 'file',
      openedAt: 1,
    }]);
  });

  it('新增文稿置顶、去重，并安全吞掉存储配额错误', () => {
    const next = prependRecentDocument(
      [recent('/share/a.md'), recent('/share/b.md')],
      recent('/share/b.md'),
      99,
    );
    expect(next.map((item) => item.path)).toEqual(['/share/b.md', '/share/a.md']);
    expect(next[0].openedAt).toBe(99);

    const brokenStorage = {
      setItem: vi.fn(() => { throw new Error('quota'); }),
    };
    expect(writeRecentDocuments('user-a', next, brokenStorage)).toBe(false);
  });
});
