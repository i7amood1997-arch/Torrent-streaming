'use client';
/**
 * Progressive torrent search: every source is queried separately and its results
 * are shown as soon as it answers, so one slow or blocked source never holds up
 * the rest.
 *
 * Each source can be reached two ways when a relay is configured: through the
 * relay (Cloudflare) or from this browser (the viewer's own connection, with
 * public relays as backup). Shared cloud IPs get rate-limited by some sites,
 * the viewer's ISP blocks others, so the route that worked is remembered per
 * source, and sources that failed both ways are skipped for a few minutes.
 */
import { apiBase, apiHeaders, directEnv } from './client-api';
import { useApp } from './store';
import type { IndexerError, SearchResponse, TorrentResult } from './types';

export interface SearchParams {
  q?: string;
  imdb?: string;
  tmdb?: number;
  type?: string;
  season?: number;
  episode?: number;
  title?: string;
  year?: number;
}

export interface SearchProgress {
  results: TorrentResult[];
  errors: IndexerError[];
  /** Sources still being searched. */
  pending: string[];
  /** Sources skipped because they failed every way a moment ago. */
  skipped: string[];
  tookMs: number;
  done: boolean;
}

type Route = 'relay' | 'browser';
const ROUTES_KEY = 'ts-source-routes';
const ROUTE_TTL = 6 * 3600_000;
const DEAD_TTL = 5 * 60_000;
const dead = new Map<string, number>();

function loadRoutes(): Record<string, { route: Route; at: number }> {
  try { return JSON.parse(localStorage.getItem(ROUTES_KEY) || '{}'); } catch { return {}; }
}
function rememberRoute(ix: string, route: Route) {
  try {
    const all = loadRoutes();
    all[ix] = { route, at: Date.now() };
    localStorage.setItem(ROUTES_KEY, JSON.stringify(all));
  } catch { /* storage blocked */ }
}
function preferredRoute(ix: string): Route | undefined {
  const r = loadRoutes()[ix];
  return r && Date.now() - r.at < ROUTE_TTL ? r.route : undefined;
}

/** Failures worth retrying the other way (as opposed to e.g. a bad API key). */
const retryable = (msg: string) => /HTTP (4(03|08|29)|5\d\d)|blocked|fetch failed|failed to fetch|timed out|internal error|network|unreachable|load failed/i.test(msg);

function toQuery(p: SearchParams, indexer: string) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...p, indexers: indexer })) if (v !== undefined && v !== '') qs.set(k, String(v));
  return qs;
}

/** The caller's signal plus a time limit (falls back to the caller's signal on older browsers). */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const any = (AbortSignal as any).any as ((s: AbortSignal[]) => AbortSignal) | undefined;
  return any ? any([signal, AbortSignal.timeout(ms)]) : signal;
}

async function viaRelay(p: SearchParams, ix: string, signal: AbortSignal): Promise<SearchResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/search?${toQuery(p, ix)}`, { headers: apiHeaders(), signal: withTimeout(signal, 20_000) });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error((e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as SearchResponse;
}

async function viaBrowser(p: SearchParams, ix: string, signal: AbortSignal): Promise<SearchResponse> {
  const { handleApi } = await import('./server/handlers');
  signal.throwIfAborted();
  const res = await handleApi(new Request(new URL(`/api/search?${toQuery(p, ix)}`, location.origin), { headers: apiHeaders(), signal }), directEnv());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as SearchResponse;
}

async function searchOne(p: SearchParams, ix: string, signal: AbortSignal): Promise<{ results: TorrentResult[]; error?: IndexerError }> {
  const hasRelay = !!apiBase();
  const pref = hasRelay ? preferredRoute(ix) ?? 'relay' : 'browser';
  // Torznab's address and key live on the relay; never send them from the browser when a relay exists.
  const order: Route[] = !hasRelay ? ['browser'] : ix === 'torznab' ? ['relay'] : pref === 'relay' ? ['relay', 'browser'] : ['browser', 'relay'];
  let last: IndexerError | undefined;
  for (const route of order) {
    try {
      const r = route === 'relay' ? await viaRelay(p, ix, signal) : await viaBrowser(p, ix, signal);
      const err = r.errors.find((e) => e.indexer === ix);
      if (!err) {
        if (hasRelay && route !== pref) rememberRoute(ix, route);
        return { results: r.results };
      }
      last = err;
      if (!retryable(err.message)) break;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      last = { indexer: ix, message: (e as Error).message };
      if (!retryable(last.message)) break;
    }
  }
  if (last && retryable(last.message)) dead.set(ix, Date.now());
  return { results: [], error: last };
}

export async function searchProgressive(p: SearchParams, onUpdate: (s: SearchProgress) => void, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  const { mergeResults, sortBySeeders } = await import('./torrent-indexer');
  const caps = useApp.getState().caps;
  const chosen = useApp.getState().settings.indexers.filter((ix) => !caps?.indexers?.length || caps.direct || caps.indexers.includes(ix) || ix !== 'torznab');
  const skipped = chosen.filter((ix) => Date.now() - (dead.get(ix) ?? 0) < DEAD_TTL);
  const active = chosen.filter((ix) => !skipped.includes(ix));

  const parts: TorrentResult[][] = [];
  const errors: IndexerError[] = [];
  const pending = new Set(active);
  const emit = () =>
    onUpdate({
      results: sortBySeeders(mergeResults(parts.flat())),
      errors: [...errors],
      pending: [...pending],
      skipped,
      tookMs: Date.now() - started,
      done: pending.size === 0,
    });
  emit();
  await Promise.all(
    active.map(async (ix) => {
      try {
        const r = await searchOne(p, ix, signal);
        if (signal.aborted) return;
        parts.push(r.results);
        if (r.error) errors.push(r.error);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        errors.push({ indexer: ix, message: (e as Error).message });
      } finally {
        pending.delete(ix);
        if (!signal.aborted) emit();
      }
    }),
  );
}
