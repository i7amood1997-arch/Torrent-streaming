import { describe, expect, it } from 'vitest';
import { handleApi, parseSegments } from '@/lib/server/handlers';
import { pickNext } from '@/lib/next-episode';

describe('intro / recap / credits times', () => {
  it('reads TheIntroDB answers into seconds', () => {
    expect(parseSegments({ intro: [{ start_ms: 62000, end_ms: 92500 }], recap: [{ start_ms: null, end_ms: 45000 }], credits: [{ start_ms: 2580000, end_ms: null }] }))
      .toEqual({ intro: { start: 62, end: 92.5 }, recap: { start: 0, end: 45 }, credits: { start: 2580 } });
  });

  it('a segment confirmed absent (0/0) or broken is not a skip from start to end', () => {
    expect(parseSegments({ intro: [{ start_ms: 0, end_ms: 0 }], credits: [{ start_ms: 0, end_ms: 0 }] })).toEqual({});
    expect(parseSegments({ intro: [{ start_ms: 50000, end_ms: 40000 }] })).toEqual({});
    expect(parseSegments(null)).toEqual({});
  });

  it('asks for an episode by its TMDB id with season and episode, and never by an IMDb id', async () => {
    const asked: string[] = [];
    const introFetch = (async (u: string) => { asked.push(u); return new Response(JSON.stringify({ intro: [{ start_ms: 1000, end_ms: 31000 }] })); }) as unknown as typeof fetch;
    const r = await handleApi(new Request('https://relay.test/api/segments?tmdb=95396&type=series&season=2&episode=3&duration=3300.5'), {}, { introFetch });
    expect(await r.json()).toEqual({ intro: { start: 1, end: 31 } });
    expect(asked[0]).toBe('https://api.theintrodb.org/v4/media?tmdb_id=95396&season=2&episode=3&duration_ms=3300500');
    const none = await handleApi(new Request('https://relay.test/api/segments?imdb=tt11280740&type=series&season=2&episode=3'), {}, { introFetch });
    expect(await none.json()).toEqual({});
    expect(asked).toHaveLength(1);
  });

  it('a failing lookup just means no skip button', async () => {
    const introFetch = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
    const r = await handleApi(new Request('https://relay.test/api/segments?tmdb=1&type=movie'), {}, { introFetch });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
  });
});

describe('which episode is next', () => {
  const ep = (n: number, airDate?: string) => ({ episodeNumber: n, name: `E${n}`, overview: '', airDate });
  it('the following episode of the season', () => {
    expect(pickNext(1, 3, [ep(1), ep(2), ep(3), ep(4)], undefined, '2026-11-22')).toMatchObject({ season: 1, episode: 4 });
  });
  it('the first episode of the next season after a finale', () => {
    expect(pickNext(1, 4, [ep(3), ep(4)], [ep(1), ep(2)], '2026-11-22')).toMatchObject({ season: 2, episode: 1 });
  });
  it('nothing when the next one has not aired yet', () => {
    expect(pickNext(1, 3, [ep(3), ep(4, '2027-01-10')], undefined, '2026-11-22')).toBeUndefined();
    expect(pickNext(1, 4, [ep(4)], [ep(1, '2027-03-01')], '2026-11-22')).toBeUndefined();
    expect(pickNext(1, 4, [ep(4)], undefined, '2026-11-22')).toBeUndefined();
  });
});
