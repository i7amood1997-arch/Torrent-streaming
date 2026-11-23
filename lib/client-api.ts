'use client';
import './runtime'; // older Safari: AbortSignal.timeout
import { DEFAULT_API_BASE } from './config';
import { parseMagnet } from './magnet';
import { useApp, type ServerCaps } from './store';
import type { SessionStats } from './bt/session';
import { googleTranslate } from './translate';
import type { Transcript } from './speech/generate';

export type StreamStats = SessionStats;
export type StreamPrepare =
  | { status: 'ready'; fileIdx: number; fileName: string; size: number; mime: string; path: string; stats: StreamStats }
  | { status: 'pending'; stats: StreamStats }
  | { status: 'error'; message: string };
import type { ResolvedStream, SearchResponse, SubtitleCue, SubtitleTrackInfo, TmdbDetails, TmdbEpisode, TmdbItem, TorrentResult } from './types';

/** Backend base URL: Settings override → build-time default (may be '' = not configured). */
export function apiBase(): string {
  return (useApp.getState().settings.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
}

/**
 * Settings for "direct mode" (no backend): every source is available and the
 * user's own Settings choose which ones run. Keys still come from request headers.
 */
export const directEnv = (): Record<string, string> => ({
  INDEXERS: 'torrentio,torznab,yts,eztv,apibay,knaben,torrentscsv,nyaa,animetosho,mediafusion,addons,archive,torrentsdb,bitsearch',
  ALLOW_CLIENT_TORZNAB: 'true',
  USE_PUBLIC_RELAYS: String(useApp.getState().settings.publicRelays),
});

/**
 * Transport: with a backend URL, a normal cross-origin fetch. Without one, the very
 * same handler code runs in this browser tab (lazy-loaded) and calls each service directly.
 */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const base = apiBase();
  if (base) return fetch(base + path, init);
  const { handleApi } = await import('./server/handlers');
  init.signal?.throwIfAborted();
  return handleApi(new Request(new URL(path, location.origin), init), directEnv());
}

/** Headers carrying the user's keys (shared with the progressive search). */
export const apiHeaders = () => headers();

function headers(): Record<string, string> {
  const s = useApp.getState().settings;
  const h: Record<string, string> = {};
  if (s.accessToken) h['x-access-token'] = s.accessToken;
  if (s.tmdbKey) h['x-tmdb-key'] = s.tmdbKey;
  const dk = s.debridKeys[s.debridProvider];
  if (dk) h['x-debrid-key'] = dk;
  if (s.openSubtitlesKey) h['x-opensubtitles-key'] = s.openSubtitlesKey;
  if (s.subdlKey) h['x-subdl-key'] = s.subdlKey;
  if (s.stremioAddons?.trim()) h['x-stremio-addons'] = s.stremioAddons.trim().split(/\s+/).join(' ');
  if (s.torznabUrl) {
    h['x-torznab-url'] = s.torznabUrl;
    if (s.torznabKey) h['x-torznab-key'] = s.torznabKey;
  }
  return h;
}

async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const res = await call(`${path}?${qs}`, { headers: headers(), signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  tmdbSearch: (q: string, signal?: AbortSignal) => get<{ results: TmdbItem[] }>('/api/tmdb', { action: 'search', q }, signal),
  tmdbTrending: (signal?: AbortSignal) => get<{ results: TmdbItem[] }>('/api/tmdb', { action: 'trending' }, signal),
  shelf: (type: string, genre?: string, signal?: AbortSignal) => get<{ results: TmdbItem[] }>('/api/tmdb', { action: 'shelf', type, genre }, signal),
  tmdbDetails: (type: string, id: number) => get<TmdbDetails>('/api/tmdb', { action: 'details', type, id }),
  tmdbSeason: (id: number, season: number) => get<{ episodes: TmdbEpisode[] }>('/api/tmdb', { action: 'season', id, season }),

  search: (p: { q?: string; imdb?: string; tmdb?: number; type?: string; season?: number; episode?: number; title?: string; year?: number }, signal?: AbortSignal) =>
    get<SearchResponse>('/api/search', { ...p, indexers: useApp.getState().settings.indexers.join(',') }, signal),

  /** A free-library row (Internet Archive collection) and the file to play for one of its titles. */
  archiveShelf: (collection: string, signal?: AbortSignal) => get<{ results: import('./server/handlers').ArchiveItem[] }>('/api/archive', { collection }, signal),
  archivePlay: (id: string) => get<{ url: string; title: string; fileName?: string }>('/api/archive/play', { id }),

  /** Intro / recap / credits times for an episode or movie (TheIntroDB, through the relay). */
  segments: (p: { tmdb?: number; imdb?: string; type?: string; season?: number; episode?: number; duration?: number }, signal?: AbortSignal) =>
    get<import('./server/handlers').Segments>('/api/segments', p, signal),

  subtitles: (p: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    get<{ tracks: SubtitleTrackInfo[]; errors: { provider: string; message: string }[] }>('/api/subtitles', p, signal),
  subtitleCues: (token: string, signal?: AbortSignal) => get<{ cues: SubtitleCue[] }>('/api/subtitles/file', { token }, signal),

  /** Translate newline-separated lines: straight from this browser, else through the relay. */
  async translate(text: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
    try {
      return await googleTranslate(text, from, to, signal);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || !apiBase()) throw e;
      const res = await call('/api/translate', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text, from, to }), signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body.text as string;
    }
  },

  /** Subtitle lines translated by an AI model on the relay (context-aware, better Arabic). */
  async translateAI(lines: string[], context: string[], from: string, to: string, title: string | undefined, signal?: AbortSignal, lastResort = false): Promise<(string | undefined)[]> {
    const base = apiBase();
    if (!base) throw Object.assign(new Error('AI translation needs your relay.'), { fatal: true });
    const res = await fetch(`${base}/api/translate-ai`, {
      // lastResort: Google already refused, so the relay may use Claude if Workers AI can't help.
      method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ lines, context, from, to, title, ...(lastResort ? { lastResort: true } : {}) }), signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.lines)) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { fatal: !!body.fatal || res.status === 501 });
    return body.lines as (string | undefined)[];
  },

  /** Speech → text on the relay (Workers AI Whisper). */
  async transcribe(audio: { bytes: Uint8Array; mime: string }, opts: { language?: string }, signal?: AbortSignal): Promise<Transcript> {
    const base = apiBase();
    if (!base) throw Object.assign(new Error('Generating subtitles needs your relay.'), { fatal: true });
    // 16 kHz mono WAV: accepted by every speech service the relay may use (Cloudflare, then Groq).
    const wav = /wav|flac|ogg|mpeg/.test(audio.mime) ? undefined : await (await import('./audio-energy')).toWav16k(audio.bytes);
    const body = wav ? { bytes: wav, mime: 'audio/wav' } : audio;
    const res = await fetch(`${base}/api/transcribe${opts.language ? `?lang=${encodeURIComponent(opts.language)}` : ''}`, {
      method: 'POST', headers: { ...headers(), 'Content-Type': body.mime }, body: body.bytes as BodyInit, signal,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error ?? `HTTP ${res.status}`), { fatal: !!out.fatal || res.status === 501 });
    return out as Transcript;
  },

  /** Built-in cloud streaming: ask the relay to open the torrent. Poll until `ready`. */
  async streamPrepare(r: TorrentResult, ctx: { season?: number; episode?: number }, signal?: AbortSignal): Promise<StreamPrepare> {
    const res = await call(`/api/stream/${r.infoHash}/prepare`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackers: parseMagnet(r.magnet)?.trackers ?? [], fileIdx: r.fileIdx, ...ctx }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as StreamPrepare;
  },
  streamStatus: (infoHash: string, signal?: AbortSignal) => get<StreamStats>(`/api/stream/${infoHash}/status`, {}, signal),
  /** Absolute video URL for a prepared stream (token in the query: <video> can't send headers). */
  streamUrl(path: string): string {
    const t = useApp.getState().settings.accessToken;
    return apiBase() + path + (t ? `?t=${encodeURIComponent(t)}` : '');
  },
  /** A direct link played through the relay (CORS, required headers, MKV conversion). Undefined without a relay. */
  proxyUrl(url: string, requestHeaders?: Record<string, string>): string | undefined {
    const base = apiBase();
    if (!base) return undefined;
    const u = new URL(base + '/api/proxy');
    u.searchParams.set('url', url);
    if (requestHeaders && Object.keys(requestHeaders).length) {
      const json = JSON.stringify(requestHeaders);
      let bin = '';
      for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
      u.searchParams.set('h', btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    }
    const t = useApp.getState().settings.accessToken;
    if (t) u.searchParams.set('t', t);
    return u.toString();
  },

  /**
   * Debrid services expect requests from the viewer's own connection (Real-Debrid restricts
   * datacenter/VPN IPs, and links can be tied to the IP that created them), so ask from this
   * browser first. Only if the browser can't reach the service (CORS/network) use the relay.
   */
  async resolveDebrid(r: TorrentResult, ctx: { season?: number; episode?: number }, signal?: AbortSignal): Promise<ResolvedStream> {
    const s = useApp.getState().settings;
    const init = (): RequestInit => ({
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: s.debridProvider, magnet: r.magnet, fileIdx: r.fileIdx, ...ctx }),
      signal,
    });
    const parse = async (res: Response) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
      return body as ResolvedStream;
    };
    const { handleApi } = await import('./server/handlers');
    signal?.throwIfAborted();
    try {
      return await parse(await handleApi(new Request(new URL('/api/debrid/resolve', location.origin), init()), directEnv()));
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.name === 'AbortError') throw e;
      const unreachable = err.status === 500 || /blocked by the browser|failed to fetch|load failed|network/i.test(err.message);
      if (!apiBase() || !unreachable) throw e;
      return parse(await call('/api/debrid/resolve', init()));
    }
  },

  /** Which of these torrents the debrid service can play at once (same browser-first route as resolve). */
  async checkDebridCache(items: { infoHash: string; magnet: string; fileIdx?: number; season?: number; episode?: number }[], signal?: AbortSignal): Promise<Record<string, 'instant' | 'not' | 'unknown'>> {
    const s = useApp.getState().settings;
    const init = (): RequestInit => ({ method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: s.debridProvider, items }), signal });
    const parse = async (res: Response) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
      return (body.states ?? {}) as Record<string, 'instant' | 'not' | 'unknown'>;
    };
    const { handleApi } = await import('./server/handlers');
    try {
      return await parse(await handleApi(new Request(new URL('/api/debrid/check', location.origin), init()), directEnv()));
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.name === 'AbortError' || !apiBase()) throw e;
      return parse(await call('/api/debrid/check', init()));
    }
  },

  /** Probe capabilities. Direct mode never "fails"; a configured-but-unreachable backend sets `offline`. */
  async loadCaps() {
    const set = useApp.getState().setCaps;
    const base = apiBase();
    if (!base) {
      const res = await call('/api/config');
      return set({ ...(await res.json()), direct: true });
    }
    const offline = (reason: string): ServerCaps => ({
      tmdb: false, debrid: { realdebrid: false, torbox: false, debridlink: false, premiumize: false, alldebrid: false },
      subtitles: { opensubtitles: false, subdl: false }, indexers: [], clientTorznab: false, offline: reason,
    });
    try {
      const res = await fetch(base + '/api/config', { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return set(offline(`Backend responded with HTTP ${res.status}.`));
      set(await res.json());
    } catch (e) {
      set(offline(`Can't reach the backend at ${base} (${(e as Error).message}).`));
    }
  },
};
