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
import { animeShelf, ANIME_LISTS, type AnimeList } from './anime';
import ANIME_MAP from './anime-map.json';
import { checkRealDebridCache, DebridError, envDebridKey, resolveDebridStream } from '../debrid';
import { parseMagnet } from '../magnet';
import { fetchSubtitleCues, searchSubtitles, type SubtitleKeys } from '../subtitles';
import { createTmdbClient, TmdbError } from '../tmdb';
import { ALL_INDEXERS, configFromEnv, parseAddonList, pickArchiveFile, searchTorrents, type IaFile, type IndexerId } from '../torrent-indexer';
import { cinemeta } from '../cinemeta';
import { describeError } from '../runtime';
import { toVtt } from '../subtitle-parser';
import { INTRODB, parseSegments, type Segments } from '../segments';
export { parseSegments, type Segments } from '../segments';
import { buildSubtitlePrompt, googleTranslate, parseNumberedLines, readLlmText } from '../translate';
import type { DebridProvider, SearchQuery } from '../types';
// Type only: the Claude client is made in the Worker (worker/index.ts), keeping the SDK out of the web app.
import type Anthropic from '@anthropic-ai/sdk';

export type Env = Record<string, string | undefined>;

/** Non-string bindings (Cloudflare): Workers AI for speech recognition. */
export interface ApiBindings {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Tests only: stands in for fetch when calling Groq. */
  groqFetch?: typeof fetch;
  /** Tests only: stands in for fetch when calling TheIntroDB. */
  introFetch?: typeof fetch;
  /** Tests only: stands in for fetch when reading the keyless catalog (Cinemeta). */
  catalogFetch?: typeof fetch;
  /** Tests only: stands in for fetch when calling the Internet Archive. */
  archiveFetch?: typeof fetch;
  /** Claude API client (Worker only, when ANTHROPIC_API_KEY is set): the last-resort translator. */
  claude?: Pick<Anthropic, 'messages'>;
  /** Small per-user storage (Worker only): TV pairing and syncing between devices (lib/server/userdata.ts). */
  USERDATA?: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
}

/** One action on the relay's user storage (a Durable Object per name). */
export function userDataCall(ns: NonNullable<ApiBindings['USERDATA']>, name: string, op: string, body?: unknown): Promise<Response> {
  return ns.get(ns.idFromName(name)).fetch(new Request('https://userdata.internal/', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-op': op, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

/** Pairing (/api/pair…), sync (/api/sync/<key>) and alerts (/api/push…): handed to the user's storage on the relay. */
async function userStore(req: Request, path: string, bindings: ApiBindings): Promise<Response | undefined> {
  const pair = path.match(/^\/api\/pair(?:\/([A-Z0-9]{8}))?(\/take)?$/);
  const sync = path.match(/^\/api\/sync\/([a-f0-9]{32})$/);
  const push = path.match(/^\/api\/push\/(key|[a-f0-9]{32})(?:\/(remove|test))?$/);
  if (!pair && !sync && !push) return undefined;
  if (!bindings.USERDATA) return err('This relay has no storage for pairing or sync yet. Update it (redeploy).', 501);
  const ns = bindings.USERDATA;
  const call = async (name: string, op: string, body?: string) => {
    return userDataCall(ns, name, op, body);
  };
  if (push) {
    if (push[1] === 'key') return userDataCall(ns, 'push-index', 'vapid-get', { subject: new URL(req.url).origin });
    if (req.method !== 'POST') return err('Not found', 404);
    const key = push[1];
    if (push[2] === 'test') {
      const vapid = await (await userDataCall(ns, 'push-index', 'vapid-full', { subject: new URL(req.url).origin })).json();
      return userDataCall(ns, `sync:${key}`, 'push-test', { vapid });
    }
    const body = await req.text();
    const res = await userDataCall(ns, `sync:${key}`, push[2] === 'remove' ? 'push-unsub' : 'push-sub', body);
    const out = (await res.json()) as { devices?: number; error?: string };
    if (res.ok) await userDataCall(ns, 'push-index', push[2] === 'remove' && !out.devices ? 'index-remove' : 'index-add', { key });
    return json(out, res.status);
  }
  if (sync) return call(`sync:${sync[1]}`, req.method === 'POST' ? 'sync-merge' : 'sync-get', req.method === 'POST' ? await req.text() : undefined);
  const code = pair![1];
  if (!code) {
    if (req.method !== 'POST') return err('Not found', 404);
    const { pairingCode, randomKey } = await import('../sync');
    const newCode = pairingCode();
    const secret = randomKey();
    const res = await call(`pair:${newCode}`, 'pair-open', JSON.stringify({ secret }));
    const body = (await res.json()) as { expires?: number };
    return json({ code: newCode, secret, expires: body.expires });
  }
  if (pair![2]) {
    return ns.get(ns.idFromName(`pair:${code}`)).fetch(new Request(req.url, { headers: { 'x-op': 'pair-take' } }));
  }
  return req.method === 'POST' ? call(`pair:${code}`, 'pair-send', await req.text()) : call(`pair:${code}`, 'pair-check');
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
    debrid: { realdebrid: !!env.REALDEBRID_API_KEY, torbox: !!env.TORBOX_API_KEY, debridlink: !!env.DEBRIDLINK_API_KEY, premiumize: !!env.PREMIUMIZE_API_KEY, alldebrid: !!env.ALLDEBRID_API_KEY },
    subtitles: { opensubtitles: !!env.OPENSUBTITLES_API_KEY, subdl: !!env.SUBDL_API_KEY },
    indexers: c.enabled.filter((i) => i !== 'torznab' || !!c.torznabUrl),
    clientTorznab: env.ALLOW_CLIENT_TORZNAB === 'true',
    accessToken: !!env.ACCESS_TOKEN,
    stream: env.STREAM_ENABLED === 'true',
    ai: !!b.AI,
    claude: !!b.claude,
    /** TV pairing and syncing between devices. */
    sync: !!b.USERDATA,
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
      case 'anime': {
        const list = sp.get('list') as AnimeList;
        if (!ANIME_LISTS.includes(list)) return err('list must be one of: ' + ANIME_LISTS.join(', '), 400);
        const results = await animeShelf(list, { fetch: (u, i) => fetch(u, i), map: ANIME_MAP as Record<string, string>, useTmdb: !!apiKey, search: (q) => client.search(q) });
        return json({ results }, 200, { 'Cache-Control': `public, max-age=${results.length ? 10800 : 300}` });
      }
      default:
        return err('Unknown action', 400);
    }
  } catch (e) {
    return err(describeError(e), e instanceof TmdbError ? e.status : 500);
  }
}

const PROVIDERS: DebridProvider[] = ['realdebrid', 'torbox', 'debridlink', 'premiumize', 'alldebrid'];

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

/** POST /api/debrid/check { provider, items: [{ infoHash, magnet, fileIdx?, season?, episode? }] } → { states } */
async function debridCheck(req: Request, env: Env) {
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400); }
  const provider = body?.provider as DebridProvider;
  const apiKey = req.headers.get('x-debrid-key')?.trim() || envDebridKey(provider, env) || '';
  if (provider !== 'realdebrid' || !apiKey) return json({ states: {} }); // other services: not checked (yet)
  const num = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 6).flatMap((x: any) => {
    const p = parseMagnet(String(x?.magnet ?? x?.infoHash ?? ''));
    return p ? [{ infoHash: p.infoHash, magnet: p.magnet, fileIdx: num(x.fileIdx), season: num(x.season), episode: num(x.episode) }] : [];
  });
  try {
    return json({ states: await checkRealDebridCache(apiKey, items) });
  } catch (e) {
    return err(describeError(e), e instanceof DebridError && (e.status === 401 || e.status === 403) ? 401 : 502);
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
        absEpisode: intParam(sp.get('abs')),
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

// ─── Groq (backup speech recognition when the Workers AI allowance is used up) ──

const GROQ_STT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
/** Language names some Whisper APIs return, as ISO codes (the app compares codes). */
const LANG_CODES: Record<string, string> = {
  english: 'en', arabic: 'ar', french: 'fr', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt', russian: 'ru',
  turkish: 'tr', japanese: 'ja', korean: 'ko', chinese: 'zh', hindi: 'hi', persian: 'fa', urdu: 'ur', dutch: 'nl',
  polish: 'pl', swedish: 'sv', indonesian: 'id', thai: 'th', vietnamese: 'vi', greek: 'el', hebrew: 'he',
};
const EXT: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/webm': 'webm' };

interface Transcribed { language?: string; segments: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number; words?: { word: string; start: number; end: number }[] }[] }

export async function groqTranscribe(audio: Uint8Array, contentType: string, lang: string | null, key: string, fetchFn: typeof fetch = fetch): Promise<Transcribed> {
  const form = new FormData();
  const type = contentType.split(';')[0].trim();
  form.append('file', new Blob([audio as BlobPart], { type }), `audio.${EXT[type] ?? 'wav'}`);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  if (lang && /^[a-z]{2}$/.test(lang)) form.append('language', lang);
  const res = await fetchFn(GROQ_STT, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `Groq HTTP ${res.status}`), { status: res.status });
  const raw = String(body.language ?? '').toLowerCase();
  const language = /^[a-z]{2}$/.test(raw) ? raw : LANG_CODES[raw];
  const words: { word: string; start: number; end: number }[] = Array.isArray(body.words) ? body.words : [];
  const segments = (Array.isArray(body.segments) ? body.segments : []).map((s: any) => ({
    start: s.start, end: s.end, text: String(s.text ?? ''), no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob,
    // Word times may come per segment or in one list for the whole clip.
    words: Array.isArray(s.words) ? s.words : words.filter((w) => w.start >= s.start - 0.05 && w.start < s.end),
  }));
  return { language, segments };
}

async function transcribe(req: Request, sp: URLSearchParams, b: ApiBindings, env: Env) {
  const groqKey = env.GROQ_API_KEY;
  if (!b.AI && !groqKey) return err('Speech recognition isn’t set up on this relay (it needs the Workers AI binding, added automatically on the next deploy).', 501);
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length) return err('audio required', 400);
  if (audio.length > 25 << 20) return err('audio clip too large', 413);
  const lang = sp.get('lang');
  const opts = { vad_filter: true, condition_on_previous_text: false, ...(lang && /^[a-z]{2,3}$/.test(lang) ? { language: lang } : {}) };
  const contentType = req.headers.get('content-type') || 'application/octet-stream';
  /** Cloudflare's free allowance is used up (or there is no Workers AI): Groq, if the relay has a key. */
  const viaGroq = async () => {
    try {
      return finishTranscript(await groqTranscribe(audio, contentType, lang, groqKey!, b.groqFetch));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429) return json({ error: 'Today’s free speech-recognition allowances (Cloudflare and Groq) are used up. They reset daily.', fatal: true }, 429);
      if (status === 401 || status === 403) return json({ error: 'The Groq key on your relay was rejected.', fatal: true }, 502);
      return err(`Speech recognition failed (Groq): ${describeError(e)}`, 502);
    }
  };
  if (!b.AI) return viaGroq();
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
      if (groqKey) return viaGroq();
      return json({ error: 'Today’s free speech-recognition allowance on your relay is used up (about 3½ hours of audio a day). It resets daily.', fatal: true }, 429);
    }
    return err(`Speech recognition failed: ${m}`, 502);
  }
  return finishTranscript({ language: out.transcription_info?.language, segments: out.segments ?? [] });
}

/** Drop silence/hallucinated lines and return the app's transcript shape. */
function finishTranscript(out: Transcribed) {
  const segments = (out.segments ?? [])
    .filter((s) => s.text?.trim() && !((s.no_speech_prob ?? 0) > 0.8) && !((s.avg_logprob ?? 0) < -1.2))
    .map((s) => ({
      start: s.start, end: s.end, text: s.text.trim(),
      words: s.words?.map((w) => ({ word: w.word, start: w.start, end: w.end })),
    }));
  return json({ language: out.language, segments });
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

// ─── Intro / recap / credits times (TheIntroDB) ─────────────────────────────



/** Community-submitted times (seconds) for an episode or movie, or {} when none are known. */
/**
 * The ids TheIntroDB knows a show by, from its IMDb id: the keyless catalog (Cinemeta) lists
 * the TVDB id (TheIntroDB's own key) and the TMDB id. For relays without a TMDB key.
 */
async function idsFromImdb(imdb: string, type: 'movie' | 'series', f: typeof fetch): Promise<{ tvdb?: number; tmdb?: number }> {
  try {
    const res = await f(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    const m = ((await res.json()) as { meta?: { tvdb_id?: number | string; moviedb_id?: number | string } }).meta ?? {};
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
    return { tvdb: num(m.tvdb_id), tmdb: num(m.moviedb_id) };
  } catch {
    return {};
  }
}

/** Community-submitted times (seconds) for an episode or movie, or {} when none are known. */
async function segments(q: URLSearchParams, bindings: ApiBindings, env: Env = {}): Promise<Response> {
  let tmdb = intParam(q.get('tmdb'));
  const imdb = /^tt\d{6,9}$/.test(q.get('imdb') ?? '') ? q.get('imdb')! : '';
  const type = q.get('type') === 'series' ? 'series' : 'movie';
  const season = intParam(q.get('season'));
  const episode = intParam(q.get('episode'));
  const duration = Number(q.get('duration')) || 0;
  if (type === 'series' && (season == null || episode == null)) return err('season and episode are needed', 400);
  const f = bindings.introFetch ?? fetch;
  // No TMDB id (a relay without a TMDB key): find the show's TVDB / TMDB id from its IMDb id.
  let tvdb: number | undefined;
  if (!tmdb && imdb) ({ tvdb, tmdb } = await idsFromImdb(imdb, type, bindings.catalogFetch ?? f));
  const qs = new URLSearchParams();
  if (tvdb) qs.set('tvdb_id', String(tvdb));
  else if (tmdb) qs.set('tmdb_id', String(tmdb));
  // An IMDb id is unambiguous only for a movie (for an episode it could mean the series or the episode).
  else if (type === 'movie' && imdb) qs.set('imdb_id', imdb);
  else return json({}, 200, { 'Cache-Control': 'public, max-age=86400', 'X-Segments': 'no id' });
  if (type === 'series') {
    qs.set('season', String(season));
    qs.set('episode', String(episode));
  }
  if (duration > 60) qs.set('duration_ms', String(Math.round(duration * 1000)));
  // What was asked and what came back, for diagnosing a missing Skip button (no personal data).
  const asked = [...qs.keys()].filter((k) => k.endsWith('_id')).map((k) => `${k}=${qs.get(k)}`).join(' ');
  try {
    // With a TheIntroDB key (free account) the relay gets its own rate limit; without one it
    // shares Cloudflare's addresses with everyone else's requests and is often turned away (429).
    const auth: Record<string, string> = env.THEINTRODB_API_KEY ? { Authorization: `Bearer ${env.THEINTRODB_API_KEY}` } : {};
    const res = await f(`${INTRODB}?${qs}`, { headers: { 'User-Agent': 'streamdeck-relay', Accept: 'application/json', ...auth } });
    if (!res.ok) {
      // Turned away (shared Cloudflare address over its limit): hand the app the query, so it can
      // ask TheIntroDB itself from the viewer's own connection, which has its own allowance.
      const busy = res.status === 429 || res.status >= 500;
      return json(busy ? { ask: qs.toString() } : {}, 200, { 'Cache-Control': res.status === 404 ? 'public, max-age=21600' : 'no-store', 'X-Segments': `${asked} -> HTTP ${res.status} (retry ${res.headers.get('retry-after') ?? '-'})` });
    }
    const out = parseSegments(await res.json());
    return json(out, 200, { 'Cache-Control': 'public, max-age=43200', 'X-Segments': `${asked} -> ${Object.keys(out).join(',') || 'none'}` });
  } catch (e) {
    return json({}, 200, { 'Cache-Control': 'no-store', 'X-Segments': `${asked} -> ${(e as Error).message}` });
  }
}


// ─── Free libraries (Internet Archive collections) ─────────────────────────

/** Collections the app offers as rows: public-domain and openly licensed films. */
export const ARCHIVE_COLLECTIONS = ['feature_films', 'Film_Noir', 'SciFi_Horror', 'animationandcartoons', 'silent_films', 'classic_tv'];

export interface ArchiveItem { id: string; title: string; year?: number; poster: string }

async function archiveShelf(env: Env, sp: URLSearchParams, b: ApiBindings): Promise<Response> {
  const c = sp.get('collection') ?? '';
  if (!ARCHIVE_COLLECTIONS.includes(c)) return err('Unknown collection', 400);
  const base = (env.ARCHIVE_URL || 'https://archive.org').replace(/\/+$/, '');
  const q = `collection:(${c}) AND mediatype:(movies)`;
  const f = b.archiveFetch ?? fetch;
  const res = await f(`${base}/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=year&sort[]=downloads+desc&rows=40&output=json`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return err(`Internet Archive: HTTP ${res.status}`, 502);
  const body = (await res.json()) as { response?: { docs?: { identifier: string; title?: string; year?: string | number }[] } };
  const results: ArchiveItem[] = (body.response?.docs ?? [])
    .filter((d) => d.identifier && d.title)
    .map((d) => ({ id: d.identifier, title: String(d.title).slice(0, 120), year: Number(String(d.year ?? '').slice(0, 4)) || undefined, poster: `${base}/services/img/${encodeURIComponent(d.identifier)}` }));
  // An empty answer may be a passing hiccup: don't let it hide the row for a day.
  return json({ results }, 200, { 'Cache-Control': results.length ? 'public, max-age=86400' : 'public, max-age=300' });
}

async function archivePlay(env: Env, sp: URLSearchParams, b: ApiBindings): Promise<Response> {
  const id = sp.get('id') ?? '';
  if (!/^[\w.-]{1,120}$/.test(id)) return err('Bad id', 400);
  const base = (env.ARCHIVE_URL || 'https://archive.org').replace(/\/+$/, '');
  const f = b.archiveFetch ?? fetch;
  const res = await f(`${base}/metadata/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return err(`Internet Archive: HTTP ${res.status}`, 502);
  const m = (await res.json()) as { files?: IaFile[]; metadata?: { title?: string } };
  // Cartoons and shorts are short: anything over two minutes counts.
  const file = pickArchiveFile(m.files ?? [], 120);
  if (!file) return err('This title has no video that plays in a browser.', 404);
  const url = `${base}/download/${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`;
  return json({ url, title: m.metadata?.title ?? id, fileName: file.name.split('/').pop() }, 200, { 'Cache-Control': 'public, max-age=86400' });
}

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
  // Pairing and sync carry their own secrets (a new TV doesn't know the access token yet).
  const ownSecret = /^\/api\/(pair|sync|push)(\/|$)/.test(path);
  if (env.ACCESS_TOKEN && path !== '/api/config' && path !== '' && !ownSecret && token !== env.ACCESS_TOKEN) {
    res = err('Access token required — enter it in the app Settings.', 401);
  } else {
    try {
      const get = req.method === 'GET';
      const stored = ownSecret ? await userStore(req, path, bindings) : undefined;
      if (stored) res = new Response(stored.body, stored);
      else if (path === '' || path === '/api') res = json({ ok: true, service: 'streamdeck-api' });
      else if (path === '/api/config' && get) res = config(env, bindings);
      else if (path === '/api/search' && get) res = await search(req, env, url.searchParams);
      else if (path === '/api/tmdb' && get) res = await tmdb(req, env, url.searchParams);
      else if (path === '/api/debrid/resolve' && req.method === 'POST') res = await debridResolve(req, env);
      else if (path === '/api/debrid/check' && req.method === 'POST') res = await debridCheck(req, env);
      else if (path === '/api/subtitles' && get) res = await subtitles(req, env, url.searchParams);
      else if (path === '/api/subtitles/file' && get) res = await subtitleFile(req, env, url.searchParams);
      else if (path === '/api/translate' && req.method === 'POST') res = await translate(req);
      else if (path === '/api/translate-ai' && req.method === 'POST') res = await translateAi(req, bindings);
      else if (path === '/api/transcribe' && req.method === 'POST') res = await transcribe(req, url.searchParams, bindings, env);
      else if (path === '/api/proxy' && (get || req.method === 'HEAD')) res = await proxy(req, url);
      else if (path === '/api/segments' && get) res = await segments(url.searchParams, bindings, env);
      else if (path === '/api/archive' && get) res = await archiveShelf(env, url.searchParams, bindings);
      else if (path === '/api/archive/play' && get) res = await archivePlay(env, url.searchParams, bindings);
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
