import { describe, expect, it, vi } from 'vitest';
import { makeCache } from '@/lib/catalog-cache';

function memStore() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

describe('saved catalog answers', () => {
  it('a fresh saved answer is used without asking the relay', async () => {
    const clock = { t: 0 };
    const c = makeCache(memStore(), () => clock.t);
    const fetcher = vi.fn(async () => ['Dune']);
    await c.get('trending', 60_000, fetcher);
    clock.t = 30_000;
    expect(await c.get('trending', 60_000, fetcher)).toEqual(['Dune']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('an old one is asked for again', async () => {
    const clock = { t: 0 };
    const c = makeCache(memStore(), () => clock.t);
    await c.get('trending', 60_000, async () => ['Dune']);
    clock.t = 61_000;
    expect(await c.get('trending', 60_000, async () => ['Andor'])).toEqual(['Andor']);
  });

  it('relay unreachable: the last answer is used instead of an error', async () => {
    const clock = { t: 0 };
    const c = makeCache(memStore(), () => clock.t);
    await c.get('details:1', 1000, async () => ({ title: 'Dune' }));
    clock.t = 5000;
    expect(await c.get('details:1', 1000, async () => { throw new TypeError('Failed to fetch'); })).toEqual({ title: 'Dune' });
  });

  it('nothing saved and the relay fails: the error comes through', async () => {
    const c = makeCache(memStore());
    await expect(c.get('x', 1000, async () => { throw new Error('HTTP 502'); })).rejects.toThrow('HTTP 502');
  });

  it('survives a restart of the app (kept in storage), and can be shown at once', async () => {
    const store = memStore();
    await makeCache(store).get('trending', 60_000, async () => ['Dune']);
    expect(makeCache(store).peek('trending')).toEqual(['Dune']);
    expect(makeCache(store).peek('missing')).toBeUndefined();
  });

  it('the same question asked twice at once goes to the relay once', async () => {
    const c = makeCache(memStore());
    let release!: (v: string[]) => void;
    const fetcher = vi.fn(() => new Promise<string[]>((ok) => { release = ok; }));
    const a = c.get('trending', 1000, fetcher);
    const b = c.get('trending', 1000, fetcher);
    release(['Dune']);
    expect(await a).toEqual(['Dune']);
    expect(await b).toEqual(['Dune']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps only the most recent answers', async () => {
    const store = memStore();
    const clock = { t: 0 };
    const c = makeCache(store, () => clock.t, 3);
    for (const k of ['a', 'b', 'c', 'd']) { clock.t++; await c.get(k, 1000, async () => k); }
    const fresh = makeCache(store);
    expect(fresh.peek('a')).toBeUndefined();
    expect(['b', 'c', 'd'].map((k) => fresh.peek(k))).toEqual(['b', 'c', 'd']);
  });

  it('storage full or broken: still answers', async () => {
    const broken = { getItem: () => '{not json', setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => undefined };
    const c = makeCache(broken);
    expect(c.peek('trending')).toBeUndefined();
    expect(await c.get('trending', 1000, async () => ['Dune'])).toEqual(['Dune']);
  });

  it('an answer that isn’t worth keeping (an empty row) is asked for again next time', async () => {
    const c = makeCache(memStore());
    const keep = (v: { results: string[] }) => v.results.length > 0;
    await c.get('noir', 60_000, async () => ({ results: [] as string[] }), keep);
    expect(c.peek('noir')).toBeUndefined();
    expect(await c.get('noir', 60_000, async () => ({ results: ['Scarlet Street'] }), keep)).toEqual({ results: ['Scarlet Street'] });
  });
});
