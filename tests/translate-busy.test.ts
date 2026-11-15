import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSY_RETRY_MS, firstPassLines, googleTranslate, translateLines } from '@/lib/translate';
import { firstWorking, rankTracks } from '@/lib/subtitle-parser';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const googleOk = (q: string) => ({ ok: true, status: 200, json: async () => [[[q.split('\n').map((l) => `AR(${l})`).join('\n'), q]], null, 'en'] });

describe('Google rate limit (translator busy 429)', () => {
  it('waits and retries instead of failing on the first 429', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      calls++;
      if (calls === 1) return { ok: false, status: 429 };
      return googleOk(new URLSearchParams(String(init.body)).get('q')!);
    });
    const p = googleTranslate('Hello', 'en', 'ar');
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS[0]);
    expect(await p).toBe('AR(Hello)');
    expect(calls).toBe(2);
  });

  it('gives up with the busy message once the retries are used', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429 }));
    const p = googleTranslate('Hello', 'en', 'ar');
    const check = expect(p).rejects.toThrow('translator busy (429)');
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS.reduce((a, b) => a + b, 0));
    await check;
  });

  it('lets the AI translate the file when Google refuses', async () => {
    const busy = async () => { throw new Error('translator busy (429)'); };
    const ai = async (lines: string[]) => lines.map((l) => `AI(${l})`);
    const r = await firstPassLines(['Hi.', 'Bye.'], 'en', 'ar', { translate: busy, ai });
    expect(r).toEqual({ out: ['AI(Hi.)', 'AI(Bye.)'], engine: 'ai' });
  });

  it('still reports the error when there is no AI to fall back to', async () => {
    const busy = async () => { throw new Error('translator busy (429)'); };
    await expect(firstPassLines(['Hi.'], 'en', 'ar', { translate: busy })).rejects.toThrow('busy');
  });

  it('does not fail a whole file when Google is busy for a line the AI skipped', async () => {
    const busy = async () => { throw new Error('translator busy (429)'); };
    const ai = async (lines: string[]) => lines.map((l, i) => (i === 0 ? undefined : `AI(${l})`));
    expect(await translateLines(['A.', 'B.'], 'en', 'ar', { translate: busy, ai })).toEqual(['', 'AI(B.)']);
  });
});

describe('subtitle that will not download', () => {
  it('falls back to the next best track', async () => {
    const tracks = [{ id: 'a', lang: 'en', score: 9 }, { id: 'b', lang: 'en', score: 5 }, { id: 'c', lang: 'ar', score: 7 }] as never[];
    const tried: string[] = [];
    const got = await firstWorking(rankTracks(tracks, 'en'), async (t: { id: string }) => { tried.push(t.id); return t.id === 'b'; });
    expect(tried).toEqual(['a', 'b']);
    expect((got as { id: string }).id).toBe('b');
  });
});
