/**
 * Keep open apps up to date. A Home Screen app (or a tab left open) comes back from the
 * background without reloading, so it can run an old version for days. When it comes back on
 * screen (and every half hour), check the site's current build; if it's newer, reload, but never
 * in the middle of a video: then wait until the player is closed.
 */
import { BASE_PATH } from './config';
import { useApp } from './store';

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

/** The build id in a page's HTML (<meta name="streamdeck-build">). */
export function buildIdIn(html: string): string | undefined {
  return html.match(/<meta[^>]+name="streamdeck-build"[^>]+content="([^"]+)"/)?.[1];
}

let started = false;
let pending = false;

async function check() {
  if (pending || BUILD_ID.startsWith('dev')) return;
  try {
    const res = await fetch(`${BASE_PATH}/?build-check=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const latest = buildIdIn(await res.text());
    if (!latest || latest === BUILD_ID || latest.startsWith('dev')) return;
    pending = true;
    reloadWhenIdle();
  } catch { /* offline: try next time */ }
}

function reloadWhenIdle() {
  if (useApp.getState().view !== 'player') { location.reload(); return; }
  const off = useApp.subscribe((s) => { if (s.view !== 'player') { off(); location.reload(); } });
}

export function startUpdateCheck() {
  if (started || typeof window === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 30 * 60_000);
  setTimeout(() => void check(), 5000);
}
