import { describe, expect, it } from 'vitest';
import {
  MAX_EDITABLE_DOCUMENT_BYTES,
  MAX_EDITABLE_DOCUMENT_MIB,
} from './limits';

describe('共享文稿限制', () => {
  it('将可编辑文稿上限固定为 10 MiB', () => {
    expect(MAX_EDITABLE_DOCUMENT_MIB).toBe(10);
    expect(MAX_EDITABLE_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});
