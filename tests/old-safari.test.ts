import { describe, expect, it } from 'vitest';
import { ensureAbortTimeout } from '@/lib/runtime';

describe('browsers without AbortSignal.timeout (iOS 15)', () => {
  it('get a working time limit instead of a crash on every request', async () => {
    const old: { timeout?: (ms: number) => AbortSignal } = {};
    ensureAbortTimeout(old);
    const signal = old.timeout!(10);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('TimeoutError');
  });

  it('leaves browsers that have it alone', () => {
    const native = AbortSignal.timeout;
    ensureAbortTimeout();
    expect(AbortSignal.timeout).toBe(native);
  });
});
