import { describe, expect, it } from 'vitest';
import {
  basenameHostPath,
  containsHostPath,
  dirnameHostPath,
  isAbsoluteHostPath,
  normalizeHostRoot,
} from './path';

describe('跨平台宿主路径', () => {
  it('完整保留原有 POSIX 路径语义', () => {
    expect(isAbsoluteHostPath('/share/项目 ')).toBe(true);
    expect(normalizeHostRoot('/share/docs///')).toBe('/share/docs');
    expect(basenameHostPath('/share/A.md')).toBe('A.md');
    expect(dirnameHostPath('/share/A.md')).toBe('/share');
    expect(containsHostPath('/share/docs', '/share/docs/a.md')).toBe(true);
    expect(containsHostPath('/share/docs', '/share/docs-old/a.md')).toBe(false);
  });

  it('接受 bridge 规范化后的 Windows 盘符路径', () => {
    expect(isAbsoluteHostPath('C:/Users/Alice/note.md')).toBe(true);
    expect(isAbsoluteHostPath('C:\\Users\\Alice\\note.md')).toBe(false);
    expect(normalizeHostRoot('C:/Users/Alice///')).toBe('C:/Users/Alice');
    expect(normalizeHostRoot('C:/')).toBe('C:/');
    expect(basenameHostPath('C:/Users/Alice/note.md')).toBe('note.md');
    expect(dirnameHostPath('C:/note.md')).toBe('C:/');
    expect(isAbsoluteHostPath('//server/share/note.md')).toBe(true);
    expect(normalizeHostRoot('//server/share/docs///')).toBe('//server/share/docs');
    expect(containsHostPath('//SERVER/Share', '//server/share/docs/a.md')).toBe(true);
    expect(containsHostPath('//server/share', '//server/share-old/a.md')).toBe(false);
  });

  it('Windows 包含判断使用组件边界且不区分大小写', () => {
    expect(containsHostPath('C:/Users/Alice', 'c:/users/alice/Docs/a.md')).toBe(true);
    expect(containsHostPath('C:/Users/Alice', 'C:/Users/Alice-old/a.md')).toBe(false);
    expect(containsHostPath('D:/', 'd:/docs/a.md')).toBe(true);
  });

  it('绝对形状判断不改写路径，根路径规范化再拒绝 NUL', () => {
    expect(isAbsoluteHostPath('docs/a.md')).toBe(false);
    expect(isAbsoluteHostPath('/share/a\0.md')).toBe(true);
    expect(normalizeHostRoot('/share/a\0.md')).toBeNull();
    expect(isAbsoluteHostPath(`/${'a'.repeat(4096)}`)).toBe(true);
  });
});
