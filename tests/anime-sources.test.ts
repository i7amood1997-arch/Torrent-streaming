import { afterEach, describe, expect, it, vi } from 'vitest';
import { kitsuTarget } from '@/lib/server/anime-kitsu';
import { searchTorrents, configFromEnv } from '@/lib/torrent-indexer';

const MAP = {
  '0388629': ['12:'],                                            // One Piece: one long entry, numbered straight through
  '0434665': ['244:', '43078:17'],                               // Bleach: long entry, then TYBW as season 17
  '2560140': ['7442:1', '8671:2', '13569:3', '41982:3'],         // Attack on Titan: one entry per season
};

describe('anime: which Kitsu entry and episode to ask for', () => {
  it('a long-running show: its main entry, with the episode numbered straight through', () => {
    expect(kitsuTarget('tt0388629', 2, 1, 9, MAP)).toMatchObject({ id: 12, episode: 9 });     // One Piece S2 E1 = episode 9
    expect(kitsuTarget('tt0434665', 8, 1, 152, MAP)).toMatchObject({ id: 244, episode: 152 });
  });
  it('a season with its own entry: that entry, with the season’s episode number', () => {
    expect(kitsuTarget('tt2560140', 2, 5, 30, MAP)).toMatchObject({ id: 8671, episode: 5 });
    expect(kitsuTarget('tt0434665', 17, 3, 369, MAP)).toMatchObject({ id: 43078, episode: 3 });
  });
  it('season 1 of a long-running show works without the straight-through number', () => {
    expect(kitsuTarget('tt0388629', 1, 4, undefined, MAP)).toMatchObject({ id: 12, episode: 4 });
  });
  it('not anime, or a later season with no number to go by: nothing (the usual search runs)', () => {
    expect(kitsuTarget('tt0903747', 1, 1, 1, MAP)).toBeUndefined();
    expect(kitsuTarget('tt0388629', 2, 1, undefined, MAP)).toBeUndefined();
  });
  it('the real list knows One Piece and Bleach', () => {
    expect(kitsuTarget('tt0388629', 2, 1, 9)).toMatchObject({ id: 12, episode: 9 });
    expect(kitsuTarget('tt0434665', 8, 1, 152)).toMatchObject({ id: 244, episode: 152 });
  });
});

describe('anime: Torrentio is asked by Kitsu id', () => {
  const stream = (title: string, hash: string) => ({ name: 'Torrentio\n1080p', title: `${title}\n👤 50 💾 1.2 GB`, infoHash: hash });
  const respond = (fn: (url: string) => unknown) => vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) => new Response(JSON.stringify(fn(String(u))), { status: 200, headers: { 'content-type': 'application/json' } })));
  afterEach(() => vi.unstubAllGlobals());
  const cfg = () => ({ ...configFromEnv({}), enabled: ['torrentio' as const] });

  it('anime releases for the right episode, not the live-action show of the same name', async () => {
    const asked: string[] = [];
    respond((url) => {
      asked.push(url);
      return url.includes('kitsu:12:9') ? { streams: [stream('[SubsPlease] One Piece - 009 (1080p)', 'a'.repeat(40))] } : { streams: [stream('One.Piece.2023.S02E01.1080p.NF.WEB-DL', 'b'.repeat(40))] };
    });
    const r = await searchTorrents({ imdbId: 'tt0388629', type: 'series', season: 2, episode: 1, title: 'One Piece', kitsu: { id: 12, episode: 9 } }, cfg());
    expect(asked.some((u) => u.includes('/stream/series/kitsu:12:9.json'))).toBe(true);
    expect(r.results.map((x) => x.title)).toEqual(['[SubsPlease] One Piece - 009 (1080p)']);
  });
  it('nothing under the Kitsu id: the usual IMDb search instead', async () => {
    respond((url) => (url.includes('kitsu:') ? { streams: [] } : { streams: [stream('Some.Show.S02E01.1080p', 'c'.repeat(40))] }));
    const r = await searchTorrents({ imdbId: 'tt0388629', type: 'series', season: 2, episode: 1, kitsu: { id: 12, episode: 9 } }, cfg());
    expect(r.results).toHaveLength(1);
  });
});

describe('anime: text searches', () => {
  it('use the anime episode number, not S02E01 (which finds the live-action show)', async () => {
    const { textQueryFor } = await import('@/lib/torrent-indexer');
    expect(textQueryFor({ title: 'One Piece', type: 'series', season: 2, episode: 1, kitsu: { id: 12, episode: 9 } })).toBe('One Piece 09');
    expect(textQueryFor({ title: 'Bleach', type: 'series', season: 8, episode: 1, kitsu: { id: 244, episode: 152 } })).toBe('Bleach 152');
    expect(textQueryFor({ title: 'Breaking Bad', type: 'series', season: 2, episode: 1 })).toBe('Breaking Bad S02E01');
  });
});

describe('anime numbered straight through: releases of another show are dropped', () => {
  const stream = (title: string, hash: string) => ({ name: 'Torrentio\n1080p', title: `${title}\n👤 50 💾 1.2 GB`, infoHash: hash });
  afterEach(() => vi.unstubAllGlobals());
  it('One Piece: the 2023 live-action series is left out, the anime releases stay', async () => {
    const titles = ['One.Piece.2023.S02.1080p.NF.WEB-DL', 'ONE PIECE S02E01 THE BEGINNING AND THE END 1080p NF WEB-DL', '[SubsPlease] One Piece - 009 (1080p)', '[Anime Time] One Piece (0001-1071+Movies+Specials) [BD+CR] [1080p]'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ streams: titles.map((t, i) => stream(t, String(i).repeat(40))) }), { status: 200 })));
    const cfg = { ...configFromEnv({}), enabled: ['torrentio' as const] };
    const r = await searchTorrents({ imdbId: 'tt0388629', type: 'series', season: 2, episode: 1, year: 1999, title: 'One Piece', kitsu: { id: 12, episode: 9, straight: true } }, cfg);
    expect(r.results.map((x) => x.title).sort()).toEqual(['[Anime Time] One Piece (0001-1071+Movies+Specials) [BD+CR] [1080p]', '[SubsPlease] One Piece - 009 (1080p)']);
  });
  it('a seasonal anime keeps its season-numbered releases', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ streams: [stream('Attack.on.Titan.S02E05.1080p', 'a'.repeat(40))] }), { status: 200 })));
    const cfg = { ...configFromEnv({}), enabled: ['torrentio' as const] };
    const r = await searchTorrents({ imdbId: 'tt2560140', type: 'series', season: 2, episode: 5, year: 2013, kitsu: { id: 8671, episode: 5, straight: false } }, cfg);
    expect(r.results).toHaveLength(1);
  });
  it('the Kitsu target says whether the show is numbered straight through', () => {
    expect(kitsuTarget('tt0388629', 2, 1, 9)).toEqual({ id: 12, episode: 9, straight: true });
    expect(kitsuTarget('tt2560140', 2, 5, 30)).toMatchObject({ straight: false });
  });
});
