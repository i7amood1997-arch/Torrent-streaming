/**
 * "Next episode": which one comes next (the following episode, or the first of the next season,
 * only if it has aired), and the stream to play for it, picked the way the title page picks.
 */
import { api } from './client-api';
import { seriesPrefs } from './library';
import { audioPlayable, canPlayMkv } from './platform';
import { pickBest } from './result-filters';
import { hasDebrid, useApp, type PlayRequest } from './store';
import type { TmdbEpisode, TorrentResult } from './types';

export interface NextEp { season: number; episode: number; name: string; still?: string | null }

const aired = (e: TmdbEpisode, today: string) => !e.airDate || e.airDate <= today;

/** Pure part: given the current season's episodes (and the next season's, if fetched). */
export function pickNext(season: number, episode: number, eps: TmdbEpisode[], nextSeasonEps: TmdbEpisode[] | undefined, today: string): NextEp | undefined {
  if (!eps.length) return undefined; // this season's list didn't come: can't tell it has ended
  const later = eps.filter((e) => e.episodeNumber > episode && aired(e, today)).sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
  if (later) return { season, episode: later.episodeNumber, name: later.name, still: later.stillPath };
  if (eps.some((e) => e.episodeNumber > episode)) return undefined; // the rest hasn't aired yet
  const first = nextSeasonEps?.filter((e) => aired(e, today)).sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
  return first ? { season: season + 1, episode: first.episodeNumber, name: first.name, still: first.stillPath } : undefined;
}

/**
 * The id the relay's catalog knows this show by: its TMDB id when the relay has a TMDB key,
 * otherwise the number in its IMDb id (the keyless catalog's ids).
 */
export function catalogId(r: Pick<PlayRequest, 'tmdbId' | 'imdbId'>, relayHasTmdb: boolean): number | undefined {
  if (relayHasTmdb && r.tmdbId) return r.tmdbId;
  const m = r.imdbId?.match(/^tt(\d+)$/);
  return m ? Number(m[1]) : relayHasTmdb ? undefined : r.tmdbId;
}

export async function findNext(r: PlayRequest): Promise<NextEp | undefined> {
  const id = catalogId(r, !!useApp.getState().caps?.tmdb);
  if (r.type !== 'series' || !id || r.season == null || r.episode == null) return undefined;
  const today = new Date().toISOString().slice(0, 10);
  const cur = (await api.tmdbSeason(id, r.season))?.episodes ?? [];
  const needNextSeason = cur.length > 0 && !cur.some((e) => e.episodeNumber > r.episode!);
  const nxt = needNextSeason ? (await api.tmdbSeason(id, r.season + 1).catch(() => undefined))?.episodes : undefined;
  return pickNext(r.season, r.episode, cur, nxt, today);
}

/** The stream to play for it, or undefined when none was found. */
export async function streamFor(r: PlayRequest, n: NextEp, signal?: AbortSignal): Promise<TorrentResult | undefined> {
  const res = await api.search({ imdb: r.imdbId, tmdb: r.tmdbId, type: 'series', season: n.season, episode: n.episode, title: r.title }, signal);
  const st = useApp.getState();
  return pickBest(res.results ?? [], { debrid: hasDebrid(st.settings, st.caps), preferMp4: !canPlayMkv(), audioOk: audioPlayable, preferQuality: seriesPrefs(r.tmdbId)?.quality });
}

/** Start it, as if picked on the title page. */
export function playNext(r: PlayRequest, n: NextEp, best: TorrentResult) {
  useApp.getState().play({
    kind: best.url ? 'url' : 'torrent', url: best.url, result: best, title: r.title, imdbId: r.imdbId, tmdbId: r.tmdbId, type: 'series',
    season: n.season, episode: n.episode, absEpisode: r.absEpisode != null && n.season === r.season ? r.absEpisode + (n.episode - r.episode!) : undefined,
    poster: r.poster, backdrop: n.still ?? r.backdrop,
  });
}
