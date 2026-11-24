/**
 * Anime rows for Home: what's trending, airing this season and top rated on AniList (a public
 * anime database, no key needed), each linked to its IMDb/TMDB title so it opens a normal title
 * page with seasons, episodes and streams. The link comes from anime-map.json (built from the
 * community-kept Fribb/anime-lists by scripts/anime-map.mjs); a show too new to be in it is found
 * by name in the catalog, when the year matches.
 */
import type { TmdbItem } from '../types';

export type AnimeList = 'trending' | 'airing' | 'top';
export const ANIME_LISTS: AnimeList[] = ['trending', 'airing', 'top'];

export interface AniMedia {
  id: number;
  format: string | null;
  seasonYear: number | null;
  averageScore: number | null;
  title: { english: string | null; romaji: string | null };
  coverImage: { extraLarge?: string | null; large?: string | null } | null;
  bannerImage: string | null;
  description: string | null;
}

const ANILIST = 'https://graphql.anilist.co';
const SORT: Record<AnimeList, string> = { trending: 'TRENDING_DESC', airing: 'POPULARITY_DESC', top: 'SCORE_DESC' };
/** Shows not linked yet that may be looked up by name per request (each lookup is two catalog calls). */
const MAX_LOOKUPS = 6;

const query = (list: AnimeList) => `query ($sort: [MediaSort]) {
  Page(perPage: 40) {
    media(type: ANIME, sort: $sort, isAdult: false${list === 'airing' ? ', status: RELEASING' : ''}${list === 'top' ? ', popularity_greater: 20000' : ''}) {
      id format seasonYear averageScore
      title { english romaji }
      coverImage { extraLarge large }
      bannerImage
      description(asHtml: false)
    }
  }
}`;

export function cleanDescription(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/\[Written by[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AnimeDeps {
  fetch: typeof fetch;
  /** anilist id → "<imdb number>,<t|m><tmdb id>" */
  map: Record<string, string>;
  /** The relay's catalog uses TMDB ids (it has a TMDB key). */
  useTmdb: boolean;
  /** The catalog's search, for shows not linked yet. */
  search: (title: string) => Promise<TmdbItem[]>;
}

/** What to send AniList for a list (also handed to the app when AniList turns the relay away). */
export function aniListRequest(list: AnimeList) {
  return { url: ANILIST, query: query(list), variables: { sort: [SORT[list]] } };
}

export class AniListRefused extends Error {
  constructor(public status: number) { super(`AniList answered HTTP ${status}`); }
}

export async function fetchAniList(list: AnimeList, f: typeof fetch): Promise<AniMedia[]> {
  const { url, ...body } = aniListRequest(list);
  const res = await f(url, {
    method: 'POST',
    // AniList turns away requests that don't say who they are (no browser here to say it).
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Streamdeck/1.0 (+https://github.com/i7amood1997-arch/Torrent-streaming)' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AniListRefused(res.status);
  const data = (await res.json()) as { data?: { Page?: { media?: AniMedia[] } } };
  return data.data?.Page?.media ?? [];
}

/** AniList's answer as sent by the app: only the fields used, of the right types, at most 50. */
export function sanitizeMedia(raw: unknown): AniMedia[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const url = (v: unknown) => { const u = str(v, 500); return u && /^https:\/\/[\w.-]*anilist\.co\//.test(u) ? u : null; };
  return raw.slice(0, 50).flatMap((m: any): AniMedia[] => {
    const id = num(m?.id);
    if (!id) return [];
    return [{
      id, format: str(m.format, 20), seasonYear: num(m.seasonYear), averageScore: num(m.averageScore),
      title: { english: str(m.title?.english), romaji: str(m.title?.romaji) },
      coverImage: { extraLarge: url(m.coverImage?.extraLarge), large: url(m.coverImage?.large) },
      bannerImage: url(m.bannerImage), description: str(m.description, 4000),
    }];
  });
}

export async function linkAnime(media: AniMedia[], deps: Omit<AnimeDeps, 'fetch'>): Promise<TmdbItem[]> {
  let lookups = 0;
  const out = await Promise.all(media.map(async (m): Promise<TmdbItem | undefined> => {
    const type = m.format === 'MOVIE' ? 'movie' : 'series';
    const title = m.title.english || m.title.romaji || '';
    if (!title) return undefined;
    const look = {
      title,
      originalTitle: m.title.romaji && m.title.romaji !== title ? m.title.romaji : undefined,
      overview: cleanDescription(m.description),
      year: m.seasonYear ?? undefined,
      posterPath: m.coverImage?.extraLarge || m.coverImage?.large || null,
      backdropPath: m.bannerImage,
      rating: m.averageScore ? m.averageScore / 10 : undefined,
    };
    const linked = deps.map[String(m.id)];
    if (linked) {
      const [imdbNum, tmdb] = linked.split(',');
      const imdbId = `tt${imdbNum}`;
      const tmdbId = deps.useTmdb && tmdb ? Number(tmdb.slice(1)) : undefined;
      if (deps.useTmdb && !tmdbId) return undefined; // that catalog knows titles by TMDB id only
      return { ...look, type, id: tmdbId ?? Number(imdbNum), imdbId, source: tmdbId ? 'tmdb' : 'cinemeta' };
    }
    // Not linked yet (a new show): the catalog's own entry of that name, if it's from the same year.
    if (lookups >= MAX_LOOKUPS || !m.seasonYear) return undefined;
    lookups++;
    const hits = await deps.search(title).catch(() => [] as TmdbItem[]);
    const hit = hits.find((h) => h.type === type && h.year != null && Math.abs(h.year - m.seasonYear!) <= 1);
    return hit ? { ...hit, ...look, type, id: hit.id, imdbId: hit.imdbId, source: hit.source } : undefined;
  }));

  // Sequel seasons are separate AniList entries of one show: list it once.
  const seen = new Set<string>();
  return out.filter((x): x is TmdbItem => {
    if (!x) return false;
    const k = `${x.type}:${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function animeShelf(list: AnimeList, deps: AnimeDeps): Promise<TmdbItem[]> {
  return linkAnime(await fetchAniList(list, deps.fetch), deps);
}
