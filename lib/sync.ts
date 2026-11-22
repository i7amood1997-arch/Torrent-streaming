/**
 * What the user's devices share through their relay: history, watchlist, per-series settings,
 * playback positions. Each collection is a map of entries stamped with the time they changed;
 * merging keeps the newest version of each entry (a removal is an entry too, so it spreads to the
 * other devices instead of the item coming back). Used by the relay (lib/server/userdata.ts) and
 * by the app.
 */

export type SyncCollection = 'history' | 'watchlist' | 'prefs' | 'progress';
export const COLLECTIONS: SyncCollection[] = ['history', 'watchlist', 'prefs', 'progress'];

export interface SyncEntry<T = unknown> {
  /** When it last changed (ms since 1970). */
  at: number;
  /** The value; absent when it was removed. */
  v?: T;
}

export type SyncState = Record<SyncCollection, Record<string, SyncEntry>>;

export const emptyState = (): SyncState => ({ history: {}, watchlist: {}, prefs: {}, progress: {} });

/** Removals are kept this long so every device hears about them, then forgotten. */
const TOMBSTONE_MS = 60 * 24 * 3600 * 1000;
/** Upper bounds, so a state can't grow without limit. */
const LIMITS: Record<SyncCollection, number> = { history: 60, watchlist: 500, prefs: 500, progress: 800 };

/** The newest version of every entry from both sides (a, then b, wins ties). */
export function mergeState(a: Partial<SyncState> | undefined, b: Partial<SyncState> | undefined, now = Date.now()): SyncState {
  const out = emptyState();
  for (const c of COLLECTIONS) {
    const m: Record<string, SyncEntry> = {};
    for (const side of [a?.[c], b?.[c]]) {
      if (!side || typeof side !== 'object') continue;
      for (const [k, e] of Object.entries(side)) {
        if (!e || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
        const at = Math.min(e.at, now + 60_000); // a device with its clock far ahead can't win forever
        if (!m[k] || at > m[k].at) m[k] = e.v === undefined ? { at } : { at, v: e.v };
      }
    }
    const kept = Object.entries(m)
      .filter(([, e]) => e.v !== undefined || now - e.at < TOMBSTONE_MS)
      .sort((x, y) => y[1].at - x[1].at)
      .slice(0, LIMITS[c]);
    out[c] = Object.fromEntries(kept);
  }
  return out;
}

/** The live values of a collection, newest first. */
export function values<T>(s: SyncState, c: SyncCollection): { key: string; at: number; v: T }[] {
  return Object.entries(s[c])
    .filter(([, e]) => e.v !== undefined)
    .map(([key, e]) => ({ key, at: e.at, v: e.v as T }))
    .sort((x, y) => y.at - x.at);
}

/** A new random secret: the sync key (shared by the user's devices) and pairing codes. */
export function randomKey(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A pairing code people can read off a TV and type: 8 letters/digits without look-alikes. */
export function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => alphabet[x % alphabet.length]).join('');
}

export const PAIR_CODE = /^[A-HJKMNP-Z2-9]{8}$/;
export const SYNC_KEY = /^[a-f0-9]{32}$/;
