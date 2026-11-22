import { describe, expect, it } from 'vitest';
import { handleApi } from '@/lib/server/handlers';
import { userData, PAIR_TTL_MS, type KV } from '@/lib/server/userdata';
import { emptyState, mergeState, pairingCode, PAIR_CODE, values } from '@/lib/sync';

/** Durable Objects stand-in: one Map per name. */
function fakeNamespace(clock = { now: Date.now() }) {
  const stores = new Map<string, Map<string, unknown>>();
  return {
    stores,
    idFromName: (n: string) => n,
    get: (id: unknown) => ({
      fetch: (req: Request) => {
        const name = id as string;
        if (!stores.has(name)) stores.set(name, new Map());
        const m = stores.get(name)!;
        const kv: KV = { get: async (k) => m.get(k) as any, put: async (k, v) => { m.set(k, structuredClone(v)); }, deleteAll: async () => m.clear() };
        return userData(kv, req.headers.get('x-op') ?? '', req, clock.now);
      },
    }),
  };
}

const call = (path: string, init: RequestInit = {}, ns = fakeNamespace(), env: Record<string, string> = {}) =>
  handleApi(new Request(`https://relay.test${path}`, { ...init, headers: { origin: 'https://app.test', 'content-type': 'application/json', ...(init.headers ?? {}) } }), env, { USERDATA: ns });

describe('merging synced state', () => {
  it('keeps the newest version of each entry, and removals win over older values', () => {
    const phone = { ...emptyState(), watchlist: { a: { at: 10, v: 'Dune' }, b: { at: 30 } } };
    const tv = { ...emptyState(), watchlist: { a: { at: 20 }, b: { at: 20, v: 'Andor' }, c: { at: 5, v: 'Shogun' } } };
    const m = mergeState(phone, tv, 100);
    expect(values(m, 'watchlist').map((x) => x.v)).toEqual(['Shogun']); // a removed later on the TV, b removed later on the phone
    expect(mergeState(m, phone, 100)).toEqual(m); // merging again changes nothing
  });

  it('a device with its clock far in the future cannot pin an entry forever', () => {
    const now = 1_000_000;
    const m = mergeState({ prefs: { s: { at: now + 10 * 86_400_000, v: 'old' } } }, undefined, now);
    expect(m.prefs.s.at).toBeLessThanOrEqual(now + 60_000);
  });

  it('forgets removals after two months and caps sizes', () => {
    const now = 200 * 86_400_000;
    const history = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`h${i}`, { at: now - i, v: i }]));
    const m = mergeState({ history, watchlist: { gone: { at: now - 61 * 86_400_000 } } }, undefined, now);
    expect(Object.keys(m.history)).toHaveLength(60);
    expect(m.watchlist).toEqual({});
  });

  it('ignores junk', () => {
    expect(mergeState({ watchlist: { x: { at: 'soon' as any, v: 1 } }, history: null as any }, undefined, 1)).toEqual(emptyState());
  });
});

describe('TV pairing through the relay', () => {
  it('TV opens a code, the phone sends settings, only that TV collects them once', async () => {
    const ns = fakeNamespace();
    const open = await (await call('/api/pair', { method: 'POST' }, ns)).json() as { code: string; secret: string };
    expect(open.code).toMatch(PAIR_CODE);
    expect((await (await call(`/api/pair/${open.code}`, {}, ns)).json())).toEqual({ waiting: true });
    expect(await (await call(`/api/pair/${open.code}/take?secret=${open.secret}`, {}, ns)).json()).toEqual({ waiting: true });

    const sent = await call(`/api/pair/${open.code}`, { method: 'POST', body: JSON.stringify({ data: { apiBase: 'https://r.test', debridKey: 'k' } }) }, ns);
    expect(sent.status).toBe(200);
    // A second phone can't overwrite it.
    expect((await call(`/api/pair/${open.code}`, { method: 'POST', body: JSON.stringify({ data: { evil: 1 } }) }, ns)).status).toBe(409);
    // Someone without the TV's secret can't read it.
    expect((await call(`/api/pair/${open.code}/take?secret=nope`, {}, ns)).status).toBe(404);

    const took = await (await call(`/api/pair/${open.code}/take?secret=${open.secret}`, {}, ns)).json();
    expect(took).toEqual({ data: { apiBase: 'https://r.test', debridKey: 'k' } });
    // Gone from the relay afterwards: keys don't linger.
    expect(ns.stores.get(`pair:${open.code}`)!.size).toBe(0);
    expect((await call(`/api/pair/${open.code}/take?secret=${open.secret}`, {}, ns)).status).toBe(404);
  });

  it('codes expire after 10 minutes', async () => {
    const clock = { now: 1_000_000 };
    const ns = fakeNamespace(clock);
    const open = await (await call('/api/pair', { method: 'POST' }, ns)).json() as { code: string };
    clock.now += PAIR_TTL_MS + 1;
    const r = await call(`/api/pair/${open.code}`, { method: 'POST', body: JSON.stringify({ data: { a: 1 } }) }, ns);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/expired/);
  });

  it('works on a relay with an access token (the new TV does not know it yet)', async () => {
    const ns = fakeNamespace();
    const r = await call('/api/pair', { method: 'POST' }, ns, { ACCESS_TOKEN: 'sekret' });
    expect(r.status).toBe(200);
    expect((await call('/api/search?q=x', {}, ns, { ACCESS_TOKEN: 'sekret' })).status).toBe(401);
  });

  it('codes are readable: no I, L, O, 0 or 1', () => {
    for (let i = 0; i < 200; i++) expect(pairingCode()).toMatch(PAIR_CODE);
  });
});

describe('sync through the relay', () => {
  it('two devices with the same key end up with the same state', async () => {
    const ns = fakeNamespace();
    const key = 'a'.repeat(32);
    await call(`/api/sync/${key}`, { method: 'POST', body: JSON.stringify({ state: { watchlist: { 'movie:1': { at: 5, v: { title: 'Dune' } } } } }) }, ns);
    const tv = await (await call(`/api/sync/${key}`, { method: 'POST', body: JSON.stringify({ state: { progress: { 'movie:1': { at: 6, v: 1234 } } } }) }, ns)).json() as any;
    expect(tv.state.watchlist['movie:1'].v.title).toBe('Dune');
    expect(tv.state.progress['movie:1'].v).toBe(1234);
    const other = await (await call(`/api/sync/${'b'.repeat(32)}`, {}, ns)).json() as any;
    expect(other.state.watchlist).toEqual({}); // another key sees nothing
  });

  it('a relay without the storage says so instead of failing oddly', async () => {
    const r = await handleApi(new Request('https://relay.test/api/pair', { method: 'POST' }), {}, {});
    expect(r.status).toBe(501);
  });
});
