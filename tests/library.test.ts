import { beforeEach, describe, expect, it } from 'vitest';
import { applySeriesPrefs, rememberSeries, resumePosition, savePosition, seriesPrefs, toggleWatchlist, watchKey } from '@/lib/library';
import { rankResults } from '@/lib/result-filters';
import { DEFAULT_SETTINGS, historyKey, useApp, type PlayRequest } from '@/lib/store';
import { emptyState, mergeState, values } from '@/lib/sync';
import type { TmdbItem, TorrentResult } from '@/lib/types';

const ep = (n: number, file: string): PlayRequest => ({ kind: 'torrent', title: 'Severance', tmdbId: 95396, type: 'series', season: 2, episode: n, result: { id: file } as TorrentResult, nonce: 1 });
const show: TmdbItem = { id: 95396, type: 'series', title: 'Severance', overview: 'x'.repeat(2000), posterPath: '/p.jpg' };

beforeEach(() => useApp.setState({ syncState: emptyState(), history: [], settings: structuredClone(DEFAULT_SETTINGS) }));

describe('library shared between devices', () => {
  it('the same episode is the same entry on every device, whatever file plays', () => {
    expect(historyKey(ep(3, 'hashA'))).toBe(historyKey(ep(3, 'hashB')));
    expect(historyKey(ep(3, 'hashA'))).not.toBe(historyKey(ep(4, 'hashA')));
  });

  it('resume: the TV starts where the phone stopped, even with another file', () => {
    savePosition(ep(3, 'phoneFile'), 'phoneFile', 1234, 3000, true);
    // The phone's state reaches the TV through the relay:
    const phoneState = useApp.getState().syncState;
    useApp.setState({ syncState: emptyState() });
    useApp.getState().applyRemote(phoneState);
    expect(resumePosition(ep(3, 'tvFile'), 'tvFile')).toBe(1234);
  });

  it('resume: a finished episode starts from the beginning next time', () => {
    savePosition(ep(3, 'f'), 'f', 2950, 3000, true);
    expect(resumePosition(ep(3, 'other'), 'other')).toBe(0);
  });

  it('positions are shared at most every 30 s while playing (not on every tick)', () => {
    let changes = 0;
    const off = useApp.subscribe((s, p) => { if (s.syncState !== p.syncState) changes++; });
    for (let t = 100; t < 160; t += 5) savePosition(ep(5, 'f'), 'f', t, 3000);
    off();
    expect(changes).toBe(2); // 100 and 130
  });

  it('watchlist: add, remove, and the removal reaches other devices', () => {
    toggleWatchlist(show);
    const saved = useApp.getState().syncState.watchlist[watchKey(show)].v as TmdbItem;
    expect(saved.title).toBe('Severance');
    expect(saved.overview.length).toBeLessThanOrEqual(300); // kept small
    const withIt = useApp.getState().syncState;
    toggleWatchlist(show);
    const removedHere = useApp.getState().syncState;
    // Another device still has it (older): after merging, it's gone everywhere.
    expect(values(mergeState(withIt, removedHere), 'watchlist')).toEqual([]);
  });

  it('history from another device merges in without losing what changed here meanwhile', () => {
    useApp.getState().play(ep(1, 'a'));
    const remote = mergeState(undefined, { history: { [historyKey(ep(2, 'b'))]: { at: Date.now() - 60_000, v: ep(2, 'b') } } });
    useApp.getState().applyRemote(remote);
    expect(useApp.getState().history.map((h) => h.episode)).toEqual([1, 2]);
  });

  it('a series brings back its subtitle choices, and prefers the quality played last', () => {
    rememberSeries(95396, { lang: 'en', dual: false, quality: '720p' });
    useApp.getState().updateSubtitleStyle({ primaryLang: 'ar', dual: true });
    applySeriesPrefs({ type: 'series', tmdbId: 95396 });
    expect(useApp.getState().settings.subtitle.primaryLang).toBe('en');
    expect(useApp.getState().settings.subtitle.dual).toBe(false);
    applySeriesPrefs({ type: 'movie', tmdbId: 95396 }); // movies are left alone
    const r = (id: string, quality: string): TorrentResult => ({ id, infoHash: id, magnet: 'magnet:?', title: id, seeders: 500, leechers: 1, quality, hdr: [], remux: false, sizeBytes: 2e9 } as unknown as TorrentResult);
    const list = [r('a1080', '1080p'), r('b720', '720p')];
    expect(rankResults(list)[0].id).toBe('a1080');
    expect(rankResults(list, { preferQuality: seriesPrefs(95396)?.quality })[0].id).toBe('b720');
  });
});
