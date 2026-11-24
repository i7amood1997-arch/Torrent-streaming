import { describe, expect, it, vi } from 'vitest';
import { animeShelf, cleanDescription, type AniMedia } from '@/lib/server/anime';
import type { TmdbItem } from '@/lib/types';

const media = (m: Partial<AniMedia> & { id: number }): AniMedia => ({
  format: 'TV', seasonYear: 2023, averageScore: 90, title: { english: null, romaji: 'Romaji' }, coverImage: { extraLarge: `https://img/${m.id}.jpg` }, bannerImage: null, description: '', ...m,
});
// AniList answers in this shape (Page.media).
const anilist = (list: AniMedia[]) => vi.fn(async () => new Response(JSON.stringify({ data: { Page: { media: list } } }), { status: 200 }));
const MAP = { 154587: '22248376,t209867', 21: '0388629,t37854', 2001: '9999999,m555' };

describe('Anime rows', () => {
  it('known anime: linked to its IMDb title, with AniList’s picture and English title', async () => {
    const fetch = anilist([media({ id: 154587, title: { english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren' }, averageScore: 91, description: 'An elf<br>mage.' })]);
    const [it] = await animeShelf('trending', { fetch, map: MAP, useTmdb: false, search: async () => [] });
    expect(it).toMatchObject({ id: 22248376, imdbId: 'tt22248376', type: 'series', title: 'Frieren: Beyond Journey’s End', source: 'cinemeta', year: 2023, rating: 9.1, posterPath: 'https://img/154587.jpg', overview: 'An elf mage.' });
  });

  it('a relay with a TMDB key gets the TMDB id instead', async () => {
    const fetch = anilist([media({ id: 21, title: { english: 'One Piece', romaji: 'One Piece' } })]);
    const [it] = await animeShelf('trending', { fetch, map: MAP, useTmdb: true, search: async () => [] });
    expect(it).toMatchObject({ id: 37854, source: 'tmdb', imdbId: 'tt0388629' });
  });

  it('an anime film is a movie', async () => {
    const fetch = anilist([media({ id: 2001, format: 'MOVIE' })]);
    const [it] = await animeShelf('top', { fetch, map: MAP, useTmdb: false, search: async () => [] });
    expect(it.type).toBe('movie');
  });

  it('a new show not linked yet is found by name, if the year matches', async () => {
    const fetch = anilist([media({ id: 999001, seasonYear: 2026, title: { english: 'Brand New Show', romaji: 'Shin' } })]);
    const found: TmdbItem = { id: 31000001, type: 'series', title: 'Brand New Show', overview: '', year: 2026, imdbId: 'tt31000001', source: 'cinemeta' };
    const search = vi.fn(async () => [{ ...found, id: 1, type: 'movie' as const, year: 2026 }, found]);
    const [it] = await animeShelf('airing', { fetch, map: MAP, useTmdb: false, search });
    expect(search).toHaveBeenCalledWith('Brand New Show');
    expect(it).toMatchObject({ id: 31000001, imdbId: 'tt31000001', posterPath: 'https://img/999001.jpg' });
  });

  it('a name match from another year is not used (likely a different show)', async () => {
    const fetch = anilist([media({ id: 999002, seasonYear: 2026, title: { english: 'Monster', romaji: 'Monster' } })]);
    const search = async (): Promise<TmdbItem[]> => [{ id: 434706, type: 'series', title: 'Monster', overview: '', year: 2004, imdbId: 'tt0434706', source: 'cinemeta' }];
    expect(await animeShelf('airing', { fetch, map: MAP, useTmdb: false, search })).toEqual([]);
  });

  it('several seasons of one show appear once', async () => {
    const map = { 1: '100', 2: '100', 3: '200' };
    const fetch = anilist([media({ id: 1 }), media({ id: 2 }), media({ id: 3 })]);
    const items = await animeShelf('trending', { fetch, map, useTmdb: false, search: async () => [] });
    expect(items.map((i) => i.id)).toEqual([100, 200]);
  });

  it('asks AniList for the right list, without adult titles', async () => {
    const fetch = anilist([]);
    await animeShelf('airing', { fetch, map: MAP, useTmdb: false, search: async () => [] });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.query).toMatch(/isAdult: false/);
    expect(body.query).toMatch(/status: RELEASING/);
    expect(body.variables.sort).toEqual(['POPULARITY_DESC']);
  });

  it('AniList down: the error comes through (the app then shows nothing for that row)', async () => {
    const fetch = vi.fn(async () => new Response('busy', { status: 429 }));
    await expect(animeShelf('trending', { fetch, map: MAP, useTmdb: false, search: async () => [] })).rejects.toThrow(/AniList/);
  });

  it('descriptions lose AniList’s markup and source notes', () => {
    expect(cleanDescription('A <i>great</i> show.<br><br>(Source: Crunchyroll)')).toBe('A great show.');
    expect(cleanDescription(null)).toBe('');
  });
});

describe('Anime rows through the relay', () => {
  it('/api/tmdb?action=anime&list=trending answers with linked titles', async () => {
    const { handleApi } = await import('@/lib/server/handlers');
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('anilist')) return new Response(JSON.stringify({ data: { Page: { media: [media({ id: 154587, title: { english: 'Frieren', romaji: 'Sousou no Frieren' } })] } } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      const res = await handleApi(new Request('https://relay.test/api/tmdb?action=anime&list=trending', { headers: { origin: 'https://app.test' } }), {}, {});
      const body = await res.json() as { results: TmdbItem[] };
      expect(res.status).toBe(200);
      expect(body.results[0]).toMatchObject({ title: 'Frieren', imdbId: 'tt22248376' });
      expect(res.headers.get('cache-control')).toMatch(/max-age=10800/);
    } finally { globalThis.fetch = real; }
  });
  it('an unknown list is refused', async () => {
    const { handleApi } = await import('@/lib/server/handlers');
    const res = await handleApi(new Request('https://relay.test/api/tmdb?action=anime&list=bogus', { headers: { origin: 'https://app.test' } }), {}, {});
    expect(res.status).toBe(400);
  });
});
