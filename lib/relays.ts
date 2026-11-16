/**
 * Public CORS relays: fallback for keyless indexer GET requests when a site is
 * blocked for the browser (no CORS headers, or blocked by the user's ISP).
 *
 * Privacy: relays are third-party services. They see the URL being fetched (i.e.
 * the search terms), so ONLY keyless indexer requests may use them. Never route
 * requests that carry API keys (Debrid, subtitles, TMDB, Torznab) through here.
 */
import './runtime'; // older Safari: AbortSignal.timeout

export interface Relay {
  name: string;
  wrap: (url: string) => string;
}

export const PUBLIC_RELAYS: Relay[] = [
  { name: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  { name: 'corsproxy', wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
];

/** Relay that last worked for a host — tried first next time (per page session). */
const preferred = new Map<string, number>();

/**
 * Fetch JSON directly; if that fails, try each relay. The relay that works is
 * remembered per host. Parsing is part of the attempt, so a relay returning an
 * HTML error page with HTTP 200 counts as a failure.
 */
export async function fetchJsonWithRelays<T>(
  url: string,
  direct: () => Promise<T>,
  opts: { timeoutMs: number; relays?: Relay[] },
): Promise<T> {
  const host = new URL(url).host;
  const relays = opts.relays ?? PUBLIC_RELAYS;
  const pref = preferred.get(host);
  // A host known to need a relay skips the (slow, failing) direct attempt.
  if (pref == null) {
    try {
      return await direct();
    } catch (e) {
      if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e; // real HTTP/parse error → don't relay
    }
  }
  const attempt = async (i: number, signal: AbortSignal): Promise<T> => {
    const res = await fetch(relays[i].wrap(url), { signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]) : signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as T;
    preferred.set(host, i);
    return data;
  };
  const failures: string[] = new Array(relays.length);
  // The relay that worked last time first; if it fails, all the others at once.
  if (pref != null) {
    try { return await attempt(pref, AbortSignal.timeout(opts.timeoutMs)); } catch (e) { failures[pref] = `${relays[pref].name}: ${e instanceof Error ? e.message : String(e)}`; }
  }
  const ctl = new AbortController();
  const others = [...relays.keys()].filter((i) => i !== pref);
  try {
    const data = await Promise.any(others.map((i) => attempt(i, ctl.signal).catch((e) => {
      failures[i] = `${relays[i].name}: ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    })));
    ctl.abort(); // the slower ones aren't needed
    return data;
  } catch {
    preferred.delete(host);
    throw new RelayError(`unreachable directly and through public relays (${failures.filter(Boolean).join('; ')})`);
  }
}

export class RelayError extends Error {}
