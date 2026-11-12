/**
 * Portable API backend: plain `Request → Response` (Fetch API), so it runs in a
 * Cloudflare Worker (worker/index.ts) or any other Fetch-compatible runtime.
 *
 * The static frontend on GitHub Pages calls these routes cross-origin:
 *   GET  /api/config
 *   GET  /api/search?q=… | imdb=… | tmdb=…&type&season&episode&title&year&indexers
 *   GET  /api/tmdb?action=search|trending|details|season…
 *   POST /api/debrid/resolve   { provider, magnet|infoHash, fileIdx?, season?, episode? }
 *   GET  /api/subtitles?imdb&tmdb&type&season&episode&release&q&langs
 *   GET  /api/subtitles/file?token=…
 *
 * Why a backend at all: indexer/debrid/subtitle APIs mostly don't send CORS
 * headers, server-side keys must stay secret, and SubDL zips need unpacking.
 */
import { DebridError, envDebridKey, resolveDebridStream } from '../debrid';
import { parseMagnet } from '../magnet';
import { fetchSubtitleCues, searchSubtitles, type SubtitleKeys } from '../subtitles';
import { createTmdbClient, TmdbError } from '../tmdb';
import { ALL_INDEXERS, configFromEnv, searchTorrents, type IndexerId } from '../torrent-indexer';
import { describeError } from '../runtime';
import { toVtt } from '../subtitle-parser';
import type { DebridProvider, SearchQuery } from '../types';

export type Env = Record<string, string | undefined>;

const ALLOWED_HEADERS = [
  'content-type',
  'x-access-token',
  'x-tmdb-key',
  'x-debrid-key',
  'x-opensubtitles-key',
  'x-subdl-key',
  'x-torznab-url',
  'x-torznab-key',
].join(', ');

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });

const err = (message: string, status: number) => json({ error: message }, status);

function intParam(v: string | null): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const keyFrom = (req: Request, header: string, fallback?: string) => req.headers.get(header)?.trim() || fallback || undefined;

const subtitleKeys = (req: Request, env: Env): SubtitleKeys => ({
  openSubtitles: keyFrom(req, 'x-opensubtitles-key', env.OPENSUBTITLES_API_KEY),
  subdl: keyFrom(req, 'x-subdl-key', env.SUBDL_API_KEY),
  userAgent: env.OPENSUBTITLES_USER_AGENT,
});

// ─── Route handlers ─────────────────────────────────────────────────────────

function config(env: Env) {
  const c = configFromEnv(env);
  return json({
    tmdb: !!env.TMDB_API_KEY,
    debrid: { realdebrid: !!env.REALDEBRID_API_KEY, torbox: !!env.TORBOX_API_KEY, debridlink: !!env.DEBRIDLINK_API_KEY },
    subtitles: { opensubtitles: !!env.OPENSUBTITLES_API_KEY, subdl: !!env.SUBDL_API_KEY },
    indexers: c.enabled.filter((i) => i !== 'torznab' || !!c.torznabUrl),
    clientTorznab: env.ALLOW_CLIENT_TORZNAB === 'true',
    accessToken: !!env.ACCESS_TOKEN,
    stream: env.STREAM_ENABLED === 'true',
  });
}

async function search(req: Request, env: Env, sp: URLSearchParams) {
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
  if (!query.q && !query.imdbId && !query.tmdbId) return err('Provide q, imdb or tmdb', 400);

  const cfg = configFromEnv(env);
  const subset = sp.get('indexers')?.split(',').filter((s): s is IndexerId => (ALL_INDEXERS as string[]).includes(s));
  if (subset?.length) cfg.enabled = cfg.enabled.filter((i) => subset.includes(i));

  if (env.ALLOW_CLIENT_TORZNAB === 'true') {
    const url = req.headers.get('x-torznab-url');
    if (url && /^https?:\/\//.test(url)) {
      cfg.torznabUrl = url.replace(/\/+$/, '');
      cfg.torznabApiKey = req.headers.get('x-torznab-key') || undefined;
      if (!cfg.enabled.includes('torznab')) cfg.enabled.push('torznab');
    }
  }

  const tmdbKey = keyFrom(req, 'x-tmdb-key', env.TMDB_API_KEY);
  if (tmdbKey) {
    const tmdb = createTmdbClient({ apiKey: tmdbKey });
    cfg.resolveImdbId = (id, t) => tmdb.imdbId(t, id);
  }

  try {
    const result = await searchTorrents(query, cfg);
    // Don't let the browser cache a result that contains source failures — retrying should really retry.
    return json(result, 200, { 'Cache-Control': result.errors.length ? 'no-store' : 'private, max-age=120' });
  } catch (e) {
    return err(describeError(e), 400);
  }
}

async function tmdb(req: Request, env: Env, sp: URLSearchParams) {
  try {
    const client = createTmdbClient({ apiKey: keyFrom(req, 'x-tmdb-key', env.TMDB_API_KEY), language: sp.get('lang') || 'en-US' });
    const id = intParam(sp.get('id'));
    const type = sp.get('type') === 'series' ? 'series' : 'movie';
    switch (sp.get('action')) {
      case 'search': {
        const q = sp.get('q')?.trim();
        if (!q) return err('q required', 400);
        return json({ results: await client.search(q, intParam(sp.get('page')) ?? 1) });
      }
      case 'trending':
        return json({ results: await client.trending() }, 200, { 'Cache-Control': 'public, max-age=3600' });
      case 'details':
        if (!id) return err('id required', 400);
        return json(await client.details(type, id), 200, { 'Cache-Control': 'public, max-age=3600' });
      case 'season': {
        const season = intParam(sp.get('season'));
        if (!id || season == null) return err('id and season required', 400);
        return json({ episodes: await client.season(id, season) }, 200, { 'Cache-Control': 'public, max-age=3600' });
      }
      default:
        return err('Unknown action', 400);
    }
  } catch (e) {
    return err(describeError(e), e instanceof TmdbError ? e.status : 500);
  }
}

const PROVIDERS: DebridProvider[] = ['realdebrid', 'torbox', 'debridlink'];

async function debridResolve(req: Request, env: Env) {
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400); }
  const provider = body?.provider as DebridProvider;
  if (!PROVIDERS.includes(provider)) return err('Unknown debrid provider', 400);
  const parsed = parseMagnet(String(body.magnet ?? body.infoHash ?? ''));
  if (!parsed) return err('Invalid magnet link or info hash', 400);
  const num = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);
  try {
    return json(
      await resolveDebridStream({
        provider,
        apiKey: req.headers.get('x-debrid-key')?.trim() || envDebridKey(provider, env) || '',
        magnet: parsed.magnet,
        infoHash: parsed.infoHash,
        fileIdx: num(body.fileIdx),
        season: num(body.season),
        episode: num(body.episode),
      }),
    );
  } catch (e) {
    const status = e instanceof DebridError ? (e.status === 401 || e.status === 403 ? 401 : 502) : 500;
    return err(describeError(e), status);
  }
}

async function subtitles(req: Request, env: Env, sp: URLSearchParams) {
  const imdb = sp.get('imdb');
  const t = sp.get('type');
  return json(
    await searchSubtitles(
      {
        imdbId: imdb && /^tt\d+$/.test(imdb) ? imdb : undefined,
        tmdbId: intParam(sp.get('tmdb')),
        type: t === 'series' || t === 'movie' ? t : undefined,
        season: intParam(sp.get('season')),
        episode: intParam(sp.get('episode')),
        releaseName: sp.get('release')?.slice(0, 300) || undefined,
        query: sp.get('q')?.slice(0, 200) || undefined,
        langs: (sp.get('langs') || 'ar,en').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l)),
      },
      subtitleKeys(req, env),
    ),
  );
}

async function subtitleFile(req: Request, env: Env, sp: URLSearchParams) {
  const token = sp.get('token');
  if (!token) return err('token required', 400);
  try {
    const cues = await fetchSubtitleCues(token, subtitleKeys(req, env));
    if (sp.get('format') === 'vtt') {
      // For external players (webtor.io iframe): plain WebVTT, readable from any origin.
      return new Response(toVtt(cues, 0, sp.get('rtl') === '1'), {
        headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'X-Public-Cors': '1' },
      });
    }
    return json({ cues }, 200, { 'Cache-Control': 'private, max-age=86400' });
  } catch (e) {
    return err(describeError(e), 502);
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  let res: Response;

  // Optional shared secret: protects server-side keys (e.g. your Debrid account) from strangers.
  if (env.ACCESS_TOKEN && path !== '/api/config' && path !== '' && req.headers.get('x-access-token') !== env.ACCESS_TOKEN) {
    res = err('Access token required — enter it in the app Settings.', 401);
  } else {
    try {
      const get = req.method === 'GET';
      if (path === '' || path === '/api') res = json({ ok: true, service: 'streamdeck-api' });
      else if (path === '/api/config' && get) res = config(env);
      else if (path === '/api/search' && get) res = await search(req, env, url.searchParams);
      else if (path === '/api/tmdb' && get) res = await tmdb(req, env, url.searchParams);
      else if (path === '/api/debrid/resolve' && req.method === 'POST') res = await debridResolve(req, env);
      else if (path === '/api/subtitles' && get) res = await subtitles(req, env, url.searchParams);
      else if (path === '/api/subtitles/file' && get) res = await subtitleFile(req, env, url.searchParams);
      else res = err('Not found', 404);
    } catch (e) {
      res = err(describeError(e) || 'Internal error', 500);
    }
  }

  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  // Subtitle VTT files contain no secrets and are fetched by third-party players' own origin.
  if (res.headers.get('X-Public-Cors')) {
    res.headers.delete('X-Public-Cors');
    res.headers.set('Access-Control-Allow-Origin', '*');
  }
  return res;
}
