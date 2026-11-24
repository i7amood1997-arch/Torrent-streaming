/**
 * Episode pictures from TVmaze (free, no key), for episodes the catalog's picture source has none
 * for — common for anime past their first season. TVmaze numbers anime seasons by year, so its
 * episodes are matched to the catalog's by the day they aired (a day either way for time zones,
 * the name deciding between neighbours), not by number.
 */
import type { TmdbEpisode } from '../types';

export interface TvmazeEpisode { name: string; airdate: string; image: { medium?: string; original?: string } | null }

const TVMAZE = 'https://api.tvmaze.com';
const day = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`) / 86_400_000;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function matchStills(eps: TmdbEpisode[], tv: TvmazeEpisode[]): (string | undefined)[] {
  const byDay = new Map<number, TvmazeEpisode[]>();
  for (const t of tv) if (t.airdate) { const d = day(t.airdate); byDay.set(d, [...(byDay.get(d) ?? []), t]); }
  const byName = new Map(tv.map((t) => [norm(t.name), t]));
  const used = new Set<TvmazeEpisode>();
  return eps.map((e) => {
    let hit: TvmazeEpisode | undefined;
    if (e.airDate) {
      const d = day(e.airDate);
      const same = byDay.get(d) ?? [];
      const near = [...same, ...(byDay.get(d - 1) ?? []), ...(byDay.get(d + 1) ?? [])].filter((t) => !used.has(t));
      hit = near.find((t) => norm(t.name) === norm(e.name)) ?? same.find((t) => !used.has(t)) ?? (near.length === 1 ? near[0] : undefined);
    }
    hit ??= byName.get(norm(e.name));
    if (!hit || used.has(hit)) return undefined;
    used.add(hit);
    return hit.image?.original ?? hit.image?.medium ?? undefined;
  });
}

/** The season with TVmaze's picture as each episode's second choice (unchanged if TVmaze can't help). */
export async function addTvmazeStills(imdbId: string, eps: TmdbEpisode[], f: typeof fetch = fetch): Promise<TmdbEpisode[]> {
  try {
    const show = await f(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`, { headers: { accept: 'application/json' } });
    if (!show.ok) return eps;
    const { id } = (await show.json()) as { id?: number };
    if (!id) return eps;
    const res = await f(`${TVMAZE}/shows/${id}/episodes`, { headers: { accept: 'application/json' } });
    if (!res.ok) return eps;
    const stills = matchStills(eps, (await res.json()) as TvmazeEpisode[]);
    return eps.map((e, i) => (stills[i] ? { ...e, stillAlt: stills[i] } : e));
  } catch {
    return eps;
  }
}
