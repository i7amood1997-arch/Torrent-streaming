import { NextResponse } from 'next/server';
import { intParam, keyFrom } from '@/lib/api-utils';
import { searchSubtitles } from '@/lib/subtitles';

export const dynamic = 'force-dynamic';

/** GET /api/subtitles?imdb=tt..&tmdb=..&type=movie|series&season&episode&release=..&langs=ar,en */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const imdb = sp.get('imdb');
  const res = await searchSubtitles(
    {
      imdbId: imdb && /^tt\d+$/.test(imdb) ? imdb : undefined,
      tmdbId: intParam(sp.get('tmdb')),
      type: sp.get('type') === 'series' ? 'series' : sp.get('type') === 'movie' ? 'movie' : undefined,
      season: intParam(sp.get('season')),
      episode: intParam(sp.get('episode')),
      releaseName: sp.get('release')?.slice(0, 300) || undefined,
      query: sp.get('q')?.slice(0, 200) || undefined,
      langs: (sp.get('langs') || 'ar,en').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l)),
    },
    {
      openSubtitles: keyFrom(req, 'x-opensubtitles-key', process.env.OPENSUBTITLES_API_KEY),
      subdl: keyFrom(req, 'x-subdl-key', process.env.SUBDL_API_KEY),
    },
  );
  return NextResponse.json(res);
}
