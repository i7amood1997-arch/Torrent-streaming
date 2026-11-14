'use client';
/**
 * Android TV app support (android-tv/ wraps this site in a WebView).
 *
 *  - isTV(): running inside the TV app (its user agent carries "StreamdeckTV").
 *  - Remote control: arrow keys move focus to the nearest control in that direction
 *    (spatial navigation), OK clicks it, and the TV's Back button walks back through
 *    the app (handlers registered with onTvBack) before leaving it.
 *  - The native bridge (window.StreamdeckTV) plays files the WebView can't decode in
 *    the TV's own player, and keeps the screen awake while a video plays.
 */

export interface NativeBridge {
  playNative(json: string): void;
  setKeepScreenOn(on: boolean): void;
}

export const nativeTV = (): NativeBridge | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { StreamdeckTV?: NativeBridge }).StreamdeckTV;

export const isTV = () => typeof navigator !== 'undefined' && /StreamdeckTV/.test(navigator.userAgent);

// ─── Back button ────────────────────────────────────────────────────────────

type BackHandler = () => boolean;
const backHandlers: { h: BackHandler; priority: number }[] = [];

/**
 * Register a handler for the TV's Back button; it returns true if it handled it.
 * Higher priority runs first (screens > app-level navigation).
 */
export function onTvBack(h: BackHandler, priority = 0): () => void {
  backHandlers.push({ h, priority });
  backHandlers.sort((a, b) => b.priority - a.priority);
  return () => { const i = backHandlers.findIndex((x) => x.h === h); if (i >= 0) backHandlers.splice(i, 1); };
}

/** Where focus was when a screen opened, to go back to it when that screen closes. */
const focusStack: HTMLElement[] = [];
export function pushFocus() {
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body) focusStack.push(el);
}
export function popFocus() {
  const el = focusStack.pop();
  if (el?.isConnected) setTimeout(() => focus(el), 60);
}

/** Put focus on the first matching element if nothing sensible has focus (screen just opened). */
export function initialFocus(selector: string, force = false) {
  if (!isTV()) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!force && cur && cur !== document.body && visible(cur)) return;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el && visible(el)) focus(el);
}

/** Called by the TV app on Back. Returns false when the app should close. */
function handleBack(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el && el.closest('input, textarea, select') && el.tagName !== 'BUTTON') { el.blur(); return true; }
  for (const { h } of [...backHandlers]) if (h()) return true;
  return false;
}

// ─── Spatial navigation ─────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el: HTMLElement): DOMRect | undefined {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return undefined;
  if (r.bottom < -2000 || r.top > innerHeight + 2000) return undefined;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return undefined;
  // Hidden by an ancestor (display:none views) shows up as an empty rect above; also skip
  // controls inside inactive overlays.
  if (el.closest('[aria-hidden="true"], .pointer-events-none')) return undefined;
  return r;
}

/** Visible, focusable elements of the topmost layer (an open sheet/dialog wins). */
function candidates(): HTMLElement[] {
  const layer = (document.querySelector('[role="dialog"]') ?? document.querySelector('[data-tv-layer]') ?? document.body) as HTMLElement;
  return [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el));
}

type Dir = 'up' | 'down' | 'left' | 'right';

export function moveFocus(dir: Dir): boolean {
  const cur = document.activeElement as HTMLElement | null;
  const list = candidates();
  if (!list.length) return false;
  const from = cur && cur !== document.body && list.includes(cur) ? cur.getBoundingClientRect() : undefined;
  if (!from) {
    // Nothing focused yet: start with the first control on screen.
    const onScreen = list.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    const first = (onScreen.length ? onScreen : list).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    focus(first);
    return true;
  }
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    const overlapV = r.top < from.bottom && r.bottom > from.top;
    const overlapH = r.left < from.right && r.right > from.left;
    let main: number;
    let cross: number;
    if (dir === 'right') { if (ex <= cx + 1) continue; main = r.left - from.right; cross = overlapV ? 0 : Math.abs(ey - cy); }
    else if (dir === 'left') { if (ex >= cx - 1) continue; main = from.left - r.right; cross = overlapV ? 0 : Math.abs(ey - cy); }
    else if (dir === 'down') { if (ey <= cy + 1) continue; main = r.top - from.bottom; cross = overlapH ? 0 : Math.abs(ex - cx); }
    else { if (ey >= cy - 1) continue; main = from.top - r.bottom; cross = overlapH ? 0 : Math.abs(ex - cx); }
    // Rows first: something in line beats something closer but off to the side.
    const inLine = dir === 'left' || dir === 'right' ? overlapV : overlapH;
    const score = Math.max(0, main) + (inLine ? 0 : 1000 + cross * 3) + (main < -4 ? 400 : 0);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  focus(best);
  return true;
}

function focus(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  // Rows of posters: keep some of the previous item visible.
  const shelf = el.closest('.shelf') as HTMLElement | null;
  if (shelf) {
    const r = el.getBoundingClientRect();
    const s = shelf.getBoundingClientRect();
    if (r.left - s.left < 60) shelf.scrollBy({ left: r.left - s.left - 60, behavior: 'smooth' });
    else if (s.right - r.right < 60) shelf.scrollBy({ left: 60 - (s.right - r.right), behavior: 'smooth' });
  }
  // Vertical: keep the focused row comfortably on screen (not hugging the edge).
  const r = el.getBoundingClientRect();
  if (r.top < 90) scroller(el)?.scrollBy({ top: r.top - 90, behavior: 'smooth' });
  else if (r.bottom > innerHeight - 60) scroller(el)?.scrollBy({ top: r.bottom - innerHeight + 60, behavior: 'smooth' });
}

function scroller(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return undefined;
}

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Hook for keys a screen wants for itself (the player: seek, play/pause). Return true if handled. */
let keyOverride: ((e: KeyboardEvent) => boolean) | undefined;
export const setTvKeyOverride = (fn: typeof keyOverride) => { keyOverride = fn; };

export function startTvMode() {
  if (!isTV() || (window as unknown as { __tvStarted?: boolean }).__tvStarted) return;
  (window as unknown as { __tvStarted?: boolean }).__tvStarted = true;
  document.documentElement.dataset.tv = '1';
  (window as unknown as { __tvBack: () => boolean }).__tvBack = handleBack;
  window.addEventListener('keydown', (e) => {
    if (keyOverride?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    const dir = KEY_DIR[e.key];
    if (!dir) return;
    const el = document.activeElement as HTMLElement | null;
    // Let text fields and sliders use left/right themselves.
    if (el?.matches('input[type="range"]') && (dir === 'left' || dir === 'right')) return;
    if (el?.matches('input:not([type="range"]):not([type="checkbox"]), textarea') && (dir === 'left' || dir === 'right')) return;
    if (el?.tagName === 'SELECT') return; // the native picker handles arrows
    if (moveFocus(dir)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
