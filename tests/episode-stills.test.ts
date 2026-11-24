import { describe, expect, it, vi } from 'vitest';
import { addTvmazeStills, matchStills, type TvmazeEpisode } from '@/lib/server/tvmaze';
import type { TmdbEpisode } from '@/lib/types';

const ep = (n: number, name: string, airDate?: string): TmdbEpisode => ({ episodeNumber: n, name, overview: '', stillPath: `https://episodes.metahub.space/x/2/${n}/w780.jpg`, airDate });
const tv = (name: string, airdate: string, img: string | null): TvmazeEpisode => ({ name, airdate, image: img ? { medium: `m/${img}`, original: `o/${img}` } : null });

describe('episode pictures from TVmaze when the usual source has none', () => {
  it('matches by the day it aired (TVmaze groups anime seasons by year, so numbers differ)', () => {
    // One Piece: the catalog's S2 E1 is TVmaze's 2000 E1; both aired 12 January 2000.
    const got = matchStills(
      [ep(1, 'The Honorable Liar? Captain Usopp!', '2000-01-12T14:15:00.000Z'), ep(2, 'The Weirdest Guy Ever!', '2000-01-19T14:15:00.000Z')],
      [tv('Something Else', '2000-01-05', 'a'), tv('The Honorable Liar? Captain Usopp!', '2000-01-12', 'b'), tv('The Weirdest Guy Ever! Jango the Hypnotist!', '2000-01-19', 'c')],
    );
    expect(got).toEqual(['o/b', 'o/c']);
  });

  it('a day apart (time zones): still found, and the name decides between neighbours', () => {
    const got = matchStills([ep(1, 'Pilot', '2020-03-01T23:30:00.000Z')], [tv('Other', '2020-03-01', 'x'), tv('Pilot', '2020-03-02', 'p')]);
    expect(got).toEqual(['o/p']);
  });

  it('two episodes on the same day keep their order', () => {
    const got = matchStills([ep(1, 'A', '2021-05-01T10:00:00Z'), ep(2, 'B', '2021-05-01T10:30:00Z')], [tv('Part 1', '2021-05-01', '1'), tv('Part 2', '2021-05-01', '2')]);
    expect(got).toEqual(['o/1', 'o/2']);
  });

  it('no date and no matching name, or no picture: nothing', () => {
    expect(matchStills([ep(1, 'Lost'), ep(2, 'Found', '2021-01-01')], [tv('Found', '2021-01-01', null), tv('Else', '2019-01-01', 'z')])).toEqual([undefined, undefined]);
  });

  it('adds them to a season as a second choice, keeping the usual picture first', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/lookup/shows?imdb=tt0388629')) return new Response(JSON.stringify({ id: 1505 }), { status: 200 });
      if (url.includes('/shows/1505/episodes')) return new Response(JSON.stringify([tv('Liar', '2000-01-12', 'b')]), { status: 200 });
      return new Response('', { status: 404 });
    });
    const eps = await addTvmazeStills('tt0388629', [ep(1, 'Liar', '2000-01-12T14:15:00Z')], fetch as unknown as typeof globalThis.fetch);
    expect(eps[0]).toMatchObject({ stillPath: 'https://episodes.metahub.space/x/2/1/w780.jpg', stillAlt: 'o/b' });
  });

  it('TVmaze unreachable or the show unknown there: the season comes back unchanged', async () => {
    const eps = [ep(1, 'Liar', '2000-01-12')];
    expect(await addTvmazeStills('tt1', eps, (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toEqual(eps);
    expect(await addTvmazeStills('tt1', eps, (async () => new Response('', { status: 404 })) as unknown as typeof fetch)).toEqual(eps);
  });
});
