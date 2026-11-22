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
import { mergeState, type SyncState } from '../sync';

export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm?(at: number): Promise<void>;
}

export const PAIR_TTL_MS = 10 * 60 * 1000;
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

    return json({ error: 'Not found' }, 404);
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
}
