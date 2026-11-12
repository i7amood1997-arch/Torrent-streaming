import { NextResponse } from 'next/server';
import { intParam, jsonError, keyFrom } from '@/lib/api-utils';
import { createTmdbClient } from '@/lib/tmdb';
import { ALL_INDEXERS, configFromEnv, searchTorrents, type IndexerId } from '@/lib/torrent-indexer';
import type { SearchQuery } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/search?q=raw+text
 * GET /api/search?imdb=tt123&type=movie
 * GET /api/search?tmdb=1399&type=series&season=1&episode=2&title=Game+of+Thrones
 * Optional: indexers=torrentio,yts (subset of the server-enabled list)
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const type = sp.get('type');
  const query: SearchQuery = {
    q: sp.get('q')?.slice(0, 200) || undefined,
    imdbId: sp.get('imdb') || undefined,
    tmdbId: intParam(sp.get('tmdb')),
    type: type === 'series' || type === 'movie' ? type : undefined,
    season: intParam(sp.get('season')),
    episode: intParam(sp.get('episode')),
    title: sp.get('title')?.slice(0, 200) || undefined,
    year: intParam(sp.get('year')),
  };
  if (!query.q && !query.imdbId && !query.tmdbId) return jsonError('Provide q, imdb or tmdb', 400);

  const config = configFromEnv();
  const subset = sp.get('indexers')?.split(',').filter((s): s is IndexerId => (ALL_INDEXERS as string[]).includes(s));
  if (subset?.length) config.enabled = config.enabled.filter((i) => subset.includes(i));

  if (process.env.ALLOW_CLIENT_TORZNAB === 'true') {
    const url = req.headers.get('x-torznab-url');
    if (url && /^https?:\/\//.test(url)) {
      config.torznabUrl = url.replace(/\/+$/, '');
      config.torznabApiKey = req.headers.get('x-torznab-key') || undefined;
      if (!config.enabled.includes('torznab')) config.enabled.push('torznab');
    }
  }

  const tmdbKey = keyFrom(req, 'x-tmdb-key', process.env.TMDB_API_KEY);
  if (tmdbKey) {
    const tmdb = createTmdbClient({ apiKey: tmdbKey });
    config.resolveImdbId = (id, t) => tmdb.imdbId(t, id);
  }

  try {
    const res = await searchTorrents(query, config);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'private, max-age=120' } });
  } catch (e) {
    return jsonError((e as Error).message, 400);
  }
}
