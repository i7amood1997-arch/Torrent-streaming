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
  if (el?.isConnected) setTimeout(() => focus(el, 'auto'), 60);
}

/** Put focus on the first matching element if nothing sensible has focus (screen just opened). */
export function initialFocus(selector: string, force = false) {
  if (!isTV()) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!force && cur && cur !== document.body && visible(cur)) return;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el && visible(el)) focus(el, 'auto');
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

/** Cheap geometry check (layout is already up to date after the first read). */
function onPage(r: DOMRect): boolean {
  return r.width >= 2 && r.height >= 2 && r.bottom > -2500 && r.top < innerHeight + 2500;
}

/** Full check, done only for the few elements that could win (styles are costly on TV chips). */
function visible(el: HTMLElement): DOMRect | undefined {
  const r = el.getBoundingClientRect();
  if (!onPage(r)) return undefined;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || Number(s.opacity) === 0) return undefined;
  // Controls inside hidden overlays (e.g. the player's bar while it's faded out).
  if (el.closest('[aria-hidden="true"], .pointer-events-none')) return undefined;
  return r;
}

/** Focusable elements of the topmost layer (an open sheet/dialog wins). */
function candidates(): HTMLElement[] {
  const layer = (document.querySelector('[role="dialog"]') ?? document.querySelector('[data-tv-layer]')) as HTMLElement | null;
  if (layer) return [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)];
  // The screen on show plus the navigation bar (hidden screens hold hundreds of controls).
  const roots = document.querySelectorAll<HTMLElement>('[data-tv-pane], [data-tv-nav]');
  if (!roots.length) return [...document.body.querySelectorAll<HTMLElement>(FOCUSABLE)];
  return [...roots].flatMap((r) => [...r.querySelectorAll<HTMLElement>(FOCUSABLE)]);
}

type Dir = 'up' | 'down' | 'left' | 'right';

export function moveFocus(dir: Dir, behavior: ScrollBehavior = 'smooth'): boolean {
  const cur = document.activeElement as HTMLElement | null;
  const list = candidates();
  if (!list.length) return false;
  const from = cur && cur !== document.body && list.includes(cur) && visible(cur) ? cur.getBoundingClientRect() : undefined;
  if (!from) {
    // Nothing focused yet: start with the top-left control on screen.
    const shown = list.map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width >= 2 && x.r.top >= 0 && x.r.bottom <= innerHeight)
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    const first = shown.find((x) => visible(x.el))?.el;
    if (!first) return false;
    focus(first, behavior);
    return true;
  }
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const scored: { el: HTMLElement; score: number }[] = [];
  for (const el of list) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    if (!onPage(r)) continue;
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
    scored.push({ el, score: Math.max(0, main) + (inLine ? 0 : 1000 + cross * 3) + (main < -4 ? 400 : 0) });
  }
  scored.sort((a, b) => a.score - b.score);
  const best = scored.slice(0, 12).find((x) => visible(x.el))?.el;
  if (!best) return false;
  focus(best, behavior);
  return true;
}

const NAV_CLEARANCE = 96; // floating top bar
const BOTTOM_CLEARANCE = 40;

/**
 * Focus without the browser's own scrolling, then one scroll per axis to bring the item
 * (and, for poster rows, the whole row with its title) into view. Separate smooth scrolls
 * that fight each other are what made moving around feel heavy.
 */
function focus(el: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();

  const shelf = el.closest('.shelf') as HTMLElement | null;
  if (shelf) {
    const s = shelf.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(shelf).paddingLeft) || 20;
    let dx = 0;
    if (r.left < s.left + pad) dx = r.left - s.left - pad;
    else if (r.right > s.right - pad) dx = r.right - s.right + pad;
    if (Math.abs(dx) > 1) shelf.scrollTo({ left: shelf.scrollLeft + dx, behavior });
  }

  const sc = scroller(el);
  if (sc) {
    const box = sc.getBoundingClientRect();
    const section = el.closest('section') as HTMLElement | null;
    const sr = section?.getBoundingClientRect();
    const target = sr && sr.height < innerHeight * 0.75 ? sr : r;
    let dy = 0;
    if (target.top < box.top + NAV_CLEARANCE) dy = target.top - box.top - NAV_CLEARANCE;
    else if (target.bottom > box.bottom - BOTTOM_CLEARANCE) dy = target.bottom - box.bottom + BOTTOM_CLEARANCE;
    // Never push the focused item itself off screen to show its row title.
    if (target !== r) {
      const after = r.top - dy;
      if (after < box.top + 8 || r.bottom - dy > box.bottom - 8) dy = r.top < box.top + NAV_CLEARANCE ? r.top - box.top - NAV_CLEARANCE : r.bottom - box.bottom + BOTTOM_CLEARANCE;
    }
    if (Math.abs(dy) > 1) sc.scrollTo({ top: sc.scrollTop + dy, behavior });
  }
}

function scroller(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight <= p.clientHeight + 1) continue;
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
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
    // Held key: jump without animation so focus keeps up with the remote.
    if (moveFocus(dir, e.repeat ? 'auto' : 'smooth')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
