import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenAllDebrid, resolveDebridStream } from '@/lib/debrid';

const HASH = 'a'.repeat(40);
const base = { infoHash: HASH, magnet: `magnet:?xt=urn:btih:${HASH}`, apiKey: 'KEY' };
afterEach(() => vi.unstubAllGlobals());

/** Answers by URL path, and records what was asked. */
function fakeFetch(routes: Record<string, (u: URL, init?: RequestInit) => unknown>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key](u, init)), { status: 200 });
  });
  return calls;
}

describe('Premiumize', () => {
  it('cached: the season pack’s right episode plays at once', async () => {
    const calls = fakeFetch({
      'transfer/directdl': () => ({ status: 'success', content: [
        { path: 'Show.S01/Show.S01E01.1080p.mkv', size: 2e9, link: 'https://dl.pm/1' },
        { path: 'Show.S01/Show.S01E02.1080p.mkv', size: 2e9, link: 'https://dl.pm/2' },
        { path: 'Show.S01/sample.mkv', size: 1e7, link: 'https://dl.pm/s' },
      ] }),
    });
    const r = await resolveDebridStream({ ...base, provider: 'premiumize', season: 1, episode: 2 });
    expect(r).toMatchObject({ status: 'ready', url: 'https://dl.pm/2', fileName: 'Show.S01E02.1080p.mkv', provider: 'premiumize' });
    expect(calls[0].url.searchParams.get('apikey')).toBe('KEY');
    expect(new URLSearchParams(String(calls[0].init?.body)).get('src')).toContain(HASH);
  });

  it('not cached: starts a cloud download, then reports its progress', async () => {
    let created = false;
    fakeFetch({
      'transfer/directdl': () => ({ status: 'error', message: 'Not cached' }),
      'transfer/list': () => ({ status: 'success', transfers: created ? [{ id: 'x', src: `magnet:?xt=urn:btih:${HASH}`, status: 'running', progress: 0.42, message: 'Downloading' }] : [] }),
      'transfer/create': () => { created = true; return { status: 'success', id: 'x' }; },
    });
    expect(await resolveDebridStream({ ...base, provider: 'premiumize' })).toMatchObject({ status: 'queued', progress: 0 });
    expect(await resolveDebridStream({ ...base, provider: 'premiumize' })).toMatchObject({ status: 'queued', progress: 42 });
  });

  it('a wrong key is reported, not treated as "not cached"', async () => {
    fakeFetch({ 'transfer/directdl': () => ({ status: 'error', message: 'Not logged in / bad api key' }) });
    await expect(resolveDebridStream({ ...base, provider: 'premiumize' })).rejects.toThrow(/api key/i);
  });
});

describe('AllDebrid', () => {
  it('flattens its file tree', () => {
    expect(flattenAllDebrid([{ n: 'Show.S01', e: [{ n: 'E01.mkv', s: 5, l: 'L1' }, { n: 'Subs', e: [{ n: 'en.srt', s: 1, l: 'L2' }] }] }, { n: 'readme.txt', s: 1, l: 'L3' }]))
      .toEqual([{ name: 'E01.mkv', size: 5, link: 'L1' }, { name: 'en.srt', size: 1, link: 'L2' }, { name: 'readme.txt', size: 1, link: 'L3' }]);
  });

  it('ready: picks the episode, unlocks it, and names the app on every call', async () => {
    const calls = fakeFetch({
      '/v4/magnet/upload': () => ({ status: 'success', data: { magnets: [{ id: 77, ready: true }] } }),
      '/v4/magnet/files': () => ({ status: 'success', data: { magnets: [{ id: '77', files: [{ n: 'Pack', e: [{ n: 'Show.S02E03.mkv', s: 9, l: 'https://alldebrid.com/f/3' }, { n: 'Show.S02E04.mkv', s: 9, l: 'https://alldebrid.com/f/4' }] }] }] } }),
      '/v4/link/unlock': (u) => ({ status: 'success', data: { link: `https://cdn.ad/${u.searchParams.get('link')!.split('/').pop()}.mkv`, filename: 'Show.S02E04.mkv' } }),
    });
    const r = await resolveDebridStream({ ...base, provider: 'alldebrid', season: 2, episode: 4 });
    expect(r).toMatchObject({ status: 'ready', url: 'https://cdn.ad/4.mkv', fileName: 'Show.S02E04.mkv', provider: 'alldebrid' });
    expect(calls.every((c) => c.url.searchParams.get('agent') === 'streamdeck')).toBe(true);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer KEY');
  });

  it('downloading: reports progress', async () => {
    fakeFetch({
      '/v4/magnet/upload': () => ({ status: 'success', data: { magnets: [{ id: 5, ready: false }] } }),
      '/v4.1/magnet/status': () => ({ status: 'success', data: { magnets: { id: 5, status: 'Downloading', statusCode: 1, size: 1000, downloaded: 250 } } }),
    });
    expect(await resolveDebridStream({ ...base, provider: 'alldebrid' })).toMatchObject({ status: 'queued', progress: 25 });
  });

  it('a bad key says so in plain words', async () => {
    fakeFetch({ '/v4/magnet/upload': () => ({ status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' } }) });
    await expect(resolveDebridStream({ ...base, provider: 'alldebrid' })).rejects.toThrow(/API key isn’t valid/);
  });
});
