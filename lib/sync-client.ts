/**
 * Keeps this device's shared state (store.syncState) in step with the user's other devices
 * through their relay (/api/sync/<key>). One request does both directions: it sends what this
 * device has, and gets back everything merged. It runs on start, a few seconds after any
 * change here, every minute while the app is on screen, and when the app comes back to it.
 */
import { apiBase } from './client-api';
import { historyKey, useApp } from './store';
import { randomKey } from './sync';

const AFTER_CHANGE_MS = 3000;
const EVERY_MS = 60_000;

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

/** Did the last sync work? (Settings shows it.) */
export let lastSync: { at: number; ok: boolean; error?: string } | undefined;

async function syncNow() {
  const st = useApp.getState();
  const base = apiBase();
  if (!base || !st.caps?.sync || st.caps.offline) return;
  // The first device makes the household's key; others get it by pairing or by typing it in.
  if (!st.settings.syncKey) st.updateSettings({ syncKey: randomKey() });
  if (running) { again = true; return; }
  running = true;
  try {
    const key = useApp.getState().settings.syncKey;
    const res = await fetch(`${base}/api/sync/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: useApp.getState().syncState }),
    });
    const body = (await res.json().catch(() => ({}))) as { state?: unknown; error?: string };
    if (!res.ok || !body.state) throw new Error(body.error ?? `HTTP ${res.status}`);
    // Only if the key didn't change meanwhile (the user typed another one in).
    if (useApp.getState().settings.syncKey === key) useApp.getState().applyRemote(body.state as never);
    lastSync = { at: Date.now(), ok: true };
  } catch (e) {
    lastSync = { at: Date.now(), ok: false, error: (e as Error).message };
  } finally {
    running = false;
    if (again) { again = false; schedule(500); }
  }
}

function schedule(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), ms);
}

/** Bring history kept before syncing existed into the shared state, oldest last. */
function seedHistory() {
  const st = useApp.getState();
  const now = Date.now();
  let changed = false;
  const hist = { ...st.syncState.history };
  st.history.forEach((h, i) => {
    const k = historyKey(h);
    if (!hist[k]) { hist[k] = { at: now - 1000 * (i + 1), v: h }; changed = true; }
  });
  if (changed) useApp.setState({ syncState: { ...st.syncState, history: hist } });
}

export function startSync() {
  if (started || typeof window === 'undefined') return;
  started = true;
  seedHistory();
  // Local changes: send them shortly after (several quick changes go together).
  useApp.subscribe((s, prev) => {
    if (s.syncState !== prev.syncState && !running) schedule(AFTER_CHANGE_MS);
    // Relay just became known/reachable, or the key was changed: sync now.
    if (s.caps !== prev.caps || s.settings.syncKey !== prev.settings.syncKey) schedule(300);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
  setInterval(() => { if (document.visibilityState === 'visible') void syncNow(); }, EVERY_MS);
  schedule(1000);
}

/** Settings: sync right away (after typing in a key). */
export const syncSoon = () => schedule(100);
