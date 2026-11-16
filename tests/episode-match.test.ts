import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { absoluteEpisode, episodeMatch } from '@/lib/subtitle-parser';
import { encodeToken, fetchSubtitleCues } from '@/lib/subtitles';

afterEach(() => vi.unstubAllGlobals());

// Attack on Titan: seasons of 25, 12, 22 episodes, so S04E06 is episode 65 counted from the start.
const seasons = [{ seasonNumber: 0, episodeCount: 9 }, { seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }, { seasonNumber: 3, episodeCount: 22 }, { seasonNumber: 4, episodeCount: 30 }];
const ref = { season: 4, episode: 6, abs: 65 };

describe('which episode a subtitle is for', () => {
  it('counts an episode from the start of the show (specials excluded)', () => {
    expect(absoluteEpisode(seasons, 4, 6)).toBe(65);
    expect(absoluteEpisode(seasons, 1, 3)).toBe(3);
    expect(absoluteEpisode([{ seasonNumber: 2, episodeCount: 12 }], 2, 1)).toBeUndefined(); // season 1 unknown
  });

  it('tells anime-numbered subtitles apart (the list in the screenshot)', () => {
    expect(episodeMatch('Shingeki no Kyojin - The Final Season - 60', ref)).toBe(-1);
    expect(episodeMatch('Shingeki no Kyojin - The Final Season - 64', ref)).toBe(-1);
    expect(episodeMatch('Shingeki no Kyojin - The Final Season - 65', ref)).toBe(1);
    expect(episodeMatch('Shingeki no Kyojin (The Final Season) - 60-75', ref)).toBe(0); // a pack that contains it
    expect(episodeMatch('Shingeki no Kyojin: The Final Season - 01 [Crunchyroll]', ref)).toBe(-1);
    expect(episodeMatch('[SubsPlease] Shingeki no Kyojin (The Final Season) - 65v2 (1080p) [ABCD1234]', ref)).toBe(1);
  });

  it('understands the usual TV styles', () => {
    expect(episodeMatch('Attack.on.Titan.S04E06.The.War.Hammer.Titan.WEBRip.Netflix', ref)).toBe(1);
    expect(episodeMatch('Attack.on.Titan.S04E07.1080p.WEB', ref)).toBe(-1);
    expect(episodeMatch('Attack on Titan 4x06 720p', ref)).toBe(1);
    expect(episodeMatch('Attack on Titan S01E65', ref)).toBe(1); // absolute numbering written as a season-1 episode
    expect(episodeMatch('Show.S02E01-E10.Complete', { season: 2, episode: 4 })).toBe(0);
    expect(episodeMatch('Show - 205 - Title', { season: 2, episode: 5, abs: 18 })).toBe(1);
  });

  it('does not guess when it cannot tell', () => {
    expect(episodeMatch('Attack on Titan S4 - Episode 06', ref)).toBe(0); // "06" could be season 1's sixth
    expect(episodeMatch('Attack on Titan The Final Season BluRay 1080p', ref)).toBe(0);
    expect(episodeMatch('Some Movie - 2019 - 1080p', ref)).toBe(0); // a year and a resolution, not episodes
    expect(episodeMatch('Show - 07', { season: 3, episode: 2 })).toBe(0); // no absolute number known: may be either
    expect(episodeMatch('Movie.2020.1080p', {})).toBe(0);
  });

  it('season 1 needs no absolute number', () => {
    expect(episodeMatch('Frieren - 03', { season: 1, episode: 3 })).toBe(1);
    expect(episodeMatch('Frieren - 04', { season: 1, episode: 3 })).toBe(-1);
  });
});

describe('subtitle packs', () => {
  const srt = (t: string) => strToU8(`1\n00:00:01,000 --> 00:00:02,000\n${t}\n`);
  const serve = (files: Record<string, Uint8Array>) => {
    const zip = zipSync(files);
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) }));
  };
  const token = encodeToken({ p: 'subdl', url: '/subtitle/1-2.zip', lang: 'ar', season: 4, episode: 6, abs: 65 });

  it('takes this episode’s file out of an anime-numbered pack', async () => {
    serve({ 'Shingeki no Kyojin - 64.srt': srt('wrong'), 'Shingeki no Kyojin - 65.srt': srt('right'), 'Shingeki no Kyojin - 66.srt': srt('wrong') });
    expect((await fetchSubtitleCues(token, {}))[0].text).toBe('right');
  });

  it('refuses a pack that only holds other episodes instead of showing the wrong one', async () => {
    serve({ 'Shingeki no Kyojin - 60.srt': srt('a'), 'Shingeki no Kyojin - 61.srt': srt('b') });
    await expect(fetchSubtitleCues(token, {})).rejects.toThrow(/doesn’t contain this episode/);
  });
});

describe('subtitle search for an episode', () => {
  it('flags another episode’s subtitle so it is never chosen automatically, and puts the right one first', async () => {
    const { searchSubtitles } = await import('@/lib/subtitles');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ subtitles: [
      { id: '1', url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1', lang: 'ara', movieReleaseName: 'Shingeki no Kyojin - The Final Season - 60' },
      { id: '2', url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/2', lang: 'ara', movieReleaseName: 'Shingeki no Kyojin - The Final Season - 65' },
    ] })));
    const { tracks } = await searchSubtitles({ imdbId: 'tt2560140', type: 'series', season: 4, episode: 6, absEpisode: 65, releaseName: 'Shingeki no Kyojin The Final Season 65', langs: ['ar'] }, {});
    expect(tracks.map((t) => [t.releaseName?.slice(-2), !!t.otherEpisode])).toEqual([['65', false], ['60', true]]);
  });
});
