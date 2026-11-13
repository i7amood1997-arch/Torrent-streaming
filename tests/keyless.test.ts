import { afterEach, describe, expect, it, vi } from 'vitest';
import { cinemeta, imdbFromNumeric } from '@/lib/cinemeta';
import { parseRelease, titleFromRelease } from '@/lib/release-parser';
import { handleApi } from '@/lib/server/handlers';
import { decodeToken, fetchSubtitleCues, searchSubtitles } from '@/lib/subtitles';
import { configFromEnv, parseNyaaRss, searchTorrents } from '@/lib/torrent-indexer';

afterEach(() => vi.unstubAllGlobals());

/** Route stubbed fetches by URL substring. */
function stubFetch(routes: Record<string, (url: string, init?: RequestInit) => unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const [key, fn] of Object.entries(routes)) {
      if (url.includes(key)) {
        const body = fn(url, init);
        return typeof body === 'string' ? new Response(body) : Response.json(body);
      }
    }
    return new Response('not found', { status: 404 });
  }));
  return calls;
}

const movieMeta = { id: 'tt1392170', type: 'movie', name: 'The Hunger Games', poster: 'https://img.example/p.jpg', releaseInfo: '2012', imdbRating: '7.2', description: 'd' };
const seriesMeta = {
  id: 'tt0903747', type: 'series', name: 'Breaking Bad', releaseInfo: '2008–2013', genres: ['Crime'],
  videos: [
    { season: 1, episode: 2, name: 'Cat in the Bag', released: '2008-01-27' },
    { season: 1, episode: 1, title: 'Pilot' },
    { season: 0, episode: 1, name: 'Special' },
    { season: 2, number: 1, name: 'Seven Thirty-Seven' },
  ],
};

describe('release helpers', () => {
  it('extracts titles from scene and anime names', () => {
    expect(titleFromRelease('The.Bear.S03E04.1080p.WEB-DL.DDP5.1.H.264-NTb')).toBe('The Bear');
    expect(titleFromRelease('The Hunger Games (2012) 1080p BluRay x264 AAC 5.1-YTS')).toBe('The Hunger Games');
    expect(titleFromRelease('[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv')).toBe('Sousou no Frieren');
  });
  it('detects the container from a file name', () => {
    expect(parseRelease('Show.S01E01.1080p.WEB.x264-GRP.mkv').container).toBe('mkv');
    expect(parseRelease('Movie.2020.720p.BluRay.x264.MP4').container).toBe('mp4');
    expect(parseRelease('Movie.2020.720p.BluRay.x264-GRP').container).toBeUndefined();
  });
});

describe('Cinemeta catalog (keyless)', () => {
  it('maps search results and keeps IMDB ids recoverable', async () => {
    stubFetch({
      '/catalog/movie/top/search=': () => ({ metas: [movieMeta, { id: 'kitsu:1', name: 'ignored' }] }),
      '/catalog/series/top/search=': () => ({ metas: [seriesMeta] }),
    });
    const items = await cinemeta.search('hunger');
    expect(items.map((i) => i.title)).toEqual(['The Hunger Games', 'Breaking Bad']);
    expect(items[0]).toMatchObject({ id: 1392170, type: 'movie', year: 2012, rating: 7.2, imdbId: 'tt1392170', source: 'cinemeta', posterPath: 'https://img.example/p.jpg' });
    expect(imdbFromNumeric(items[1].id)).toBe('tt0903747');
  });
  it('builds seasons and sorted episodes', async () => {
    stubFetch({ '/meta/series/tt0903747.json': () => ({ meta: seriesMeta }) });
    const d = await cinemeta.details('series', 903747);
    expect(d.seasons).toEqual([{ seasonNumber: 1, name: 'Season 1', episodeCount: 2 }, { seasonNumber: 2, name: 'Season 2', episodeCount: 1 }]);
    const eps = await cinemeta.season(903747, 1);
    expect(eps.map((e) => [e.episodeNumber, e.name])).toEqual([[1, 'Pilot'], [2, 'Cat in the Bag']]);
  });
  it('serves /api/tmdb without any TMDB key', async () => {
    stubFetch({ '/catalog/movie/top.json': () => ({ metas: [movieMeta] }), '/catalog/series/top.json': () => ({ metas: [] }) });
    const res = await handleApi(new Request('https://api.example/api/tmdb?action=trending'), {});
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].imdbId).toBe('tt1392170');
  });
});

describe('keyless subtitles (OpenSubtitles feed)', () => {
  const feed = {
    subtitles: [
      { id: '1', url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/111', lang: 'eng' },
      { id: '2', url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/222', lang: 'ara' },
      { id: '3', url: 'https://subs5.strem.io/x/333', lang: 'fre' },
      { id: '4', url: 'https://evil.example/444', lang: 'ara' },
    ],
  };
  it('finds Arabic and English by IMDB id with no keys', async () => {
    const calls = stubFetch({ 'opensubtitles-v3.strem.io/subtitles/series/tt0903747:1:2.json': () => feed });
    const { tracks, errors } = await searchSubtitles({ imdbId: 'tt0903747', type: 'series', season: 1, episode: 2 }, {});
    expect(errors).toEqual([]);
    expect(tracks.map((t) => t.lang).sort()).toEqual(['ar', 'en']);
    expect(calls).toHaveLength(1);
    expect(decodeToken(tracks[0].token)).toMatchObject({ p: 'stremio' });
  });
  it('identifies a raw release through the catalog, then downloads cues', async () => {
    stubFetch({
      '/catalog/movie/top/search=The%20Hunger%20Games': () => ({ metas: [{ ...movieMeta, id: 'tt9999999', releaseInfo: '1999' }, movieMeta] }),
      'opensubtitles-v3.strem.io/subtitles/movie/tt1392170.json': () => feed,
      '/file/222': () => '1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n',
    });
    const { tracks } = await searchSubtitles({ releaseName: 'The Hunger Games (2012) 1080p BluRay x264 AAC 5.1-YTS' }, {});
    const ar = tracks.find((t) => t.lang === 'ar')!;
    expect(ar).toBeTruthy();
    expect(await fetchSubtitleCues(ar.token, {})).toEqual([{ start: 1, end: 2, text: 'مرحبا' }]);
  });
  it('rejects tokens pointing outside the subtitle host', () => {
    const forged = btoa(JSON.stringify({ p: 'stremio', url: 'https://evil.example/x', lang: 'ar' })).replace(/=+$/, '');
    expect(() => decodeToken(forged)).toThrow();
  });
});

describe('new torrent sources', () => {
  const H = (c: string) => c.repeat(40);
  it('parses Nyaa RSS', () => {
    const rss = `<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item><title>[Grp] Show - 07 (1080p) [AAAA].mkv</title>
      <nyaa:seeders>345</nyaa:seeders><nyaa:leechers>12</nyaa:leechers><nyaa:infoHash>${H('A')}</nyaa:infoHash><nyaa:size>1.3 GiB</nyaa:size></item>
      <item><title>no hash</title></item></channel></rss>`;
    const [r, ...rest] = parseNyaaRss(rss);
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({ infoHash: H('a'), seeders: 345, leechers: 12, quality: '1080p', container: 'mkv', tracker: 'Nyaa' });
    expect(r.sizeBytes).toBe(Math.round(1.3 * 1024 ** 3));
  });
  it('merges Knaben, Torrents-CSV and YTS results and carries the IMDB id', async () => {
    let knabenBody: any;
    stubFetch({
      'api.knaben.org/v1': (_u, init) => { knabenBody = JSON.parse(String(init?.body)); return { hits: [{ title: 'Film.2020.1080p.WEB-DL.x264-GRP', hash: H('B'), bytes: 2e9, seeders: 50, peers: 60, tracker: '1337x' }, { title: 'bad' }] }; },
      'torrents-csv.com/service/search': () => ({ torrents: [{ infohash: H('b'), name: 'Film.2020.1080p.WEB-DL.x264-GRP', size_bytes: 2e9, seeders: 80, leechers: 1 }, { infohash: H('c'), name: 'Film soundtrack flac', size_bytes: 1, seeders: 9, leechers: 0 }] }),
      '/api/v2/list_movies.json': () => ({ status: 'ok', data: { movies: [{ title_long: 'Film (2020)', imdb_code: 'tt1234567', torrents: [{ hash: H('d'), quality: '1080p', type: 'web', size_bytes: 1.5e9, seeds: 10, peers: 2 }] }] } }),
    });
    const cfg = configFromEnv({ INDEXERS: 'knaben,torrentscsv,yts', YTS_URL: 'https://yts.test' });
    const res = await searchTorrents({ q: 'film 2020' }, cfg);
    expect(res.errors).toEqual([]);
    expect(knabenBody.query).toBe('film 2020');
    expect(res.results.map((r) => r.infoHash)).toEqual([H('b'), H('d')]); // merged by hash, soundtrack filtered, sorted by seeders
    expect(res.results[0]).toMatchObject({ seeders: 80, tracker: '1337x, Torrents-CSV' });
    expect(res.results[1]).toMatchObject({ imdbId: 'tt1234567', container: 'mp4' });
  });
});

describe('rate limits', () => {
  it('retries a source once after HTTP 429', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : Response.json([]))));
    const res = await searchTorrents({ q: 'film' }, configFromEnv({ INDEXERS: 'apibay' }));
    expect(n).toBe(2);
    expect(res.errors).toEqual([]);
  });
});

describe('season packs', async () => {
  const { textQueriesFor } = await import('@/lib/torrent-indexer');
  it('searches the episode and its season pack', () => {
    expect(textQueriesFor({ title: 'Game of Thrones', type: 'series', season: 8, episode: 1 })).toEqual(['Game of Thrones S08E01', 'Game of Thrones S08']);
    expect(textQueriesFor({ q: 'raw text' })).toEqual(['raw text']);
    expect(textQueriesFor({ title: 'Dune', type: 'movie', year: 2021 })).toEqual(['Dune 2021']);
  });
  it('keeps season packs and drops other episodes', async () => {
    const hits = [
      { title: 'Show.S08E01.1080p.WEB-DL-A', hash: 'a'.repeat(40), seeders: 10 },
      { title: 'Show.S08.COMPLETE.1080p.WEB-DL-B', hash: 'b'.repeat(40), seeders: 900 },
      { title: 'Show.S08E02.1080p.WEB-DL-C', hash: 'c'.repeat(40), seeders: 50 },
    ];
    const queries: string[] = [];
    stubFetch({ 'api.knaben.org/v1': (_u, init) => { queries.push(JSON.parse(String(init?.body)).query); return { hits }; } });
    const res = await searchTorrents({ title: 'Show', type: 'series', season: 8, episode: 1 }, configFromEnv({ INDEXERS: 'knaben' }));
    expect(queries.sort()).toEqual(['Show S08', 'Show S08E01']);
    expect(res.results.map((r) => r.title)).toEqual(['Show.S08.COMPLETE.1080p.WEB-DL-B', 'Show.S08E01.1080p.WEB-DL-A']);
  });
});
