import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkRealDebridCache } from '@/lib/debrid';
import { rankResults } from '@/lib/result-filters';
import type { TorrentResult } from '@/lib/types';

afterEach(() => vi.unstubAllGlobals());

const H = (n: number) => String(n).repeat(40).slice(0, 40);
const item = (n: number) => ({ infoHash: H(n), magnet: `magnet:?xt=urn:btih:${H(n)}` });

/** A stand-in Real-Debrid: hash 1 already downloaded in the account, 2 cached, 3 not cached, 4 errors. */
function fakeRD() {
  const calls: string[] = [];
  const statusAfterSelect: Record<string, string> = { a2: 'downloaded', a3: 'downloading' };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url).replace('https://api.real-debrid.com/rest/1.0', '');
    calls.push(`${init.method ?? 'GET'} ${u}`);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.startsWith('/torrents?')) return ok([{ id: 'old', hash: H(1).toUpperCase(), status: 'downloaded' }]);
    if (u === '/torrents/addMagnet') {
      const m = new URLSearchParams(String(init.body)).get('magnet')!;
      if (m.includes(H(4))) return new Response(JSON.stringify({ error: 'too_many_requests' }), { status: 429 });
      return ok({ id: m.includes(H(2)) ? 'a2' : 'a3' });
    }
    const info = /\/torrents\/info\/(\w+)/.exec(u);
    if (info) {
      const selected = calls.some((c) => c === `POST /torrents/selectFiles/${info[1]}`);
      return ok({ status: selected ? statusAfterSelect[info[1]] : 'waiting_files_selection', files: [{ id: 1, path: '/Show.S01E02.mkv', bytes: 9e8 }] });
    }
    if (u.startsWith('/torrents/selectFiles/')) return new Response(null, { status: 204 });
    if (u.startsWith('/torrents/delete/')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  });
  return calls;
}

describe('Real-Debrid: will it start instantly?', () => {
  it('tells instant from not cached, and leaves no failed checks in the account', async () => {
    const calls = fakeRD();
    const states = await checkRealDebridCache('key', [item(1), item(2), item(3), item(4)]);
    expect(states).toEqual({ [H(1)]: 'instant', [H(2)]: 'instant', [H(3)]: 'not', [H(4)]: 'unknown' });
    expect(calls).toContain('DELETE /torrents/delete/a3'); // not cached: removed again
    expect(calls).not.toContain('DELETE /torrents/delete/a2'); // cached: kept for Play
    expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(3); // the one already there isn't re-added
  });
});

describe('Play prefers what starts instantly', () => {
  const r = (id: string, quality: TorrentResult['quality'], seeders: number): TorrentResult => ({ id, title: id, infoHash: id, magnet: 'm', seeders, leechers: 0, indexer: 'x', quality } as TorrentResult);
  it('an instant 1080p beats a slightly better-looking one that has to download first', () => {
    const list = [r('a', '1080p', 400), r('b', '1080p', 90), r('c', '720p', 50)];
    expect(rankResults(list, { debrid: true })[0].id).toBe('a');
    expect(rankResults(list, { debrid: true, cache: { a: 'not', b: 'instant' } })[0].id).toBe('b');
  });
});
