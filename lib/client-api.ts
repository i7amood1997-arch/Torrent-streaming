'use client';
import { DEFAULT_API_BASE } from './config';
import { useApp, type ServerCaps } from './store';
import type { ResolvedStream, SearchResponse, SubtitleCue, SubtitleTrackInfo, TmdbDetails, TmdbEpisode, TmdbItem, TorrentResult } from './types';

/** Backend base URL: Settings override → build-time default (may be '' = not configured). */
export function apiBase(): string {
  return (useApp.getState().settings.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function endpoint(path: string): string {
  const base = apiBase();
  if (!base) throw new Error('No API backend configured — add your Worker URL in Settings.');
  return base + path;
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
  const res = await fetch(`${endpoint(path)}?${qs}`, { headers: headers(), signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  tmdbSearch: (q: string, signal?: AbortSignal) => get<{ results: TmdbItem[] }>('/api/tmdb', { action: 'search', q }, signal),
  tmdbTrending: (signal?: AbortSignal) => get<{ results: TmdbItem[] }>('/api/tmdb', { action: 'trending' }, signal),
  tmdbDetails: (type: string, id: number) => get<TmdbDetails>('/api/tmdb', { action: 'details', type, id }),
  tmdbSeason: (id: number, season: number) => get<{ episodes: TmdbEpisode[] }>('/api/tmdb', { action: 'season', id, season }),

  search: (p: { q?: string; imdb?: string; tmdb?: number; type?: string; season?: number; episode?: number; title?: string; year?: number }, signal?: AbortSignal) =>
    get<SearchResponse>('/api/search', p, signal),

  subtitles: (p: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    get<{ tracks: SubtitleTrackInfo[]; errors: { provider: string; message: string }[] }>('/api/subtitles', p, signal),
  subtitleCues: (token: string, signal?: AbortSignal) => get<{ cues: SubtitleCue[] }>('/api/subtitles/file', { token }, signal),

  async resolveDebrid(r: TorrentResult, ctx: { season?: number; episode?: number }, signal?: AbortSignal): Promise<ResolvedStream> {
    const s = useApp.getState().settings;
    const res = await fetch(endpoint('/api/debrid/resolve'), {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: s.debridProvider, magnet: r.magnet, fileIdx: r.fileIdx, ...ctx }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as ResolvedStream;
  },

  /** Probe the backend. On failure, caps get an `offline` reason so the UI can explain instead of hanging. */
  async loadCaps() {
    const offline = (reason: string): ServerCaps => ({
      tmdb: false, debrid: { realdebrid: false, torbox: false, debridlink: false },
      subtitles: { opensubtitles: false, subdl: false }, indexers: [], clientTorznab: false, offline: reason,
    });
    const set = useApp.getState().setCaps;
    if (!apiBase()) return set(offline('No API backend configured yet.'));
    try {
      const res = await fetch(endpoint('/api/config'), { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return set(offline(`Backend responded with HTTP ${res.status}.`));
      set(await res.json());
    } catch (e) {
      set(offline(`Can't reach the backend at ${apiBase()} (${(e as Error).message}).`));
    }
  },
};
