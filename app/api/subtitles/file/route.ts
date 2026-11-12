import { NextResponse } from 'next/server';
import { jsonError, keyFrom } from '@/lib/api-utils';
import { fetchSubtitleCues } from '@/lib/subtitles';

export const dynamic = 'force-dynamic';

/** GET /api/subtitles/file?token=… → { cues: SubtitleCue[] } (decoded, charset-fixed, parsed). */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return jsonError('token required', 400);
  try {
    const cues = await fetchSubtitleCues(token, {
      openSubtitles: keyFrom(req, 'x-opensubtitles-key', process.env.OPENSUBTITLES_API_KEY),
      subdl: keyFrom(req, 'x-subdl-key', process.env.SUBDL_API_KEY),
    });
    return NextResponse.json({ cues }, { headers: { 'Cache-Control': 'private, max-age=86400' } });
  } catch (e) {
    return jsonError((e as Error).message, 502);
  }
}
