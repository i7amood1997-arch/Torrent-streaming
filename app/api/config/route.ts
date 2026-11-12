import { NextResponse } from 'next/server';
import { configFromEnv } from '@/lib/torrent-indexer';

export const dynamic = 'force-dynamic';

/** Tells the client which capabilities have server-side keys (never the keys themselves). */
export function GET() {
  const c = configFromEnv();
  return NextResponse.json({
    tmdb: !!process.env.TMDB_API_KEY,
    debrid: {
      realdebrid: !!process.env.REALDEBRID_API_KEY,
      torbox: !!process.env.TORBOX_API_KEY,
      debridlink: !!process.env.DEBRIDLINK_API_KEY,
    },
    subtitles: { opensubtitles: !!process.env.OPENSUBTITLES_API_KEY, subdl: !!process.env.SUBDL_API_KEY },
    indexers: c.enabled.filter((i) => i !== 'torznab' || !!c.torznabUrl),
    clientTorznab: process.env.ALLOW_CLIENT_TORZNAB === 'true',
  });
}
