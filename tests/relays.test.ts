import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonWithRelays, type Relay } from '@/lib/relays';

const relays: Relay[] = [
  { name: 'r1', wrap: (u) => `https://r1.example/?u=${encodeURIComponent(u)}` },
  { name: 'r2', wrap: (u) => `https://r2.example/?u=${encodeURIComponent(u)}` },
];
const blocked = () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => vi.unstubAllGlobals());

describe('fetchJsonWithRelays', () => {
  it('uses the direct response when it works', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await fetchJsonWithRelays('https://a.example/x', async () => ({ ok: 1 }), { timeoutMs: 1000, relays })).toEqual({ ok: 1 });
    expect(f).not.toHaveBeenCalled();
  });

  it('falls back to the first working relay, skipping HTML error pages', async () => {
    const f = vi.fn(async (url: string) =>
      url.startsWith('https://r1') ? new Response('<html>blocked</html>', { status: 200 }) : Response.json({ data: 42 }),
    );
    vi.stubGlobal('fetch', f);
    expect(await fetchJsonWithRelays('https://b.example/x', blocked, { timeoutMs: 1000, relays })).toEqual({ data: 42 });
    expect(f).toHaveBeenCalledTimes(2);
    // Remembered: next call for the same host goes straight to r2, no direct attempt
    f.mockClear();
    const direct = vi.fn(blocked);
    await fetchJsonWithRelays('https://b.example/y', direct, { timeoutMs: 1000, relays });
    expect(direct).not.toHaveBeenCalled();
    expect(f.mock.calls[0][0]).toContain('https://r2.example');
  });

  it('does not relay real HTTP errors', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(fetchJsonWithRelays('https://c.example/x', () => Promise.reject(new Error('HTTP 500')), { timeoutMs: 1000, relays })).rejects.toThrow('HTTP 500');
    expect(f).not.toHaveBeenCalled();
  });

  it('reports when everything fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(fetchJsonWithRelays('https://d.example/x', blocked, { timeoutMs: 1000, relays })).rejects.toThrow(/public relays.*r1: HTTP 403.*r2: HTTP 403/);
  });
});
