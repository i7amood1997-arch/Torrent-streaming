'use client';
import { DEFAULT_API_BASE } from './config';
import { parseMagnet } from './magnet';
import { useApp, type ServerCaps } from './store';
import type { SessionStats } from './bt/session';

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
const directEnv = (): Record<string, string> => ({
  INDEXERS: 'torrentio,torznab,yts,eztv,apibay',
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

function headers(): Record<string, string> {
  const s = useApp.getState().settings;
  const h: Record<string, string> = {};
  if (s.accessToken) h['x-access-token'] = s.accessToken;
  if (s.tmdbKey) h['x-tmdb-key'] = s.tmdbKey;
  const dk = s.debridKeys[s.debridProvider];
  if (dk) h['x-debrid-key'] = dk;
  if (s.openSubtitlesKey) h['x-opensubtitles-key'] = s.openSubtitlesKey;
  if (s.subdlKey) h['x-subdl-key'] = s.subdlKey;
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
  tmdbDetails: (type: string, id: number) => get<TmdbDetails>('/api/tmdb', { action: 'details', type, id }),
  tmdbSeason: (id: number, season: number) => get<{ episodes: TmdbEpisode[] }>('/api/tmdb', { action: 'season', id, season }),

  async search(p: { q?: string; imdb?: string; tmdb?: number; type?: string; season?: number; episode?: number; title?: string; year?: number }, signal?: AbortSignal): Promise<SearchResponse> {
    const params = { ...p, indexers: useApp.getState().settings.indexers.join(',') };
    const res = await get<SearchResponse>('/api/search', params, signal);
    if (!apiBase()) return res;
    // Sources that refused the relay (rate limits on shared cloud IPs, blocks) often answer the
    // viewer's own connection: retry just those from this browser (with public relays as backup).
    const retry = res.errors.filter((e) => e.indexer !== 'torznab' && /HTTP (429|403|5\d\d)|blocked|fetch failed|timed out|internal error|network/i.test(e.message)).map((e) => e.indexer);
    if (!retry.length) return res;
    try {
      const [{ handleApi }, { mergeResults, sortBySeeders }] = await Promise.all([import('./server/handlers'), import('./torrent-indexer')]);
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...params, indexers: retry.join(',') })) if (v !== undefined && v !== '') qs.set(k, String(v));
      const r = await handleApi(new Request(new URL(`/api/search?${qs}`, location.origin), { headers: headers(), signal }), directEnv());
      if (!r.ok) return res;
      const local = (await r.json()) as SearchResponse;
      const stillFailing = new Map(local.errors.map((e) => [e.indexer, e]));
      return {
        ...res,
        results: sortBySeeders(mergeResults([...res.results, ...local.results])),
        errors: res.errors.flatMap((e) => (retry.includes(e.indexer) ? (stillFailing.has(e.indexer) ? [stillFailing.get(e.indexer)!] : []) : [e])),
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      return res;
    }
  },

  subtitles: (p: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    get<{ tracks: SubtitleTrackInfo[]; errors: { provider: string; message: string }[] }>('/api/subtitles', p, signal),
  subtitleCues: (token: string, signal?: AbortSignal) => get<{ cues: SubtitleCue[] }>('/api/subtitles/file', { token }, signal),

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

  async resolveDebrid(r: TorrentResult, ctx: { season?: number; episode?: number }, signal?: AbortSignal): Promise<ResolvedStream> {
    const s = useApp.getState().settings;
    const res = await call('/api/debrid/resolve', {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: s.debridProvider, magnet: r.magnet, fileIdx: r.fileIdx, ...ctx }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as ResolvedStream;
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
      tmdb: false, debrid: { realdebrid: false, torbox: false, debridlink: false },
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
