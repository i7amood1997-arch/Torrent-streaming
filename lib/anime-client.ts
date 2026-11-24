/**
 * An anime row (Home). The relay asks AniList and links each anime to its catalog title. AniList
 * turns some servers away; then the relay says what to ask, this device asks AniList itself
 * (AniList answers browsers), and the relay links that answer.
 */
import type { TmdbItem } from './types';

export interface AniListAsk { url: string; query: string; variables: unknown }

export interface AnimeRowDeps {
  relayGet: (list: string) => Promise<{ results?: TmdbItem[]; ask?: AniListAsk }>;
  anilist: (ask: AniListAsk) => Promise<{ data?: { Page?: { media?: unknown[] } } }>;
  relayLink: (list: string, media: unknown[]) => Promise<{ results?: TmdbItem[] }>;
}

export async function loadAnimeRow(list: string, deps: AnimeRowDeps): Promise<{ results: TmdbItem[] }> {
  const r = await deps.relayGet(list);
  if (!r.ask) return { results: r.results ?? [] };
  const answer = await deps.anilist(r.ask);
  const media = answer.data?.Page?.media ?? [];
  if (!media.length) return { results: [] };
  return { results: (await deps.relayLink(list, media)).results ?? [] };
}
