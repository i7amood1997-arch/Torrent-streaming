/**
 * Web Push from the relay, with nothing but WebCrypto (works in Cloudflare Workers):
 *  - VAPID (RFC 8292): the relay's own P-256 key signs a short JWT so push services know the sender.
 *  - Message encryption (RFC 8291, aes128gcm / RFC 8188): only the subscribed device can read it.
 */

const enc = new TextEncoder();

export const b64u = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const buf = (u: Uint8Array) => u as unknown as BufferSource;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, bytes * 8));
}

export interface PushSubscriptionJSON { endpoint: string; keys: { p256dh: string; auth: string } }
export interface Vapid { publicKey: string; privateJwk: JsonWebKey; subject: string }

/** A new VAPID key pair for this relay (made once, then kept in its storage). */
export async function makeVapid(subject: string): Promise<Vapid> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  return { publicKey: b64u(pub), privateJwk: (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey, subject };
}

/** The Authorization header value for a push service (RFC 8292). */
export async function vapidAuth(endpoint: string, v: Vapid, now = Date.now()): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })));
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(enc.encode(`${header}.${claims}`))));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

/**
 * Encrypt a message for one subscription (RFC 8291). `fixed` is for tests only (a known sender
 * key pair and salt).
 */
export async function encryptPush(payload: Uint8Array, sub: PushSubscriptionJSON, fixed?: { asKeys: CryptoKeyPair; salt: Uint8Array }): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const asKeys = fixed?.asKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', buf(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as EcdhKeyDeriveParams, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(concat(payload, new Uint8Array([2])))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Send one notification. 'gone' means the subscription no longer exists (forget it). */
export async function sendPush(sub: PushSubscriptionJSON, message: unknown, v: Vapid, f: typeof fetch = fetch): Promise<PushResult> {
  try {
    const body = await encryptPush(enc.encode(JSON.stringify(message)), sub);
    const res = await f(sub.endpoint, {
      method: 'POST',
      headers: { TTL: '86400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: await vapidAuth(sub.endpoint, v) },
      body: buf(body) as BodyInit,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
