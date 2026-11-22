/**
 * New episodes of the shows you follow: the series in My List, and the ones you've been watching
 * (Continue Watching). Used by the Home row "New Episodes" and by the relay's notifications.
 */
import { values, type SyncState } from './sync';
import type { TmdbDetails, TmdbItem } from './types';

export interface Followed {
  /** How to ask for its details: a TMDB id, or the numeric part of an IMDb id (keyless catalog). */
  tmdbId?: number;
  imdbId?: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  /** The furthest episode watched, if any. */
  watched?: { season: number; episode: number };
}

const later = (a: { season: number; episode: number }, b: { season: number; episode: number }) =>
  a.season > b.season || (a.season === b.season && a.episode > b.episode);

/** The series followed, from the shared state (newest interest first), at most `max`. */
export function followedSeries(s: SyncState, max = 20): Followed[] {
  const out = new Map<string, Followed>();
  const key = (tmdbId?: number, imdbId?: string) => (tmdbId ? `t${tmdbId}` : imdbId ? `i${imdbId}` : '');
  type H = { type?: string; tmdbId?: number; imdbId?: string; title: string; season?: number; episode?: number; poster?: string; backdrop?: string };
  for (const { v } of values<H>(s, 'history')) {
    if (v.type !== 'series' || v.season == null || v.episode == null) continue;
    const k = key(v.tmdbId, v.imdbId);
    if (!k) continue;
    const cur = out.get(k) ?? { tmdbId: v.tmdbId, imdbId: v.imdbId, title: v.title, poster: v.poster };
    const ep = { season: v.season, episode: v.episode };
    if (!cur.watched || later(ep, cur.watched)) cur.watched = ep;
    out.set(k, cur);
  }
  for (const { v } of values<TmdbItem>(s, 'watchlist')) {
    if (v.type !== 'series') continue;
    const tmdbId = v.source === 'cinemeta' ? undefined : v.id;
    const k = key(tmdbId, v.imdbId);
    if (!k || out.has(k)) continue;
    out.set(k, { tmdbId, imdbId: v.imdbId, title: v.title, poster: v.posterPath, backdrop: v.backdropPath });
  }
  return [...out.values()].slice(0, max);
}

const DAY = 86_400_000;

/**
 * Is the latest aired episode news for this viewer? It aired in the last `days` days, and they
 * haven't watched it (or anything after it).
 */
export function newEpisode(f: Followed, d: Pick<TmdbDetails, 'lastAired'>, now = Date.now(), days = 14): TmdbDetails['lastAired'] | undefined {
  const last = d.lastAired;
  if (!last?.airDate) return undefined;
  const aired = Date.parse(`${last.airDate}T00:00:00Z`);
  if (!Number.isFinite(aired) || aired > now || now - aired > days * DAY) return undefined;
  if (f.watched && !later(last, f.watched)) return undefined;
  return last;
}

/** The id the details endpoint takes for this show, given what the relay can look up. */
export function detailsId(f: Followed, relayHasTmdb: boolean): number | undefined {
  if (relayHasTmdb) return f.tmdbId;
  const m = f.imdbId?.match(/^tt(\d+)$/);
  return m ? Number(m[1]) : undefined;
}
