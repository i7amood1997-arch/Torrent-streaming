import { describe, expect, it } from 'vitest';
import { friendlyError } from '@/lib/friendly-error';

describe('error messages people see', () => {
  it.each([
    ['Chrome', new TypeError('Failed to fetch')],
    ['Safari', new TypeError('Load failed')],
    ['Firefox', new TypeError('NetworkError when attempting to fetch resource.')],
  ])('%s offline: says so in plain words, not the browser’s wording', (_, e) => {
    const m = friendlyError(e);
    expect(m).toMatch(/internet/i);
    expect(m).not.toMatch(/fetch|Load failed|NetworkError/);
  });
  it('a timeout says it took too long', () => {
    const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(friendlyError(e)).toMatch(/too long/i);
  });
  it('anything else keeps its own message', () => {
    expect(friendlyError(new Error('HTTP 502'))).toBe('HTTP 502');
  });
});
