/**
 * TMDB metadata client (server side). Accepts either a v4 Read Access Token
 * (JWT, sent as Bearer) or a v3 API key (sent as ?api_key=).
 */
import type { MediaType, TmdbDetails, TmdbEpisode, TmdbItem } from './types';

const API = 'https://api.themoviedb.org/3';
export const TMDB_IMG = 'https://image.tmdb.org/t/p';

export class TmdbError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export interface TmdbClientOptions {
  apiKey?: string;
  language?: string;
}

export function createTmdbClient({ apiKey, language = 'en-US' }: TmdbClientOptions = {}) {
  if (!apiKey) throw new TmdbError('TMDB API key not configured', 401);
  const isBearer = apiKey.length > 40 && apiKey.includes('.');

  async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(API + path);
    url.searchParams.set('language', language);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    if (!isBearer) url.searchParams.set('api_key', apiKey!);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(isBearer ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new TmdbError(`TMDB ${res.status}`, res.status);
    return res.json() as Promise<T>;
  }

  return {
    /** Multi search (movies + TV), people filtered out. */
    async search(query: string, page = 1): Promise<TmdbItem[]> {
      const data = await get<{ results: any[] }>('/search/multi', { query, page, include_adult: 'false' });
      return data.results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv').map(toItem);
    },

    async trending(window: 'day' | 'week' = 'week'): Promise<TmdbItem[]> {
      const data = await get<{ results: any[] }>(`/trending/all/${window}`);
      return data.results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv').map(toItem);
    },

    async details(type: MediaType, id: number): Promise<TmdbDetails> {
      const path = type === 'movie' ? `/movie/${id}` : `/tv/${id}`;
      const d = await get<any>(path, { append_to_response: 'external_ids' });
      return {
        ...toItem({ ...d, media_type: type === 'movie' ? 'movie' : 'tv' }),
        imdbId: d.imdb_id ?? d.external_ids?.imdb_id ?? undefined,
        runtime: d.runtime ?? d.episode_run_time?.[0],
        genres: (d.genres ?? []).map((g: any) => g.name),
        seasons: d.seasons
          ?.filter((s: any) => s.season_number > 0)
          .map((s: any) => ({ seasonNumber: s.season_number, name: s.name, episodeCount: s.episode_count })),
      };
    },

    async season(tvId: number, season: number): Promise<TmdbEpisode[]> {
      const d = await get<{ episodes: any[] }>(`/tv/${tvId}/season/${season}`);
      return d.episodes.map((e) => ({
        episodeNumber: e.episode_number,
        name: e.name,
        overview: e.overview,
        stillPath: e.still_path,
        airDate: e.air_date,
      }));
    },

    async imdbId(type: MediaType, id: number): Promise<string | undefined> {
      const d = await get<{ imdb_id?: string }>(`/${type === 'movie' ? 'movie' : 'tv'}/${id}/external_ids`);
      return d.imdb_id || undefined;
    },
  };
}

export type TmdbClient = ReturnType<typeof createTmdbClient>;

function toItem(r: any): TmdbItem {
  const type: MediaType = r.media_type === 'tv' ? 'series' : 'movie';
  const date: string | undefined = r.release_date || r.first_air_date;
  return {
    id: r.id,
    type,
    title: r.title ?? r.name,
    originalTitle: r.original_title ?? r.original_name,
    overview: r.overview ?? '',
    year: date ? Number(date.slice(0, 4)) || undefined : undefined,
    posterPath: r.poster_path,
    backdropPath: r.backdrop_path,
    rating: r.vote_average,
    source: 'tmdb',
  };
}

export function posterUrl(path?: string | null, size: 'w185' | 'w342' | 'w500' | 'original' = 'w342') {
  if (!path) return undefined;
  return /^https?:\/\//.test(path) ? path : `${TMDB_IMG}/${size}${path}`; // Cinemeta gives full URLs
}
