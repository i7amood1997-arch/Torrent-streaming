/**
 * The relay's small per-user storage (one Durable Object instance per name, worker/user-do.ts).
 *
 *  - Pairing ("pair:<CODE>"): the TV opens a slot and shows its code; a phone that scanned it
 *    drops the user's settings in; the TV collects them with the secret only it knows, and the
 *    slot is wiped. Slots expire after 10 minutes either way.
 *  - Sync ("sync:<key>"): the user's shared state (lib/sync.ts), readable and mergeable only by
 *    devices that know the 128-bit sync key.
 *
 * Written against a tiny storage interface so it can be tested without Cloudflare.
 */
import { cinemeta } from '../cinemeta';
import { detailsId, followedSeries, newEpisode } from '../new-episodes';
import { mergeState, type SyncState } from '../sync';
import { createTmdbClient } from '../tmdb';
import type { TmdbDetails } from '../types';
import { makeVapid, sendPush, type PushSubscriptionJSON, type Vapid } from './webpush';

export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm?(at: number): Promise<void>;
}

export const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_SUBS = 8;
/** New-episode alerts: an episode out within this many days, not seen yet, is news. */
const ALERT_DAYS = 3;

interface Sub { sub: PushSubscriptionJSON; app?: string; at: number }

/** What the relay's alerts check needs from the Worker. */
export interface AlertDeps { vapid: Vapid; tmdbKey?: string; fetch?: typeof fetch; details?: (tmdbId: number | undefined, numericImdb: number | undefined) => Promise<Pick<TmdbDetails, 'lastAired' | 'title'> | undefined> }
const MAX_BODY = 256 * 1024;

interface Slot {
  secret: string;
  expires: number;
  data?: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('too large');
  return JSON.parse(text || '{}');
}

/** Handle one request routed to this storage. `op` is the action the relay router chose. */
export async function userData(kv: KV, op: string, req: Request, now = Date.now()): Promise<Response> {
  try {
    if (op === 'pair-open') {
      const { secret } = await readJson(req);
      if (typeof secret !== 'string' || secret.length < 16) return json({ error: 'bad secret' }, 400);
      const slot: Slot = { secret, expires: now + PAIR_TTL_MS };
      await kv.put('slot', slot);
      await kv.setAlarm?.(slot.expires);
      return json({ ok: true, expires: slot.expires });
    }

    const slot = op.startsWith('pair-') ? await kv.get<Slot>('slot') : undefined;
    const live = slot && slot.expires > now;
    if (op === 'pair-check') return json({ waiting: !!live && slot!.data === undefined });

    if (op === 'pair-send') {
      if (!live) return json({ error: 'This code has expired. Ask the TV for a new one.' }, 404);
      if (slot!.data !== undefined) return json({ error: 'This TV has already received settings.' }, 409);
      const { data } = await readJson(req);
      if (!data || typeof data !== 'object') return json({ error: 'Nothing to send.' }, 400);
      await kv.put('slot', { ...slot!, data });
      return json({ ok: true });
    }

    if (op === 'pair-take') {
      const secret = new URL(req.url).searchParams.get('secret');
      if (!live || !secret || secret !== slot!.secret) return json({ error: 'expired' }, 404);
      if (slot!.data === undefined) return json({ waiting: true });
      await kv.deleteAll(); // settings carry keys: they don't stay on the relay
      return json({ data: slot!.data });
    }

    if (op === 'sync-get') return json({ state: mergeState(await kv.get<SyncState>('state'), undefined, now) });

    if (op === 'sync-merge') {
      const { state } = await readJson(req);
      const merged = mergeState(await kv.get<SyncState>('state'), state, now);
      await kv.put('state', merged);
      return json({ state: merged });
    }

    // ── New-episode alerts ──────────────────────────────────────────────
    // The relay-wide index ("push-index"): the VAPID key and which sync keys want alerts.
    if (op === 'vapid-get' || op === 'vapid-full') {
      let v = await kv.get<Vapid>('vapid');
      if (!v) {
        const { subject } = await readJson(req);
        v = await makeVapid(typeof subject === 'string' && /^(https:|mailto:)/.test(subject) ? subject : 'mailto:relay@invalid.example');
        await kv.put('vapid', v);
      }
      return json(op === 'vapid-full' ? v : { publicKey: v.publicKey });
    }
    if (op === 'index-add' || op === 'index-remove') {
      const { key } = await readJson(req);
      const keys = new Set((await kv.get<string[]>('keys')) ?? []);
      if (op === 'index-add') keys.add(String(key)); else keys.delete(String(key));
      await kv.put('keys', [...keys].slice(-500));
      return json({ ok: true });
    }
    if (op === 'index-list') return json({ keys: (await kv.get<string[]>('keys')) ?? [] });

    // One household's subscriptions (in its "sync:<key>" storage).
    if (op === 'push-sub') {
      const { subscription, app } = await readJson(req);
      if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) return json({ error: 'Not a push subscription' }, 400);
      const subs = ((await kv.get<Sub[]>('push')) ?? []).filter((x) => x.sub.endpoint !== subscription.endpoint);
      subs.push({ sub: subscription, app: typeof app === 'string' ? app.slice(0, 300) : undefined, at: now });
      await kv.put('push', subs.slice(-MAX_SUBS));
      return json({ ok: true, devices: Math.min(subs.length, MAX_SUBS) });
    }
    if (op === 'push-run') {
      const { vapid, tmdbKey } = await readJson(req);
      return json(await runAlerts(kv, { vapid, tmdbKey }, now));
    }
    if (op === 'push-test') {
      const { vapid } = await readJson(req);
      return json(await testAlert(kv, vapid));
    }
    if (op === 'push-unsub') {
      const { endpoint } = await readJson(req);
      const subs = ((await kv.get<Sub[]>('push')) ?? []).filter((x) => x.sub.endpoint !== endpoint);
      await kv.put('push', subs);
      return json({ ok: true, devices: subs.length });
    }
    return json({ error: 'Not found' }, 404);
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
}

/**
 * The scheduled check for one household: shows it follows with an episode out in the last few
 * days that it hasn't watched, each announced once to every subscribed device.
 */
export async function runAlerts(kv: KV, deps: AlertDeps, now = Date.now()): Promise<{ sent: number; devices: number }> {
  let subs = (await kv.get<Sub[]>('push')) ?? [];
  if (!subs.length) return { sent: 0, devices: 0 };
  const state = mergeState(await kv.get<SyncState>('state'), undefined, now);
  const told = new Set((await kv.get<string[]>('told')) ?? []);
  const details = deps.details ?? (async (tmdbId?: number, numericImdb?: number) => {
    if (deps.tmdbKey && tmdbId) return createTmdbClient({ apiKey: deps.tmdbKey }).details('series', tmdbId);
    if (numericImdb) return cinemeta.details('series', numericImdb);
    return undefined;
  });
  let sent = 0;
  for (const f of followedSeries(state, 25)) {
    // TMDB when the relay has a key and the show has a TMDB id; otherwise the keyless catalog by IMDb id.
    const d = await details(deps.tmdbKey ? f.tmdbId : undefined, detailsId(f, false)).catch(() => undefined);
    const ep = d && newEpisode(f, d, now, ALERT_DAYS);
    if (!ep) continue;
    const id = `${f.tmdbId ? `t${f.tmdbId}` : `i${f.imdbId}`}:${ep.season}:${ep.episode}`;
    if (told.has(id)) continue;
    told.add(id);
    const title = f.title || d.title || 'A show you follow';
    for (const s of [...subs]) {
      const open = s.app ? `${s.app}?open=${encodeURIComponent(`series:${f.tmdbId ? `t${f.tmdbId}` : `i${f.imdbId}`}:${ep.season}:${ep.episode}`)}` : undefined;
      const r = await sendPush(s.sub, { title: `New episode · ${title}`, body: `S${ep.season} · E${ep.episode}${ep.name ? ` · ${ep.name}` : ''}`, url: open, tag: id }, deps.vapid, deps.fetch);
      if (r === 'gone') subs = subs.filter((x) => x !== s);
      if (r === 'sent') sent++;
    }
  }
  await kv.put('told', [...told].slice(-300));
  await kv.put('push', subs);
  return { sent, devices: subs.length };
}

/** "Alerts are on": a test notification to every device of the household. */
export async function testAlert(kv: KV, vapid: Vapid, f?: typeof fetch): Promise<{ sent: number; devices: number }> {
  let subs = (await kv.get<Sub[]>('push')) ?? [];
  let sent = 0;
  for (const s of [...subs]) {
    const r = await sendPush(s.sub, { title: 'Streamdeck', body: 'New-episode alerts are on.', url: s.app, tag: 'test' }, vapid, f);
    if (r === 'gone') subs = subs.filter((x) => x !== s);
    if (r === 'sent') sent++;
  }
  await kv.put('push', subs);
  return { sent, devices: subs.length };
}
