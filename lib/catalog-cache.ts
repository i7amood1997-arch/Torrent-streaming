/**
 * Catalog answers (Home rows, title details, season episode lists) kept on the device, so what
 * was seen before shows at once, the way native apps open, instead of waiting for the relay
 * every time. Each answer is fresh for a while; after that it is asked for again, and the saved
 * copy is still used if the relay can't be reached. Only the most recent answers are kept.
 */
export interface CacheStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

interface Entry { at: number; v: unknown }

const PREFIX = 'cat:';
const INDEX = 'cat:index';

export function makeCache(store: CacheStore, now: () => number = Date.now, max = 80) {
  const mem = new Map<string, Entry>();
  const inflight = new Map<string, Promise<unknown>>();

  const read = (key: string): Entry | undefined => {
    if (mem.has(key)) return mem.get(key);
    try {
      const raw = store.getItem(PREFIX + key);
      const e = raw ? (JSON.parse(raw) as Entry) : undefined;
      if (e && typeof e.at === 'number') { mem.set(key, e); return e; }
    } catch { /* unreadable: as if not saved */ }
    return undefined;
  };
  const index = (): string[] => {
    try { const v = JSON.parse(store.getItem(INDEX) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  const write = (key: string, v: unknown) => {
    const e = { at: now(), v };
    mem.set(key, e);
    try {
      const keys = [...index().filter((k) => k !== key), key];
      while (keys.length > max) {
        const old = keys.shift()!;
        store.removeItem(PREFIX + old);
        mem.delete(old);
      }
      store.setItem(PREFIX + key, JSON.stringify(e));
      store.setItem(INDEX, JSON.stringify(keys));
    } catch { /* storage full or blocked: kept for this session only */ }
  };

  return {
    /** The saved answer, however old (to show something at once), or undefined. */
    peek<T>(key: string): T | undefined {
      return read(key)?.v as T | undefined;
    },
    /** A fresh-enough saved answer, else the relay's (the saved one if the relay fails). `keep` says if it's worth saving. */
    get<T>(key: string, freshMs: number, fetcher: () => Promise<T>, keep: (v: T) => boolean = () => true): Promise<T> {
      const e = read(key);
      if (e && now() - e.at < freshMs) return Promise.resolve(e.v as T);
      const running = inflight.get(key);
      if (running) return running as Promise<T>;
      const p = fetcher()
        .then((v) => { if (keep(v)) write(key, v); return v; })
        .catch((err) => { if (e) return e.v as T; throw err; })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
