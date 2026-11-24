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

describe('releases that are clearly wrong are left out', () => {
  const q = { imdbId: 'tt0388629', type: 'series' as const, season: 2, episode: 1, year: 1999, kitsu: { id: 12, episode: 9, straight: true } };
  const r = (title: string) => ({ title, season: undefined, year: undefined } as never);
  it('adult releases, in any search', async () => {
    const { adultRelease } = await import('@/lib/torrent-indexer');
    expect(adultRelease('Nubiles 24 09 20 Megan Moore One Piece XXX 2160p MP4 WRB [XC]')).toBe(true);
    expect(adultRelease('One.Piece.S01E01.1080p.WEB')).toBe(false);
    expect(adultRelease('Xxx Return of Xander Cage 2017 1080p')).toBe(false);
  });
  it('anime: a single episode number that isn’t the one asked for', async () => {
    const { anotherShow } = await import('@/lib/torrent-indexer');
    expect(anotherShow(r('[SubsPlease] One Piece - 1180 (720p) [09481FEB].mkv'), q)).toBe(true);
    expect(anotherShow(r('[SubsPlease] One Piece - 009 (1080p)'), q)).toBe(false);
    expect(anotherShow(r('[Erai-raws] One Piece - 09v2 [1080p]'), q)).toBe(false);
  });
  it('anime: a range of episodes that doesn’t include it', async () => {
    const { anotherShow } = await import('@/lib/torrent-indexer');
    expect(anotherShow(r('[Judas] One Piece 001-574 [1080p][HEVC x265 10bit]'), q)).toBe(false);
    expect(anotherShow(r('[Anime Time] One Piece (0001-1071+Movies+Specials) [BD+CR] [1080p]'), q)).toBe(false);
    expect(anotherShow(r('[Judas] One Piece 575-891 [1080p]'), q)).toBe(true);
    expect(anotherShow(r('[Anime Time] One Piece - Season 1 - East Blue (Fixed) [1080p]'), q)).toBe(false); // no number: kept
  });

  it('a season range isn’t an episode range (seasonal anime packs are kept)', async () => {
    const { anotherShow } = await import('@/lib/torrent-indexer');
    const aot = { imdbId: 'tt2560140', type: 'series' as const, season: 2, episode: 5, kitsu: { id: 8671, episode: 5, straight: false } };
    expect(anotherShow(r('[Trix] Shingeki no Kyojin (S01-04 + OVAs) (COMPLETE) [Dual Audio] (BD 1080p)'), aot)).toBe(false);
    expect(anotherShow(r('[Anime Time] Attack On Titan (Complete Collection) (S01-S04+OVA+Movies)'), aot)).toBe(false);
    expect(anotherShow(r('Attack on Titan Seasons 1-4 Complete'), aot)).toBe(false);
  });

  it('a seasonal anime: a release of another season (named in words) is left out', async () => {
    const { anotherShow } = await import('@/lib/torrent-indexer');
    const fr = { imdbId: 'tt22248376', type: 'series' as const, season: 1, episode: 5, kitsu: { id: 46474, episode: 5, straight: false } };
    expect(anotherShow(r('[Erai-raws] Sousou no Frieren 2nd Season - 05 [1080p CR WEB-DL AVC AAC]'), fr)).toBe(true);
    expect(anotherShow(r('[Erai-raws]-Sousou-no-Frieren-2nd-Season--05-[720p-CR-WEB-DL-AVC-AAC]'), fr)).toBe(true);
    expect(anotherShow(r('[SubsPlease] Sousou no Frieren - 05 (1080p) [8E3F8FA5].mkv'), fr)).toBe(false);
    expect(anotherShow(r('[Feibanyama] Frieren Beyond Journeys End Season 1 [IQIYI Web]'), fr)).toBe(false);
  });
});
