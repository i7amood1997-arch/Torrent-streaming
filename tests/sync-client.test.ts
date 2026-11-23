import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The app's sync loop, with a relay that answers when the test says so. */
describe('sync: a change made while a sync is on its way', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('is sent within seconds, not left for the once-a-minute sync', async () => {
    const { useApp } = await import('@/lib/store');
    const { startSync } = await import('@/lib/sync-client');
    const sent: unknown[] = [];
    let answer: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { state } = JSON.parse(String(init.body));
      sent.push(state);
      if (sent.length === 1) await new Promise<void>((ok) => { answer = ok; }); // the first one is slow
      return new Response(JSON.stringify({ state }), { status: 200 });
    }));
    useApp.setState((s) => ({ caps: { ...(s.caps ?? {}), sync: true } as never, settings: { ...s.settings, apiBase: 'https://relay.test', syncKey: 'k'.repeat(32) } }));
    startSync();
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toHaveLength(1); // on its way

    useApp.getState().touch('progress', 'tt1:1:2', 1234); // watched further meanwhile
    answer!();
    await vi.advanceTimersByTimeAsync(5000);

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(sent.at(-1))).toContain('1234');
    // …and it settles: no endless back-and-forth after that.
    const n = sent.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.length).toBe(n);
  });
});
