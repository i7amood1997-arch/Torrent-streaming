import { describe, expect, it, vi } from 'vitest';
import { loadAnimeRow } from '@/lib/anime-client';

const item = { id: 22248376, type: 'series' as const, title: 'Frieren', overview: '', imdbId: 'tt22248376' };

describe('Anime rows in the app', () => {
  it('the relay answered: its titles are used', async () => {
    const r = await loadAnimeRow('trending', { relayGet: async () => ({ results: [item] }), anilist: vi.fn(), relayLink: vi.fn() });
    expect(r.results).toEqual([item]);
  });

  it('the relay was turned away: asks AniList from this device, then has the relay link the answer', async () => {
    const ask = { url: 'https://graphql.anilist.co', query: 'q', variables: { sort: ['TRENDING_DESC'] } };
    const media = [{ id: 154587 }];
    const anilist = vi.fn(async () => ({ data: { Page: { media } } }));
    const relayLink = vi.fn(async () => ({ results: [item] }));
    const r = await loadAnimeRow('trending', { relayGet: async () => ({ ask }), anilist, relayLink });
    expect(anilist).toHaveBeenCalledWith(ask);
    expect(relayLink).toHaveBeenCalledWith('trending', media);
    expect(r.results).toEqual([item]);
  });

  it('AniList also fails: the error comes through (the row stays hidden)', async () => {
    const ask = { url: 'https://graphql.anilist.co', query: 'q', variables: {} };
    await expect(loadAnimeRow('top', { relayGet: async () => ({ ask }), anilist: async () => { throw new Error('AniList answered HTTP 429'); }, relayLink: vi.fn() })).rejects.toThrow('429');
  });
});
