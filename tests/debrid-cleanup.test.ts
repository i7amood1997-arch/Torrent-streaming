import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDebridStream } from '@/lib/debrid';

const HASH = 'a'.repeat(40);

/** A fake Real-Debrid API. `unrestrict` decides what /unrestrict/link answers. */
function fakeRD(unrestrict: () => Response, status = 'downloaded') {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u.replace('https://api.real-debrid.com/rest/1.0', '')}`);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (u.includes('/torrents?')) return json([]);
    if (u.endsWith('/torrents/addMagnet')) return json({ id: 'T1' });
    if (u.includes('/torrents/info/')) return json({ status, files: [{ id: 1, path: '/a.mkv', bytes: 10, selected: 1 }], links: ['https://rd/x'] });
    if (u.endsWith('/unrestrict/link')) return unrestrict();
    if (u.includes('/torrents/delete/')) return new Response(null, { status: 204 });
    if (u.includes('/streaming/transcode/')) return json({});
    return json({}, 404);
  }));
  return calls;
}

const resolve = () => resolveDebridStream({ provider: 'realdebrid', apiKey: 'k', magnet: `magnet:?xt=urn:btih:${HASH}`, infoHash: HASH });

afterEach(() => vi.unstubAllGlobals());

describe('Real-Debrid cleanup', () => {
  it('removes a torrent Real-Debrid blocked for copyright, and still reports the block', async () => {
    const calls = fakeRD(() => new Response(JSON.stringify({ error: 'infringing_file', error_code: 35 }), { status: 503 }));
    await expect(resolve()).rejects.toThrow(/copyright complaint/);
    expect(calls).toContain('DELETE /torrents/delete/T1');
  });

  it('removes a dead torrent', async () => {
    const calls = fakeRD(() => new Response('{}'), 'dead');
    await expect(resolve()).rejects.toThrow(/dead/);
    expect(calls).toContain('DELETE /torrents/delete/T1');
  });

  it('keeps working torrents and errors that may pass (rate limits)', async () => {
    let calls = fakeRD(() => new Response(JSON.stringify({ id: 'L', download: 'https://dl/x.mkv', filename: 'x.mkv' })));
    expect((await resolve()).status).toBe('ready');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    calls = fakeRD(() => new Response(JSON.stringify({ error: 'too_many_requests' }), { status: 429 }));
    await expect(resolve()).rejects.toThrow(/rate-limiting/);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('still succeeds when the delete itself fails', async () => {
    fakeRD(() => new Response(JSON.stringify({ error: 'infringing_file' }), { status: 503 }));
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const orig = f.getMockImplementation()!;
    f.mockImplementation(async (url: string, init?: RequestInit) => { if (String(url).includes('/delete/')) throw new TypeError('network'); return orig(url, init); });
    await expect(resolve()).rejects.toThrow(/copyright complaint/); // the block, not the delete failure
  });
});
