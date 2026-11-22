/**
 * Setting up a TV from a phone. The TV asks its relay for a pairing code and shows it as a QR
 * code; the phone that scans it sends the user's settings to that code; the TV collects them.
 * The relay side is lib/server/userdata.ts.
 */
import { DEFAULT_API_BASE } from './config';
import { randomKey } from './sync';
import { useApp, type Settings } from './store';

const trim = (u: string) => u.replace(/\/+$/, '');

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

export interface Pairing { code: string; secret: string; expires: number; relay: string }

/** TV: a fresh code on this relay. */
export async function openPairing(relay: string): Promise<Pairing> {
  const r = await req<{ code: string; secret: string; expires?: number }>(`${trim(relay)}/api/pair`, { method: 'POST', body: '{}' });
  return { ...r, expires: r.expires ?? Date.now() + 10 * 60_000, relay: trim(relay) };
}

/** TV: the settings once the phone has sent them; undefined while still waiting. Throws when the code expired. */
export async function collect(p: Pairing): Promise<Partial<Settings> | undefined> {
  const r = await req<{ data?: Partial<Settings>; waiting?: boolean }>(`${p.relay}/api/pair/${p.code}/take?secret=${p.secret}`);
  return r.data;
}

/** The address the QR code opens on the phone. */
export function pairLink(p: Pairing, origin: string, basePath: string): string {
  const u = new URL(`${origin}${basePath}/`);
  u.searchParams.set('pair', p.code);
  u.searchParams.set('relay', p.relay);
  return u.toString();
}

/**
 * Phone: the relays it will send settings to. Only its own relay or the app's default one,
 * so a forged QR code can't send the user's keys to a stranger's server.
 */
export function trustedRelays(s: Settings = useApp.getState().settings): string[] {
  return [...new Set([s.apiBase, DEFAULT_API_BASE].map((x) => trim(x || '')).filter(Boolean))];
}

/** Phone: what the TV receives (everything in Settings, with a sync key made now if there isn't one). */
export function settingsToSend(): Settings {
  const st = useApp.getState();
  if (!st.settings.syncKey) st.updateSettings({ syncKey: randomKey() });
  return { ...useApp.getState().settings };
}

/** Phone: send to a TV's code. */
export async function sendToTv(relay: string, code: string): Promise<void> {
  const r = trim(relay);
  if (!trustedRelays().includes(r)) throw new Error('This code belongs to a relay you don’t use, so your settings weren’t sent.');
  await req(`${r}/api/pair/${code}`, { method: 'POST', body: JSON.stringify({ data: settingsToSend() }) });
}

/** TV: take the received settings in (only known fields, nested parts merged). */
export function applyReceived(data: Partial<Settings>) {
  const st = useApp.getState();
  const cur = st.settings;
  const next: Settings = { ...cur };
  for (const k of Object.keys(cur) as (keyof Settings)[]) {
    const v = data[k];
    if (v === undefined || v === null || typeof v !== typeof cur[k]) continue;
    (next as any)[k] = typeof v === 'object' && !Array.isArray(v) ? { ...(cur[k] as object), ...(v as object) } : v;
  }
  st.updateSettings(next);
}
