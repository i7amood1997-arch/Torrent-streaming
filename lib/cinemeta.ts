/**
 * Cinemeta — Stremio's public, keyless metadata catalog (movies & series by IMDB id).
 * Used for Catalog mode when no TMDB key is configured, and to find an IMDB id
 * from a title (for subtitles). Returns the same shapes as lib/tmdb.ts.
 *
 * Items use the numeric part of the IMDB id as `id` (tt0903747 → 903747) and
 * always carry `imdbId`; `source: 'cinemeta'` tells callers `id` is not a TMDB id.
 */
import type { MediaType, TmdbDetails, TmdbEpisode, TmdbItem } from './types';

const BASE = 'https://v3-cinemeta.strem.io';

export const imdbFromNumeric = (id: number) => `tt${String(id).padStart(7, '0')}`;
const kind = (type: MediaType) => (type === 'series' ? 'series' : 'movie');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Cinemeta ${res.status}`);
  return res.json() as Promise<T>;
}

function toItem(m: any, type: MediaType): TmdbItem | undefined {
  const imdbId: string | undefined = [m?.imdb_id, m?.id].find((x) => typeof x === 'string' && /^tt\d+$/.test(x));
  if (!imdbId || !m?.name) return undefined;
  const year = Number(String(m.releaseInfo ?? m.year ?? '').slice(0, 4)) || undefined;
  const rating = Number(m.imdbRating);
  return {
    id: Number(imdbId.slice(2)),
    type,
    title: m.name,
    overview: m.description ?? '',
    year,
    posterPath: typeof m.poster === 'string' ? m.poster : null,
    backdropPath: typeof m.background === 'string' ? m.background : null,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    imdbId,
    source: 'cinemeta',
  };
}

const list = (metas: any[] | undefined, type: MediaType) => (metas ?? []).flatMap((m) => toItem(m, type) ?? []);

/** Interleave two ranked lists so movies and series both appear near the top. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

async function both(path: (k: string) => string): Promise<TmdbItem[]> {
  const [movies, series] = await Promise.allSettled([
    get<{ metas?: any[] }>(path('movie')),
    get<{ metas?: any[] }>(path('series')),
  ]);
  if (movies.status === 'rejected' && series.status === 'rejected') throw movies.reason;
  return interleave(
    movies.status === 'fulfilled' ? list(movies.value.metas, 'movie') : [],
    series.status === 'fulfilled' ? list(series.value.metas, 'series') : [],
  );
}

interface Video {
  season?: number;
  episode?: number;
  number?: number;
  name?: string;
  title?: string;
  overview?: string;
  description?: string;
  thumbnail?: string;
  released?: string;
}

export const cinemeta = {
  search: (query: string) => both((k) => `/catalog/${k}/top/search=${encodeURIComponent(query)}.json`).then((r) => r.slice(0, 40)),
  /** A shelf: popular titles of one type, optionally in a genre. */
  shelf: (type: MediaType, genre?: string) =>
    get<{ metas?: any[] }>(`/catalog/${kind(type)}/top${genre ? `/genre=${encodeURIComponent(genre)}` : ''}.json`).then((r) => list(r.metas, type).slice(0, 30)),
  trending: () => both((k) => `/catalog/${k}/top.json`).then((r) => r.slice(0, 40)),

  async details(type: MediaType, id: number): Promise<TmdbDetails> {
    const { meta } = await get<{ meta?: any }>(`/meta/${kind(type)}/${imdbFromNumeric(id)}.json`);
    const item = meta && toItem(meta, type);
    if (!item) throw new Error('Title not found');
    const seasons = new Map<number, number>();
    const today = new Date().toISOString().slice(0, 10);
    let last: Video | undefined;
    for (const v of (meta.videos ?? []) as Video[]) {
      if (typeof v.season === 'number' && v.season > 0) seasons.set(v.season, (seasons.get(v.season) ?? 0) + 1);
      const day = v.released?.slice(0, 10);
      if (typeof v.season === 'number' && v.season > 0 && day && day <= today && (!last || day > last.released!.slice(0, 10) || (day === last.released!.slice(0, 10) && (v.season > last.season! || (v.season === last.season && (v.episode ?? 0) > (last.episode ?? 0)))))) last = v;
    }
    return {
      ...item,
      runtime: Number(String(meta.runtime ?? '').match(/\d+/)?.[0]) || undefined,
      genres: Array.isArray(meta.genres) ? meta.genres : Array.isArray(meta.genre) ? meta.genre : [],
      seasons: type === 'series'
        ? [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([seasonNumber, episodeCount]) => ({ seasonNumber, name: `Season ${seasonNumber}`, episodeCount }))
        : undefined,
      lastAired: type === 'series' && last ? { season: last.season!, episode: last.episode ?? last.number ?? 0, name: last.name ?? last.title, airDate: last.released!.slice(0, 10), still: last.thumbnail ?? null } : undefined,
    };
  },

  async season(id: number, season: number): Promise<TmdbEpisode[]> {
    const { meta } = await get<{ meta?: any }>(`/meta/series/${imdbFromNumeric(id)}.json`);
    return ((meta?.videos ?? []) as Video[])
      .filter((v) => v.season === season)
      .map((v) => ({
        episodeNumber: v.episode ?? v.number ?? 0,
        name: v.name ?? v.title ?? `Episode ${v.episode ?? v.number}`,
        overview: v.overview ?? v.description ?? '',
        stillPath: v.thumbnail ?? null,
        airDate: v.released,
      }))
      .filter((e) => e.episodeNumber > 0)
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
  },

  /** Best-effort IMDB id for a title (used to find subtitles for raw torrent results). */
  async findImdbId(title: string, type: MediaType, year?: number): Promise<string | undefined> {
    const { metas } = await get<{ metas?: any[] }>(`/catalog/${kind(type)}/top/search=${encodeURIComponent(title)}.json`);
    const items = list(metas, type);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const exact = items.filter((i) => norm(i.title) === norm(title));
    const pool = exact.length ? exact : items;
    return (year ? pool.find((i) => i.year === year) : undefined)?.imdbId ?? pool[0]?.imdbId;
  },
};
