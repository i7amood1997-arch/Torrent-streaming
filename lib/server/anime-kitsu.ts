/**
 * Anime are best found by their Kitsu id: Torrentio and MediaFusion then return releases from
 * Nyaa and other anime sites, for the right episode, and not a live-action show of the same name.
 * anime-kitsu.json (scripts/anime-map.mjs) lists each IMDb title's Kitsu series entries with the
 * TVDB season each covers (none for a long-running show numbered straight through).
 */
import KITSU from './anime-kitsu.json';

type KitsuMap = Record<string, string[]>;

export function kitsuTarget(imdbId: string | undefined, season: number | undefined, episode: number | undefined, absEpisode?: number, map: KitsuMap = KITSU as KitsuMap): { id: number; episode: number } | undefined {
  if (!imdbId || season == null || episode == null) return undefined;
  const entries = map[imdbId.slice(2)]?.map((s) => { const [id, se] = s.split(':'); return { id: Number(id), season: se === '' ? undefined : Number(se) }; });
  if (!entries?.length) return undefined;
  // This season has its own entry: that, with the season's episode number.
  const own = entries.find((e) => e.season === season);
  if (own) return { id: own.id, episode };
  // Otherwise the show's main entry, numbered straight through.
  const main = entries.find((e) => e.season == null) ?? entries.find((e) => e.season === 1);
  if (!main) return undefined;
  if (season === 1) return { id: main.id, episode };
  return absEpisode != null ? { id: main.id, episode: absEpisode } : undefined;
}
