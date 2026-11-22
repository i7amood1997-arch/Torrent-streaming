/**
 * New-episode alerts on this device (Web Push): ask permission, subscribe with the relay's key,
 * and tell the relay, which checks the shows you follow every few hours (lib/server/userdata.ts).
 * On iPhone/iPad this works for the app added to the Home Screen (iOS 16.4+).
 */
import { apiBase } from './client-api';
import { BASE_PATH } from './config';
import { useApp } from './store';
import { randomKey } from './sync';

export type AlertState = 'unsupported' | 'needs-home-screen' | 'blocked' | 'off' | 'on';

const fromB64u = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

export async function alertState(): Promise<AlertState> {
  if (typeof window === 'undefined') return 'unsupported';
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'needs-home-screen' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${apiBase()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: string; sent?: number; devices?: number };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

function syncKey(): string {
  const st = useApp.getState();
  if (!st.settings.syncKey) st.updateSettings({ syncKey: randomKey() });
  return useApp.getState().settings.syncKey;
}

/** Turn alerts on (from a tap: the permission prompt needs one). */
export async function enableAlerts(): Promise<void> {
  if (!apiBase()) throw new Error('Alerts need your relay.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications weren’t allowed.');
  const reg = (await registration()) ?? (await navigator.serviceWorker.ready);
  const keyRes = await fetch(`${apiBase()}/api/push/key`);
  const { publicKey, error } = (await keyRes.json().catch(() => ({}))) as { publicKey?: string; error?: string };
  if (!publicKey) throw new Error(error ?? 'Your relay needs updating for alerts.');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(publicKey) as BufferSource }));
  await post(`/api/push/${syncKey()}`, { subscription: sub.toJSON(), app: `${location.origin}${BASE_PATH}/` });
}

export async function disableAlerts(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await post(`/api/push/${syncKey()}/remove`, { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export const testAlert = () => post(`/api/push/${syncKey()}/test`, {});
