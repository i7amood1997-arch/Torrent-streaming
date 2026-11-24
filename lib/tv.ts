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
  /** Newer TV app versions: the TV's speech recognizer (what was said comes back via window.__tvVoice). */
  hasVoice?(): boolean;
  voiceSearch?(): void;
}

/** Voice search is available (TV app with a speech recognizer). */
export const canVoiceSearch = (): boolean => {
  try { return !!nativeTV()?.hasVoice?.(); } catch { return false; }
};

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
  // The screen it lives on is coming back into view: try until it is, then fall back to that screen's start.
  let tries = 0;
  const attempt = () => {
    if (document.activeElement === el) return;
    if (el?.isConnected && visible(el)) { focus(el, 'auto'); if (document.activeElement === el) return; }
    if (++tries < 8) { setTimeout(attempt, 60); return; }
    const cur = document.activeElement;
    if (!cur || cur === document.body) {
      const { pane } = zones();
      if (pane) enterPane(pane, 'auto');
    }
  };
  setTimeout(attempt, 40);
}

/** Put focus on the first matching element if nothing sensible has focus (screen just opened). */
export function initialFocus(selector: string, force = false) {
  if (!isTV()) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!force && cur && cur !== document.body && visible(cur)) return;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  // Forced (Back to the start of a screen): however far it's scrolled away, as long as it's shown.
  if (force ? el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden' : visible(el)) focus(el, 'auto');
}

/**
 * Back in the player: a sheet open → close it; playing with the controls up → hide them (one more
 * Back leaves); otherwise → leave the player. While paused the controls stay on screen, so hiding
 * them would do nothing and Back must leave at once.
 */
export function playerBack(s: { panel: boolean; playing: boolean; focusInPlayer: boolean }): 'close-panel' | 'hide-controls' | 'leave' {
  if (s.panel) return 'close-panel';
  if (s.playing && s.focusInPlayer) return 'hide-controls';
  return 'leave';
}

/** Called by the TV app on Back. Returns false when the app should close. */
function handleBack(): boolean {
  // (Android closes the on-screen keyboard itself before Back reaches the app.)
  if (closePicker()) return true;
  for (const { h } of [...backHandlers]) if (h()) return true;
  return false;
}

// ─── Spatial navigation ─────────────────────────────────────────────────────
/*
 * The model of a TV home screen (Google TV, Apple TV):
 *  - The screen is a pane of rows (posters in a .shelf, or anything marked data-tv-row) and
 *    other controls, under a top bar (data-tv-nav).
 *  - Left/Right move along a row and stop at its ends; they never jump to another row.
 *  - Up/Down go to the nearest row in that direction, back to the item last focused there.
 *  - The top bar is reached by going Up from the top of the pane; Down from the bar returns
 *    to where you were.
 *  - Sheets and the player (role=dialog, data-tv-layer) keep focus inside themselves.
 */

const FOCUSABLE = ['button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea', '[tabindex]']
  .map((s) => `${s}:not([disabled]):not([tabindex="-1"]):not([data-tv-skip])`).join(', ');
const ROW = '.shelf, [data-tv-row]';

/** The item last focused in each row, and in the pane, to return to. */
const rowMemory = new WeakMap<Element, HTMLElement>();
let paneMemory: HTMLElement | undefined;

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

const focusables = (root: ParentNode | null | undefined): HTMLElement[] => (root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);

/**
 * Which open window the remote works in: a drop-down's list when one is open, otherwise the most
 * recently opened window (the last in the page: a sheet opened over another one), else the player.
 */
export function topLayer<T>(dialogs: T[], picker: T | undefined, fallback: T | null): T | null {
  return picker ?? dialogs.at(-1) ?? fallback;
}

function zones() {
  const layer = topLayer([...document.querySelectorAll<HTMLElement>('[role="dialog"]')], picker?.wrap, document.querySelector<HTMLElement>('[data-tv-layer]'));
  const pane = document.querySelector<HTMLElement>('[data-tv-pane]');
  const nav = [...document.querySelectorAll<HTMLElement>('[data-tv-nav]')].find((n) => n.getBoundingClientRect().width > 0) ?? null;
  return { layer, pane, nav };
}

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

/**
 * Rank the candidates for a press in a direction, best first (pure geometry, no DOM).
 * Up/Down: the nearest line of controls first, then the one most in line with where you are.
 * Left/Right: only controls level with you (no diagonal jumps), nearest first.
 */
export function rank<T>(from: Box, items: { item: T; r: Box }[], dir: Dir): T[] {
  // A wide block (a paragraph, a list row) leads from its start, as reading does, not its middle.
  const cx = (dir === 'up' || dir === 'down') && from.width > 320 ? from.left + 60 : from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const found: { item: T; main: number; cross: number }[] = [];
  for (const { item, r } of items) {
    if (r.width < 2 || r.height < 2) continue;
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    if (dir === 'down' || dir === 'up') {
      const main = dir === 'down' ? r.top - from.bottom : from.top - r.bottom;
      if (main < -8 || (dir === 'down' ? ey <= cy + 1 : ey >= cy - 1)) continue;
      const overlapH = r.left < from.right && r.right > from.left;
      found.push({ item, main: Math.max(0, main), cross: overlapH ? Math.abs(ex - cx) / 1000 : Math.min(Math.abs(r.left - cx), Math.abs(r.right - cx)) });
    } else {
      const main = dir === 'right' ? r.left - from.right : from.left - r.right;
      const overlapV = r.top < from.bottom - 4 && r.bottom > from.top + 4;
      if (!overlapV || main < -8 || (dir === 'right' ? ex <= cx + 1 : ex >= cx - 1)) continue;
      found.push({ item, main: Math.max(0, main), cross: Math.abs(ey - cy) });
    }
  }
  if (dir === 'up' || dir === 'down') {
    // The nearest line: everything starting within a few pixels of the closest one.
    found.sort((a, b) => a.main - b.main);
    if (!found.length) return [];
    const near = found[0].main + 24;
    const line = found.filter((x) => x.main <= near).sort((a, b) => a.cross - b.cross || a.main - b.main);
    const rest = found.filter((x) => x.main > near).sort((a, b) => a.main - b.main || a.cross - b.cross);
    return [...line, ...rest].map((x) => x.item);
  }
  return found.sort((a, b) => a.main + a.cross * 2 - (b.main + b.cross * 2)).map((x) => x.item);
}

function pick(list: HTMLElement[], cur: HTMLElement, dir: Dir): HTMLElement | undefined {
  const items = list
    .filter((el) => el !== cur && !el.contains(cur) && !cur.contains(el))
    .map((el) => ({ item: el, r: el.getBoundingClientRect() }))
    .filter((x) => onPage(x.r));
  return rank(cur.getBoundingClientRect(), items, dir).slice(0, 12).find((el) => visible(el));
}

/** Entering a row: its selected choice (segmented controls, seasons), else the item last focused there. */
function remembered(el: HTMLElement): HTMLElement {
  const row = el.closest(ROW);
  const chosen = row?.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"], [aria-current]:not([aria-current="false"])');
  if (chosen && chosen.matches(FOCUSABLE) && visible(chosen)) return chosen;
  const mem = row && rowMemory.get(row);
  return mem && mem.isConnected && row.contains(mem) && visible(mem) ? mem : el;
}

/** Into the pane from the top bar (or from nowhere): where you were, else the screen's start. */
function enterPane(pane: HTMLElement, behavior: ScrollBehavior): boolean {
  const back = paneMemory && paneMemory.isConnected && pane.contains(paneMemory) && visible(paneMemory) ? paneMemory : undefined;
  const start = back ?? pane.querySelector<HTMLElement>('[data-tv-start]:not([disabled])') ?? undefined;
  const el = start && visible(start) ? start : focusables(pane)
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter((x) => x.r.width >= 2 && x.r.bottom > 0 && x.r.top < innerHeight)
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
    .find((x) => visible(x.e))?.e;
  if (!el) return false;
  focus(el, behavior, true);
  return true;
}

function toNav(nav: HTMLElement, behavior: ScrollBehavior): boolean {
  const el = nav.querySelector<HTMLElement>('[aria-current="page"]') ?? focusables(nav)[0];
  if (!el) return false;
  focus(el, behavior);
  return true;
}

export function moveFocus(dir: Dir, behavior: ScrollBehavior = 'smooth'): boolean {
  const cur = document.activeElement as HTMLElement | null;
  const { layer, pane, nav } = zones();
  const has = cur && cur !== document.body;

  // Sheets and the player: plain spatial movement, kept inside.
  if (layer) {
    const list = focusables(layer);
    if (!has || !layer.contains(cur) || !visible(cur)) {
      const first = list.find((e) => visible(e));
      if (first) focus(first, behavior);
      return !!first;
    }
    const next = pick(list, cur, dir);
    if (next) focus(next, behavior);
    return true;
  }

  const inNav = has && nav?.contains(cur);
  const inPane = has && pane?.contains(cur) && visible(cur);
  if (!inNav && !inPane) return pane ? enterPane(pane, behavior) : nav ? toNav(nav, behavior) : false;

  if (inNav) {
    if (dir === 'down' && pane) return enterPane(pane, behavior) || true;
    if (dir === 'left' || dir === 'right') {
      const next = pick(focusables(nav), cur!, dir);
      if (next) focus(next, behavior);
    }
    return true; // Up from the bar: nowhere to go, and the page mustn't scroll
  }

  const row = cur!.closest(ROW);
  if (dir === 'left' || dir === 'right') {
    if (row && pane!.contains(row)) {
      // Along the row in its own order; stop at the ends.
      const items = focusables(row).filter((e) => e.getBoundingClientRect().width >= 2);
      const next = items[items.indexOf(cur!) + (dir === 'right' ? 1 : -1)];
      if (next) focus(next, behavior);
      return true;
    }
    const next = pick(focusables(pane), cur!, dir);
    if (next) focus(next, behavior);
    return true;
  }

  const others = focusables(pane).filter((e) => !row || !row.contains(e));
  const next = pick(others, cur!, dir);
  if (next) {
    focus(remembered(next), behavior, true);
    return true;
  }
  if (dir === 'up' && nav) return toNav(nav, behavior);
  return true;
}

const NAV_CLEARANCE = 96; // floating top bar
const BOTTOM_CLEARANCE = 40;

/**
 * Focus without the browser's own scrolling, then one scroll per axis. Moving between rows
 * brings the new row (with its title) to the same place under the top bar every time, as on
 * TV home screens; near the top the page scrolls right back to its start.
 */
// ─── Text fields ────────────────────────────────────────────────────────────
/*
 * On a TV, focusing a text field opens the on-screen keyboard, so just moving over a search box
 * or a Settings field with the remote would pop it up. Fields are read-only while the remote
 * passes over them; OK makes the field editable and opens the keyboard, and leaving it locks it
 * again.
 */
export const TEXT_FIELD = ['', '[type="text"]', '[type="search"]', '[type="url"]', '[type="email"]', '[type="password"]', '[type="number"]', '[type="tel"]']
  .map((t) => (t ? `input${t}` : 'input:not([type])')).join(', ') + ', textarea';
const LOCKED = 'data-tv-locked';
let editing: HTMLElement | undefined;
let reopening = false;
function lockField(el: Element) {
  const f = el as HTMLInputElement;
  if (f === editing || !f.matches?.(TEXT_FIELD) || f.readOnly) return;
  f.readOnly = true;
  f.setAttribute(LOCKED, '');
}
/** OK on a locked field: make it editable and bring up the keyboard. */
function editField(f: HTMLInputElement) {
  f.readOnly = false;
  f.removeAttribute(LOCKED);
  editing = f;
  // The keyboard opens when an editable field gains focus: focus it again, now editable.
  reopening = true;
  f.blur();
  f.focus({ preventScroll: true });
  reopening = false;
  try { const n = f.value.length; f.setSelectionRange(n, n); } catch { /* number fields */ }
}

function focus(el: HTMLElement, behavior: ScrollBehavior = 'smooth', vertical = false) {
  lockField(el);
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();

  const shelf = el.closest('.shelf, [data-tv-row]') as HTMLElement | null;
  if (shelf && shelf.scrollWidth > shelf.clientWidth + 1) {
    const s = shelf.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(shelf).paddingLeft) || 20;
    let dx = 0;
    if (r.left < s.left + pad) dx = r.left - s.left - pad;
    else if (r.right > s.right - pad) dx = r.right - s.right + pad;
    if (Math.abs(dx) > 1) shelf.scrollTo({ left: shelf.scrollLeft + dx, behavior });
  }

  const sc = scroller(el);
  if (!sc) return;
  const box = sc.getBoundingClientRect();
  const inPage = r.top - box.top + sc.scrollTop; // where the item sits on the whole page
  let top: number | undefined;
  if (inPage + r.height < sc.clientHeight * 0.75) top = 0; // near the start: show the page from its top
  else {
    const section = vertical && shelf ? (el.closest('section') as HTMLElement | null) : null;
    const sr = section?.getBoundingClientRect();
    if (sr && sr.height < sc.clientHeight - NAV_CLEARANCE) top = sc.scrollTop + sr.top - box.top - NAV_CLEARANCE;
    else if (r.top < box.top + NAV_CLEARANCE) top = sc.scrollTop + r.top - box.top - NAV_CLEARANCE;
    else {
      // Going down a list, keep the focus out of the bottom of the screen so you see what's next.
      const below = vertical ? Math.max(BOTTOM_CLEARANCE, sc.clientHeight * 0.3) : BOTTOM_CLEARANCE;
      if (r.bottom > box.bottom - below) top = sc.scrollTop + r.bottom - box.bottom + below;
    }
  }
  if (top != null && Math.abs(top - sc.scrollTop) > 1) sc.scrollTo({ top: Math.max(0, top), behavior });
}

function scroller(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight <= p.clientHeight + 1) continue;
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return undefined;
}

// ─── Drop-downs ─────────────────────────────────────────────────────────────

let picker: { wrap: HTMLElement; select: HTMLSelectElement } | undefined;

/** A sheet listing the drop-down's choices; the arrows move through them, OK picks, Back cancels. */
export function openPicker(select: HTMLSelectElement) {
  closePicker();
  const wrap = document.createElement('div');
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent || 'Choose');
  wrap.className = 'tv-picker';
  const box = document.createElement('div');
  box.className = 'tv-picker-box';
  let current: HTMLButtonElement | undefined;
  for (const o of [...select.options]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tv-pick';
    b.textContent = o.text;
    b.disabled = o.disabled;
    if (o.selected) { b.setAttribute('aria-current', 'true'); current = b; }
    b.addEventListener('click', () => {
      // Set it the way a person would, so React's onChange runs.
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, o.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closePicker();
    });
    box.appendChild(b);
  }
  wrap.appendChild(box);
  document.body.appendChild(wrap);
  picker = { wrap, select };
  (current ?? box.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus({ preventScroll: true });
  (current ?? box.firstElementChild)?.scrollIntoView({ block: 'nearest' });
}

function closePicker(): boolean {
  if (!picker) return false;
  const { wrap, select } = picker;
  picker = undefined;
  wrap.remove();
  select.focus({ preventScroll: true });
  return true;
}

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Hook for keys a screen wants for itself (the player: seek, play/pause). Return true if handled. */
let keyOverride: ((e: KeyboardEvent) => boolean) | undefined;
export const setTvKeyOverride = (fn: typeof keyOverride) => { keyOverride = fn; };

export function startTvMode() {
  if (!isTV() || (window as unknown as { __tvStarted?: boolean }).__tvStarted) return;
  (window as unknown as { __tvStarted?: boolean }).__tvStarted = true;
  document.documentElement.dataset.tv = '1';
  // Text fields: locked whenever focus arrives without OK (see lockField); locked again on leaving.
  document.addEventListener('focusin', (e) => { if (!reopening) lockField(e.target as Element); }, true);
  document.addEventListener('focusout', (e) => {
    if (reopening || e.target !== editing) return;
    editing = undefined;
    lockField(e.target as Element);
  }, true);
  // Remember where focus was in each row and in the pane, to come back to it.
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    const row = el.closest?.(ROW);
    if (row) rowMemory.set(row, el);
    if (el.closest?.('[data-tv-pane]')) paneMemory = el;
  });
  // Never leave the remote with nothing focused (a sheet closed, a list re-rendered): go back to
  // the most recent place that still exists, preferring the screen on top.
  const recent: HTMLElement[] = [];
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    const i = recent.indexOf(el);
    if (i >= 0) recent.splice(i, 1);
    recent.push(el);
    if (recent.length > 16) recent.shift();
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      if (!document.hasFocus()) return;
      const { layer, pane, nav } = zones();
      const zone = layer ?? pane;
      for (let i = recent.length - 1; i >= 0; i--) {
        const el = recent[i];
        if (!el.isConnected || !el.matches(FOCUSABLE) || !visible(el)) continue;
        if (zone && !zone.contains(el) && !(!layer && nav?.contains(el))) continue;
        el.focus({ preventScroll: true });
        return;
      }
      if (layer) moveFocus('down', 'auto');
    }, 80);
  });
  (window as unknown as { __tvBack: () => boolean }).__tvBack = handleBack;
  window.addEventListener('keydown', (e) => {
    if (keyOverride?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === 'Enter' && (document.activeElement as HTMLElement | null)?.hasAttribute(LOCKED)) {
      e.preventDefault(); e.stopImmediatePropagation();
      editField(document.activeElement as HTMLInputElement);
      return;
    }
    // OK on a drop-down: our own list of its choices (the WebView's picker is unreliable on TVs).
    if (e.key === 'Enter' && (document.activeElement as HTMLElement | null)?.tagName === 'SELECT') {
      e.preventDefault(); e.stopImmediatePropagation();
      openPicker(document.activeElement as HTMLSelectElement);
      return;
    }
    const dir = KEY_DIR[e.key];
    if (!dir) return;
    const el = document.activeElement as HTMLElement | null;
    // Let text fields and sliders use left/right themselves.
    // Sliders adjust with left/right, until they reach their end; then the remote moves on.
    if (el?.matches('input[type="range"]') && (dir === 'left' || dir === 'right')) {
      const t = el as HTMLInputElement;
      const v = Number(t.value);
      if (dir === 'left' ? v > Number(t.min || 0) : v < Number(t.max || 100)) return;
    }
    // Text boxes keep left/right for the cursor, until it reaches the start or the end.
    if (el?.matches('input:not([type="range"]):not([type="checkbox"]), textarea') && !el.hasAttribute(LOCKED) && (dir === 'left' || dir === 'right')) {
      const t = el as HTMLInputElement;
      let atEdge = true;
      try {
        atEdge = t.selectionStart == null || (t.selectionStart === t.selectionEnd && t.selectionStart === (dir === 'left' ? 0 : t.value.length));
      } catch { /* inputs without a cursor */ }
      if (!atEdge) return;
    }
    // Held key: jump without animation so focus keeps up with the remote.
    if (moveFocus(dir, e.repeat ? 'auto' : 'smooth')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
