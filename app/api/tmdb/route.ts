import { NextResponse } from 'next/server';
import { intParam, jsonError, keyFrom } from '@/lib/api-utils';
import { createTmdbClient, TmdbError } from '@/lib/tmdb';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tmdb?action=search&q=dune
 * GET /api/tmdb?action=trending
 * GET /api/tmdb?action=details&type=movie|series&id=123
 * GET /api/tmdb?action=season&id=1399&season=1
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const apiKey = keyFrom(req, 'x-tmdb-key', process.env.TMDB_API_KEY);
  try {
    const tmdb = createTmdbClient({ apiKey, language: sp.get('lang') || 'en-US' });
    const id = intParam(sp.get('id'));
    const type = sp.get('type') === 'series' ? 'series' : 'movie';
    switch (sp.get('action')) {
      case 'search': {
        const q = sp.get('q')?.trim();
        if (!q) return jsonError('q required', 400);
        return NextResponse.json({ results: await tmdb.search(q, intParam(sp.get('page')) ?? 1) });
      }
      case 'trending':
        return NextResponse.json({ results: await tmdb.trending() });
      case 'details':
        if (!id) return jsonError('id required', 400);
        return NextResponse.json(await tmdb.details(type, id));
      case 'season': {
        const season = intParam(sp.get('season'));
        if (!id || season == null) return jsonError('id and season required', 400);
        return NextResponse.json({ episodes: await tmdb.season(id, season) });
      }
      default:
        return jsonError('Unknown action', 400);
    }
  } catch (e) {
    return jsonError((e as Error).message, e instanceof TmdbError ? e.status : 500);
  }
}
