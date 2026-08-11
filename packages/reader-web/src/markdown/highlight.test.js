import { describe, expect, it } from 'vitest';
import {
  HUGE_CODE_THRESHOLD,
  HUGE_LINE_THRESHOLD,
  isHugeCode,
} from './highlight';

describe('代码高亮性能保护阈值', () => {
  it('允许总长度 100,000 且单行不超过 4,000 的代码', () => {
    const code = [
      'x'.repeat(HUGE_LINE_THRESHOLD),
      ...Array.from({ length: 24 }, () => 'x'.repeat(HUGE_LINE_THRESHOLD - 1)),
    ].join('\n');

    expect(code).toHaveLength(HUGE_CODE_THRESHOLD);
    expect(isHugeCode(code)).toBe(false);
  });

  it('总长度超过 100,000 时跳过高亮', () => {
    const code = Array.from({ length: 26 }, () => 'x'.repeat(3_999)).join('\n');

    expect(code.length).toBeGreaterThan(HUGE_CODE_THRESHOLD);
    expect(code.split('\n').every((line) => line.length <= HUGE_LINE_THRESHOLD)).toBe(true);
    expect(isHugeCode(code)).toBe(true);
  });

  it('允许 4,000 字符单行，超过一个字符才跳过高亮', () => {
    expect(isHugeCode('x'.repeat(HUGE_LINE_THRESHOLD))).toBe(false);
    expect(isHugeCode('x'.repeat(HUGE_LINE_THRESHOLD + 1))).toBe(true);
  });
});
