import { describe, expect, it } from 'vitest';
import { followedSeries, newEpisode } from '@/lib/new-episodes';
import { runAlerts, type KV } from '@/lib/server/userdata';
import { b64u, encryptPush, makeVapid, unb64u, type PushSubscriptionJSON } from '@/lib/server/webpush';
import { emptyState, mergeState } from '@/lib/sync';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const memKV = (init: Record<string, unknown> = {}): KV & { m: Map<string, unknown> } => {
  const m = new Map(Object.entries(init));
  return { m, get: async (k) => m.get(k) as any, put: async (k, v) => { m.set(k, structuredClone(v)); }, deleteAll: async () => m.clear() };
};

/** A real browser-style subscription key pair, so encryption is exercised for real. */
async function device(endpoint: string) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, auth, sub: { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) } } as PushSubscriptionJSON };
}

/** RFC 8291 decryption, as the device does it. */
async function decrypt(body: Uint8Array, d: Awaited<ReturnType<typeof device>>): Promise<string> {
  const salt = body.slice(0, 16);
  const keyLen = body[20];
  const asPublic = body.slice(21, 21 + keyLen);
  const ct = body.slice(21 + keyLen);
  const enc = new TextEncoder();
  const as = await crypto.subtle.importKey('raw', asPublic as unknown as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as } as EcdhKeyDeriveParams, d.kp.privateKey, 256));
  const ua = unb64u(d.sub.keys.p256dh);
  const B = (u: Uint8Array) => u as unknown as BufferSource;
  const h = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: B(salt), info: B(info) }, await crypto.subtle.importKey('raw', B(ikm), 'HKDF', false, ['deriveBits']), n * 8));
  const ikm = await h(d.auth, ecdh, new Uint8Array([...enc.encode('WebPush: info\0'), ...ua, ...asPublic]), 32);
  const cek = await h(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await h(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: B(nonce) }, await crypto.subtle.importKey('raw', B(cek), 'AES-GCM', false, ['decrypt']), B(ct)));
  expect(pt[pt.length - 1]).toBe(2); // last-record delimiter
  return new TextDecoder().decode(pt.slice(0, -1));
}

const state = mergeState(emptyState(), {
  history: { 'series:95396:2:3': { at: NOW - 86_400_000, v: { type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 3 } } },
  watchlist: { 'series:1399': { at: NOW - 2 * 86_400_000, v: { id: 1399, type: 'series', title: 'Andor', overview: '', source: 'tmdb' } } },
}, NOW);

describe('new episodes of followed shows', () => {
  it('follows watched series (furthest episode) and My List series', () => {
    const f = followedSeries(state);
    expect(f.map((x) => x.title).sort()).toEqual(['Andor', 'Severance']);
    expect(f.find((x) => x.title === 'Severance')!.watched).toEqual({ season: 2, episode: 3 });
  });

  it('news = aired lately and not watched yet', () => {
    const sev = followedSeries(state).find((x) => x.title === 'Severance')!;
    expect(newEpisode(sev, { lastAired: { season: 2, episode: 4, airDate: '2026-11-21' } }, NOW)).toBeTruthy();
    expect(newEpisode(sev, { lastAired: { season: 2, episode: 3, airDate: '2026-11-21' } }, NOW)).toBeUndefined(); // already seen
    expect(newEpisode(sev, { lastAired: { season: 2, episode: 4, airDate: '2026-10-01' } }, NOW)).toBeUndefined(); // old news
    expect(newEpisode(sev, { lastAired: { season: 2, episode: 4, airDate: '2026-11-30' } }, NOW)).toBeUndefined(); // not out yet
  });
});

describe('alerts from the relay', () => {
  it('announces each new episode once to every device, encrypted for that device, and forgets dead ones', async () => {
    const phone = await device('https://web.push.apple.com/phone');
    const old = await device('https://fcm.googleapis.com/fcm/send/old');
    const kv = memKV({ state, push: [{ sub: phone.sub, app: 'https://app.test/', at: NOW }, { sub: old.sub, at: NOW }] });
    const sentTo: { url: string; body: Uint8Array; auth: string }[] = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      sentTo.push({ url, body: new Uint8Array(init.body as ArrayBuffer), auth: (init.headers as Record<string, string>).Authorization });
      return new Response(null, { status: url.includes('/old') ? 410 : 201 });
    }) as unknown as typeof fetch;
    const details = async (tmdbId?: number) => (tmdbId === 95396
      ? { title: 'Severance', lastAired: { season: 2, episode: 4, name: 'Woe’s Hollow', airDate: '2026-11-21' } }
      : { title: 'Andor', lastAired: { season: 2, episode: 12, airDate: '2026-05-13' } });
    const vapid = await makeVapid('https://relay.test');

    const r = await runAlerts(kv, { vapid, tmdbKey: 'k', fetch: fetchFake, details }, NOW);
    expect(r).toEqual({ sent: 1, devices: 1 }); // the dead subscription (410) was dropped
    const msg = JSON.parse(await decrypt(sentTo.find((x) => x.url.includes('apple'))!.body, phone));
    expect(msg).toEqual({ title: 'New episode · Severance', body: 'S2 · E4 · Woe’s Hollow', url: 'https://app.test/?open=series%3At95396%3A2%3A4', tag: 't95396:2:4' });
    expect(sentTo[0].auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    // The next check doesn't announce it again.
    sentTo.length = 0;
    expect(await runAlerts(kv, { vapid, tmdbKey: 'k', fetch: fetchFake, details }, NOW + 6 * 3600_000)).toEqual({ sent: 0, devices: 1 });
    expect(sentTo).toHaveLength(0);
  });

  it('encryption is not deterministic (a fresh key and salt every message)', async () => {
    const d = await device('https://x.test/1');
    const a = await encryptPush(new TextEncoder().encode('hi'), d.sub);
    const b = await encryptPush(new TextEncoder().encode('hi'), d.sub);
    expect(b64u(a)).not.toBe(b64u(b));
    expect(await decrypt(a, d)).toBe('hi');
  });
});
