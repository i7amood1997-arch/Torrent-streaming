/**
 * The user's library, kept in the synced state (lib/sync.ts) so every device shares it:
 *  - Watchlist ("My List").
 *  - Per-series settings: the subtitle language and dual-language choice made while watching a
 *    show come back for its next episode, and the picture quality played last is preferred.
 *  - Resume positions, by title/episode (not by file), so another device carries on.
 */
import { values } from './sync';
import { historyKey, useApp, type PlayRequest } from './store';
import type { TmdbItem } from './types';

// ── Watchlist ───────────────────────────────────────────────────────────────

export const watchKey = (item: Pick<TmdbItem, 'type' | 'id'>) => `${item.type}:${item.id}`;

/** Only what a poster needs (keeps the synced state small). */
function slim(item: TmdbItem): TmdbItem {
  const { id, type, title, year, posterPath, backdropPath, overview, rating, imdbId, source } = item;
  return { id, type, title, year, posterPath, backdropPath, overview: overview?.slice(0, 300) ?? '', rating, imdbId, source };
}

export function useInWatchlist(item: Pick<TmdbItem, 'type' | 'id'>): boolean {
  return useApp((s) => s.syncState.watchlist[watchKey(item)]?.v !== undefined);
}

export function toggleWatchlist(item: TmdbItem) {
  const st = useApp.getState();
  const k = watchKey(item);
  st.touch('watchlist', k, st.syncState.watchlist[k]?.v !== undefined ? undefined : slim(item));
}

/** Newest first. */
export function useWatchlist(): TmdbItem[] {
  const wl = useApp((s) => s.syncState.watchlist);
  return values<TmdbItem>({ history: {}, prefs: {}, progress: {}, watchlist: wl }, 'watchlist').map((x) => x.v);
}

// ── Per-series settings ─────────────────────────────────────────────────────

export interface SeriesPrefs {
  /** Main subtitle language. */
  lang?: 'ar' | 'en';
  /** Both languages on screen. */
  dual?: boolean;
  /** Quality tier last played (e.g. '1080p'), preferred for the next episode. */
  quality?: string;
}

export const seriesKey = (tmdbId: number | undefined) => (tmdbId ? `series:${tmdbId}` : undefined);

export function seriesPrefs(tmdbId: number | undefined): SeriesPrefs | undefined {
  const k = seriesKey(tmdbId);
  return k ? (useApp.getState().syncState.prefs[k]?.v as SeriesPrefs | undefined) : undefined;
}

export function rememberSeries(tmdbId: number | undefined, patch: SeriesPrefs) {
  const k = seriesKey(tmdbId);
  if (!k) return;
  const cur = seriesPrefs(tmdbId) ?? {};
  const next = { ...cur, ...patch };
  if (JSON.stringify(next) !== JSON.stringify(cur)) useApp.getState().touch('prefs', k, next);
}

/** Starting an episode of a series: bring back the subtitle choices made for it last time. */
export function applySeriesPrefs(r: Pick<PlayRequest, 'type' | 'tmdbId'>) {
  if (r.type !== 'series') return;
  const p = seriesPrefs(r.tmdbId);
  if (!p) return;
  const st = useApp.getState();
  const sub = st.settings.subtitle;
  const patch: Partial<typeof sub> = {};
  if (p.lang && p.lang !== sub.primaryLang) patch.primaryLang = p.lang;
  if (p.dual != null && p.dual !== sub.dual) patch.dual = p.dual;
  if (Object.keys(patch).length) st.updateSubtitleStyle(patch);
}

// ── Resume positions ────────────────────────────────────────────────────────

interface Progress { pos: number; dur: number }

/** Where to start: the position saved for this title on any device, else this device's own for the file. */
export function resumePosition(r: PlayRequest, fileKey: string | undefined): number {
  const p = useApp.getState().syncState.progress[historyKey(r)]?.v as Progress | undefined;
  if (p?.pos) return p.pos;
  if (!fileKey) return 0;
  try { return Number(localStorage.getItem(`resume:${fileKey}`)) || 0; } catch { return 0; }
}

const lastShared = new Map<string, number>();

/**
 * Save the position: on this device every few seconds (by file, as before), and in the shared
 * state at most every 30 s or when it matters (pause, leaving), so other devices can resume.
 */
export function savePosition(r: PlayRequest, fileKey: string | undefined, pos: number, dur: number, important = false) {
  if (fileKey) { try { localStorage.setItem(`resume:${fileKey}`, String(Math.floor(pos))); } catch { /* storage blocked */ } }
  const k = historyKey(r);
  const last = lastShared.get(k) ?? -Infinity;
  if (!important && Math.abs(pos - last) < 30) return;
  lastShared.set(k, pos);
  // In the end credits counts as finished: start over next time (last 90 s, or last 8% of a short video).
  const done = dur > 0 && pos > Math.max(dur * 0.92, dur - 90);
  useApp.getState().touch('progress', k, done ? { pos: 0, dur } : { pos: Math.floor(pos), dur: Math.floor(dur) });
}
