/**
 * Cloudflare Worker entry — the API backend for the GitHub Pages frontend.
 *  - /api/stream/*  built-in torrent streaming (Durable Object, worker/stream-do.ts)
 *  - everything else: lib/server/handlers.ts (search, TMDB, Debrid, subtitles)
 */
import { handleApi, type ApiBindings, type Env } from '../lib/server/handlers';
import { TorrentStream } from './stream-do';

export { TorrentStream };

interface Bindings {
  STREAM?: DurableObjectNamespaceLike;
  AI?: ApiBindings['AI'];
  [key: string]: unknown;
}

const CORS_HEADERS = 'content-type, x-access-token, range';

export default {
  async fetch(request: Request, bindings: Bindings): Promise<Response> {
    // String-valued settings only; `STREAM_ENABLED` tells /api/config that streaming is available.
    const env: Env = {};
    for (const [k, v] of Object.entries(bindings)) if (typeof v === 'string') env[k] = v;
    if (bindings.STREAM) env.STREAM_ENABLED = 'true';

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/stream\/([a-f0-9]{40})\/(prepare|status|file)(\/|$)/);
    if (!m) {
      if (url.pathname.startsWith('/api/stream/')) return new Response('Not found', { status: 404 });
      return handleApi(request, env, { AI: bindings.AI });
    }

    const cors: Record<string, string> = {
      // <video> can't send custom headers, and stream URLs are unguessable only via the info-hash,
      // so the optional ACCESS_TOKEN is also accepted as ?t=.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': CORS_HEADERS,
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!bindings.STREAM) return new Response(JSON.stringify({ error: 'Streaming is not enabled on this backend.' }), { status: 501, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (env.ACCESS_TOKEN && request.headers.get('x-access-token') !== env.ACCESS_TOKEN && url.searchParams.get('t') !== env.ACCESS_TOKEN) {
      return new Response(JSON.stringify({ error: 'Access token required.' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const stub = bindings.STREAM.get(bindings.STREAM.idFromName(m[1]));
    const res = await stub.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
