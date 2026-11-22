/**
 * Durable Object holding one pairing slot or one user's synced state (lib/server/userdata.ts).
 * The relay names it "pair:<CODE>" or "sync:<key>"; the action comes in the x-op header.
 */
import { DurableObject } from 'cloudflare:workers';
import { userData, type KV } from '../lib/server/userdata';

export class UserData extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const s = this.ctx.storage;
    const kv: KV = {
      get: (k) => s.get(k),
      put: (k, v) => s.put(k, v),
      deleteAll: () => s.deleteAll(),
      setAlarm: (at) => s.setAlarm(at),
    };
    return userData(kv, request.headers.get('x-op') ?? '', request);
  }

  /** A pairing slot's time is up: wipe it. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
