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
 *   POST /api/translate        { text, from, to }  (subtitle lines, newline-separated)
 *   POST /api/transcribe?lang  raw audio bytes → speech segments (Workers AI Whisper)
 *   POST /api/translate-ai     { lines, context, from, to, title } → subtitle lines translated by an LLM
 *
 * Why a backend at all: indexer/debrid/subtitle APIs mostly don't send CORS
 * headers, server-side keys must stay secret, and SubDL zips need unpacking.
 */
import { DebridError, envDebridKey, resolveDebridStream } from '../debrid';
import { parseMagnet } from '../magnet';
import { fetchSubtitleCues, searchSubtitles, type SubtitleKeys } from '../subtitles';
import { createTmdbClient, TmdbError } from '../tmdb';
import { ALL_INDEXERS, configFromEnv, parseAddonList, searchTorrents, type IndexerId } from '../torrent-indexer';
import { cinemeta } from '../cinemeta';
import { describeError } from '../runtime';
import { toVtt } from '../subtitle-parser';
import { buildSubtitlePrompt, googleTranslate, parseNumberedLines, readLlmText } from '../translate';
import type { DebridProvider, SearchQuery } from '../types';
// Type only: the Claude client is made in the Worker (worker/index.ts), keeping the SDK out of the web app.
import type Anthropic from '@anthropic-ai/sdk';

export type Env = Record<string, string | undefined>;

/** Non-string bindings (Cloudflare): Workers AI for speech recognition. */
export interface ApiBindings {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Claude API client (Worker only, when ANTHROPIC_API_KEY is set): the last-resort translator. */
  claude?: Pick<Anthropic, 'messages'>;
}

const ALLOWED_HEADERS = [
  'content-type',
  'x-access-token',
  'x-tmdb-key',
  'x-debrid-key',
  'x-opensubtitles-key',
  'x-subdl-key',
  'x-torznab-url',
  'x-torznab-key',
  'x-stremio-addons',
  'range',
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
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
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

function config(env: Env, b: ApiBindings) {
  const c = configFromEnv(env);
  return json({
    tmdb: !!env.TMDB_API_KEY,
    debrid: { realdebrid: !!env.REALDEBRID_API_KEY, torbox: !!env.TORBOX_API_KEY, debridlink: !!env.DEBRIDLINK_API_KEY },
    subtitles: { opensubtitles: !!env.OPENSUBTITLES_API_KEY, subdl: !!env.SUBDL_API_KEY },
    indexers: c.enabled.filter((i) => i !== 'torznab' || !!c.torznabUrl),
    clientTorznab: env.ALLOW_CLIENT_TORZNAB === 'true',
    accessToken: !!env.ACCESS_TOKEN,
    stream: env.STREAM_ENABLED === 'true',
    ai: !!b.AI,
    claude: !!b.claude,
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

  // The user's own Stremio add-ons (https only, fixed /stream/… path). Disable with ALLOW_CLIENT_ADDONS=false.
  if (env.ALLOW_CLIENT_ADDONS !== 'false') {
    const extra = parseAddonList(req.headers.get('x-stremio-addons'));
    if (extra.length) cfg.stremioAddons = extra;
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
    const apiKey = keyFrom(req, 'x-tmdb-key', env.TMDB_API_KEY);
    // No TMDB key → the keyless Cinemeta catalog (same response shapes).
    const client = apiKey ? createTmdbClient({ apiKey, language: sp.get('lang') || 'en-US' }) : cinemeta;
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
      case 'shelf':
        return json({ results: await client.shelf(type, sp.get('genre')?.slice(0, 30) || undefined) }, 200, { 'Cache-Control': 'public, max-age=3600' });
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
        langs: (sp.get('langs') || 'ar,en').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^([a-z]{2}|\*)$/.test(l)),
        videoHash: /^[0-9a-f]{16}$/.test(sp.get('hash') ?? '') ? sp.get('hash')! : undefined,
        videoSize: Number(sp.get('size')) || undefined,
        fileName: sp.get('file')?.slice(0, 300) || undefined,
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

// ─── Translation & speech recognition ───────────────────────────────────────

async function translate(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; from?: unknown; to?: unknown };
  const code = (v: unknown) => (typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v) ? v : undefined);
  const to = code(body.to);
  if (typeof body.text !== 'string' || !body.text || body.text.length > 8000 || !to) return err('text (≤ 8000 chars) and to required', 400);
  try {
    return json({ text: await googleTranslate(body.text, code(body.from) ?? 'auto', to, AbortSignal.timeout(20000)) });
  } catch (e) {
    return err(describeError(e), 502);
  }
}

/** Strongest multilingual models on Workers AI first; each costs ~1,200 of the 10,000 free daily units per episode. */
const TRANSLATORS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct'];

/** Last-resort translator (Claude API): used only when the app says every other translator refused. */
const CLAUDE_MODEL = 'claude-haiku-5-5';

async function claudeTranslate(client: Pick<Anthropic, 'messages'>, system: string, user: string, count: number) {
  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' }, // translation needs little deliberation; keeps it fast and cheap
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this text');
  const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  return parseNumberedLines(text, count);
}

async function translateAi(req: Request, b: ApiBindings) {
  const claude = b.claude;
  const body = (await req.json().catch(() => ({}))) as { lines?: unknown; context?: unknown; from?: unknown; to?: unknown; title?: unknown; lastResort?: unknown };
  // Claude is allowed only when the app has already been refused by Google (lastResort).
  const mayUseClaude = body.lastResort === true && !!claude;
  if (!b.AI && !mayUseClaude) return err('AI translation isn’t set up on this relay.', 501);
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 300)).slice(0, max) : []);
  const lines = strings(body.lines, 60);
  const context = strings(body.context, 6);
  const code = (v: unknown) => (typeof v === 'string' && /^[a-z]{2,3}$/.test(v) ? v : undefined);
  const to = code(body.to);
  if (!lines.length || !to) return err('lines and to required', 400);
  const messages = buildSubtitlePrompt(lines, { from: code(body.from), to, context, title: typeof body.title === 'string' ? body.title.slice(0, 120) : undefined });
  let lastError = b.AI ? '' : 'no Workers AI';
  let quotaUsed = false;
  for (const model of b.AI ? TRANSLATORS : []) {
    try {
      let out: unknown;
      if (model.includes('gpt-oss')) {
        // Reasoning model: "low" effort is plenty for translation and several times faster than the default.
        try {
          out = await b.AI!.run(model, { instructions: messages[0].content, input: messages[1].content, reasoning: { effort: 'low' }, max_output_tokens: 4096 });
        } catch (e) {
          if (/neuron|allocation|quota|4006/i.test(describeError(e))) throw e;
          out = await b.AI!.run(model, { messages, max_tokens: 4096, temperature: 0.2 });
        }
      } else {
        out = await b.AI!.run(model, { messages, max_tokens: 4096, temperature: 0.2 });
      }
      const parsed = parseNumberedLines(readLlmText(out), lines.length);
      if (parsed.filter(Boolean).length >= Math.ceil(lines.length * 0.8)) return json({ lines: parsed, model });
      lastError = 'incomplete answer';
    } catch (e) {
      lastError = describeError(e);
      if (/neuron|allocation|quota|4006/i.test(lastError)) { quotaUsed = true; break; }
    }
  }
  if (mayUseClaude) {
    try {
      const parsed = await claudeTranslate(claude!, messages[0].content, messages[1].content, lines.length);
      if (parsed.filter(Boolean).length >= Math.ceil(lines.length * 0.8)) return json({ lines: parsed, model: CLAUDE_MODEL });
      lastError = 'incomplete answer from Claude';
    } catch (e) {
      // The SDK's APIError carries the HTTP status (its classes aren't imported here; see the import note).
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) return json({ error: 'The Claude API key on your relay was rejected.', fatal: true }, 502);
      if (status === 429) return json({ error: 'Claude is rate-limited right now.', fatal: true }, 429);
      lastError = `Claude: ${describeError(e)}`;
    }
  }
  if (quotaUsed && !mayUseClaude) {
    return json({ error: 'Today’s free AI allowance on your relay is used up; standard translation is used until it resets.', fatal: true }, 429);
  }
  return err(`AI translation failed: ${lastError}`, 502);
}

const WHISPER = '@cf/openai/whisper-large-v3-turbo';

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface WhisperOut {
  transcription_info?: { language?: string };
  segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number; words?: { word: string; start: number; end: number }[] }[];
}

async function transcribe(req: Request, sp: URLSearchParams, b: ApiBindings) {
  if (!b.AI) return err('Speech recognition isn’t set up on this relay (it needs the Workers AI binding, added automatically on the next deploy).', 501);
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length) return err('audio required', 400);
  if (audio.length > 25 << 20) return err('audio clip too large', 413);
  const lang = sp.get('lang');
  const opts = { vad_filter: true, condition_on_previous_text: false, ...(lang && /^[a-z]{2,3}$/.test(lang) ? { language: lang } : {}) };
  const contentType = req.headers.get('content-type') || 'application/octet-stream';
  let out: WhisperOut;
  try {
    // Streamed body first (no base64 work for the Worker), then the documented base64 form.
    try {
      out = (await b.AI.run(WHISPER, { audio: { body: new Response(audio).body, contentType }, ...opts })) as WhisperOut;
    } catch (e) {
      if (/neuron|allocation|quota|4006|limit/i.test(describeError(e))) throw e;
      out = (await b.AI.run(WHISPER, { audio: base64(audio), ...opts })) as WhisperOut;
    }
  } catch (e) {
    const m = describeError(e);
    if (/neuron|allocation|quota|4006/i.test(m)) {
      return json({ error: 'Today’s free speech-recognition allowance on your relay is used up (about 3½ hours of audio a day). It resets daily.', fatal: true }, 429);
    }
    return err(`Speech recognition failed: ${m}`, 502);
  }
  const segments = (out.segments ?? [])
    .filter((s) => s.text?.trim() && !((s.no_speech_prob ?? 0) > 0.8) && !((s.avg_logprob ?? 0) < -1.2))
    .map((s) => ({
      start: s.start, end: s.end, text: s.text.trim(),
      words: s.words?.map((w) => ({ word: w.word, start: w.start, end: w.end })),
    }));
  return json({ language: out.transcription_info?.language, segments });
}

// ─── Direct-link playback proxy ─────────────────────────────────────────────

/** Request headers a host may require (from Stremio `proxyHeaders`). Nothing else is forwarded. */
const PROXY_REQUEST_HEADERS = ['referer', 'origin', 'user-agent'];
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

const b64urlJson = {
  enc: (v: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(v)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))),
};

/** URL of this proxy for `target`, keeping the same headers/token (used to rewrite HLS playlists). */
function proxied(self: URL, target: string): string {
  const u = new URL('/api/proxy', self.origin);
  u.searchParams.set('url', target);
  for (const k of ['h', 't']) { const v = self.searchParams.get(k); if (v) u.searchParams.set(k, v); }
  return u.toString();
}

/** Point every URI in an HLS playlist (segments, keys, variant playlists) back through the proxy. */
export function rewritePlaylist(body: string, base: string, self: URL): string {
  const abs = (u: string) => { try { return new URL(u, base).toString(); } catch { return u; } };
  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxied(self, abs(u))}"`);
      return proxied(self, abs(t));
    })
    .join('\n');
}

/**
 * GET /api/proxy?url=<http(s) URL>[&h=<base64url JSON headers>][&t=<token>]
 * Streams a direct video link with Range support, adding headers the host needs
 * and CORS so the app (and its MKV converter) can read it.
 */
async function proxy(req: Request, self: URL): Promise<Response> {
  const target = self.searchParams.get('url') ?? '';
  let parsed: URL;
  try { parsed = new URL(target); } catch { return err('Invalid url', 400); }
  if (!/^https?:$/.test(parsed.protocol)) return err('Only http(s) links can be played', 400);
  const headers: Record<string, string> = {};
  const h = self.searchParams.get('h');
  if (h) {
    try {
      for (const [k, v] of Object.entries(b64urlJson.dec(h) as Record<string, string>)) {
        if (PROXY_REQUEST_HEADERS.includes(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
      }
    } catch { return err('Invalid headers', 400); }
  }
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  const up = await fetch(parsed.toString(), { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'follow' });
  const type = up.headers.get('content-type') ?? '';
  if (/mpegurl/i.test(type) || /\.m3u8($|\?)/i.test(parsed.pathname)) {
    const text = await up.text();
    return new Response(rewritePlaylist(text, up.url || parsed.toString(), self), {
      status: up.status,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
    });
  }
  const out = new Headers();
  for (const k of PASS_RESPONSE_HEADERS) { const v = up.headers.get(k); if (v) out.set(k, v); }
  if (!out.has('accept-ranges') && up.status === 206) out.set('accept-ranges', 'bytes');
  out.set('Cache-Control', 'no-store');
  return new Response(req.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}

export const encodeProxyHeaders = b64urlJson.enc;

// ─── Router ─────────────────────────────────────────────────────────────────

export async function handleApi(req: Request, env: Env, bindings: ApiBindings = {}): Promise<Response> {
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  let res: Response;

  // Optional shared secret: protects server-side keys (e.g. your Debrid account) from strangers.
  // <video> and media fetches can't send custom headers, so the token may also come as ?t=.
  const token = req.headers.get('x-access-token') ?? url.searchParams.get('t');
  if (env.ACCESS_TOKEN && path !== '/api/config' && path !== '' && token !== env.ACCESS_TOKEN) {
    res = err('Access token required — enter it in the app Settings.', 401);
  } else {
    try {
      const get = req.method === 'GET';
      if (path === '' || path === '/api') res = json({ ok: true, service: 'streamdeck-api' });
      else if (path === '/api/config' && get) res = config(env, bindings);
      else if (path === '/api/search' && get) res = await search(req, env, url.searchParams);
      else if (path === '/api/tmdb' && get) res = await tmdb(req, env, url.searchParams);
      else if (path === '/api/debrid/resolve' && req.method === 'POST') res = await debridResolve(req, env);
      else if (path === '/api/subtitles' && get) res = await subtitles(req, env, url.searchParams);
      else if (path === '/api/subtitles/file' && get) res = await subtitleFile(req, env, url.searchParams);
      else if (path === '/api/translate' && req.method === 'POST') res = await translate(req);
      else if (path === '/api/translate-ai' && req.method === 'POST') res = await translateAi(req, bindings);
      else if (path === '/api/transcribe' && req.method === 'POST') res = await transcribe(req, url.searchParams, bindings);
      else if (path === '/api/proxy' && (get || req.method === 'HEAD')) res = await proxy(req, url);
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
