import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-utils';
import { DebridError, envDebridKey, resolveDebridStream } from '@/lib/debrid';
import { parseMagnet } from '@/lib/magnet';
import type { DebridProvider } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PROVIDERS: DebridProvider[] = ['realdebrid', 'torbox', 'debridlink'];

/**
 * POST /api/debrid/resolve
 * headers: x-debrid-key (optional; falls back to server env)
 * body: { provider, magnet | infoHash, fileIdx?, season?, episode? }
 */
export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return jsonError('Invalid JSON', 400); }

  const provider = body.provider as DebridProvider;
  if (!PROVIDERS.includes(provider)) return jsonError('Unknown debrid provider', 400);
  const parsed = parseMagnet(String(body.magnet ?? body.infoHash ?? ''));
  if (!parsed) return jsonError('Invalid magnet link or info hash', 400);

  const apiKey = req.headers.get('x-debrid-key')?.trim() || envDebridKey(provider) || '';
  const num = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);
  try {
    const result = await resolveDebridStream({
      provider,
      apiKey,
      magnet: parsed.magnet,
      infoHash: parsed.infoHash,
      fileIdx: num(body.fileIdx),
      season: num(body.season),
      episode: num(body.episode),
    });
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof DebridError ? (e.status === 401 || e.status === 403 ? 401 : 502) : 500;
    return jsonError((e as Error).message, status);
  }
}
