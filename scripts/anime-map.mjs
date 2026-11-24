// Rebuilds lib/server/anime-map.json: AniList id → IMDb (and TMDB) id, from the community-kept
// Fribb/anime-lists. Run now and then (node scripts/anime-map.mjs) to pick up new shows; shows
// not in it yet are still found by name.
import { writeFileSync } from 'node:fs';

const SRC = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const list = await (await fetch(SRC)).json();
const map = {};
for (const x of list) {
  const imdb = Array.isArray(x.imdb_id) ? x.imdb_id[0] : x.imdb_id;
  if (!x.anilist_id || !/^tt\d+$/.test(imdb ?? '')) continue;
  const t = x.themoviedb_id ?? {};
  // "<imdb number>,<t|m><tmdb id>" — t = TMDB TV show, m = TMDB movie.
  map[x.anilist_id] = [imdb.slice(2), t.tv ? `t${t.tv}` : t.movie ? `m${t.movie}` : ''].filter(Boolean).join(',');
}
writeFileSync(new URL('../lib/server/anime-map.json', import.meta.url), JSON.stringify(map));
console.log(`${Object.keys(map).length} anime with an IMDb id`);
