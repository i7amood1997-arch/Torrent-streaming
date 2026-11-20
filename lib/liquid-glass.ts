/**
 * Liquid Glass, the parts CSS alone can't do.
 *
 * 1. Lensing. Apple's material bends light rather than just blurring it: the glass is a slab whose
 *    rim curves down like a thick lens, so near the edge the content behind is pulled in and
 *    magnified while the middle stays flat. We model that physically: a convex "squircle" bezel
 *    profile, Snell's law with glass's refractive index, and the resulting sideways shift turned
 *    into a displacement map for an SVG filter that the element uses as its backdrop-filter.
 *    Only Chromium (Chrome, Edge, Android) can run an SVG filter on the backdrop; Safari and
 *    Firefox keep the CSS glass (blur, rim light, depth), which is all they allow web pages.
 * 2. Touch light. Glass "energises" where it's touched: a soft glow follows the finger
 *    (CSS draws it from --lg-x/--lg-y; this sets them). Works in every browser.
 *
 * The TV app and Reduce Transparency get neither (solid materials, see globals.css).
 */

export const GLASS_SELECTOR = '.glass, .glass-btn, .btn-glass';
/** Everything that gets a lens: glass surfaces, plus the tab bar's travelling lens. */
const LENS_SELECTOR = `${GLASS_SELECTOR}, .glass-lens`;
const MAX_FILTERS = 48;
const IOR = 1.5; // refractive index of glass

/**
 * Slope of the rim's surface at x ∈ [0,1] (0 = outer edge, 1 = where the glass turns flat).
 * The rim is a rounded lip, h(x) = 1 − (1−x)², as tall as `LIP` × its width: steep at the
 * edge, easing into the flat top, so the bending fades gradually across the whole rim (the
 * broad lens band Apple's glass shows) rather than only in the last pixel.
 */
const LIP = 1.6;
function bezelSlope(x: number): number {
  return 2 * (1 - x) * LIP;
}

/** Sideways shift (in units of glass thickness) of a vertical ray that crosses the rim at x (Snell's law). */
export function refractionShift(x: number, ior = IOR): number {
  if (x >= 1) return 0;
  const incidence = Math.atan(bezelSlope(Math.max(0, x))); // surface normal vs. the ray
  const refracted = Math.asin(Math.sin(incidence) / ior);
  return Math.tan(incidence - refracted);
}

export interface GlassMap {
  /** RGBA pixels: R/G = horizontal/vertical shift, 128 = none. */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** The feDisplacementMap scale that turns the encoded values back into pixels. */
  scale: number;
}

/**
 * Displacement map for a rounded rectangle (w×h, corner radius r) whose rim curves over `bezel`
 * pixels and bends light by up to `strength` pixels at the very edge. Each pixel stores where in
 * the backdrop it should look: inward along the surface normal, by the refraction shift.
 */
export function glassMap(w: number, h: number, r: number, bezel: number, strength: number): GlassMap {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  r = Math.min(r, w / 2, h / 2);
  const data = new Uint8ClampedArray(w * h * 4);
  const peak = refractionShift(0);
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Signed distance to the rounded rectangle (negative inside) and its outward normal.
      const px = x + 0.5 - w / 2;
      const py = y + 0.5 - h / 2;
      const qx = Math.abs(px) - hx;
      const qy = Math.abs(py) - hy;
      let nx = 0;
      let ny = 0;
      let dist: number;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        dist = len - r;
        nx = (qx / len) * Math.sign(px);
        ny = (qy / len) * Math.sign(py);
      } else {
        dist = Math.max(qx, qy) - r;
        if (qx > qy) nx = Math.sign(px);
        else ny = Math.sign(py);
      }
      const depth = -dist; // how far inside the edge
      const i = (y * w + x) * 4;
      let shift = 0;
      if (depth >= 0 && depth < bezel) shift = (refractionShift(depth / bezel) / peak) * strength;
      // Look inward (against the outward normal): the curved rim magnifies what's under it.
      const dx = -nx * shift;
      const dy = -ny * shift;
      data[i] = 128 + Math.round((dx / strength) * 127);
      data[i + 1] = 128 + Math.round((dy / strength) * 127);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  // feDisplacementMap moves by scale × (value − 0.5); a full ±127 swing should be ±strength.
  return { data, width: w, height: h, scale: strength * 2 };
}

/** Bezel width and bending strength for an element of this size (a bar gets a broader rim than a small button). */
export function lensFor(w: number, h: number): { bezel: number; strength: number } {
  const short = Math.min(w, h);
  return { bezel: Math.max(6, Math.min(short * 0.4, 26)), strength: Math.max(5, Math.min(short * 0.32, 20)) };
}

// ── Browser side ────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
let defs: SVGDefsElement | null = null;
const filters = new Map<string, string>(); // size key → filter id (oldest first)
let serial = 0;
const uses = new Map<string, number>(); // filter id → elements using it
const applied = new WeakMap<HTMLElement, string>();

/** True only where the backdrop can run an SVG filter (Chromium). Safari reports support but draws nothing. */
export function canLens(): boolean {
  if (typeof navigator === 'undefined' || typeof CSS === 'undefined') return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  if (!brands?.some((b) => /Chromium/i.test(b.brand))) return false;
  return CSS.supports('backdrop-filter', 'url(#x)');
}

function filterFor(w: number, h: number, r: number, blur: number, power: number): string {
  const key = `${w}x${h}r${r}b${blur}p${power}`;
  const known = filters.get(key);
  if (known) return known;
  if (!defs) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }
  const lensSize = lensFor(w, h);
  const map = glassMap(w, h, r, lensSize.bezel, lensSize.strength * power);
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  canvas.getContext('2d')!.putImageData(new ImageData(map.data, map.width, map.height), 0, 0);
  // Sizes come and go (resizing windows, animated widths): keep only the most recent filters.
  // Only filters no element is using are dropped.
  if (filters.size >= MAX_FILTERS) {
    for (const [oldKey, oldId] of filters) {
      if (uses.get(oldId)) continue;
      filters.delete(oldKey);
      uses.delete(oldId);
      document.getElementById(oldId)?.remove();
      break;
    }
  }
  const id = `lg${++serial}`;
  const f = document.createElementNS(SVG_NS, 'filter');
  f.id = id;
  f.setAttribute('x', '0');
  f.setAttribute('y', '0');
  f.setAttribute('width', String(w));
  f.setAttribute('height', String(h));
  f.setAttribute('filterUnits', 'userSpaceOnUse');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.innerHTML =
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" edgeMode="duplicate" result="frost"/>` +
    `<feImage href="${canvas.toDataURL()}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="lens"/>` +
    `<feDisplacementMap in="frost" in2="lens" scale="${map.scale}" xChannelSelector="R" yChannelSelector="G"/>`;
  defs.appendChild(f);
  filters.set(key, id);
  return id;
}

function lens(el: HTMLElement) {
  const w = Math.round(el.offsetWidth);
  const h = Math.round(el.offsetHeight);
  if (w < 8 || h < 8) return;
  const cs = getComputedStyle(el);
  const r = Math.round(parseFloat(cs.borderTopLeftRadius) || 0);
  const num = (name: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const id = filterFor(w, h, r, num('--lg-blur', 3), num('--lg-power', 1));
  const before = applied.get(el);
  if (before === id) return;
  if (before) uses.set(before, (uses.get(before) ?? 1) - 1);
  uses.set(id, (uses.get(id) ?? 0) + 1);
  applied.set(el, id);
  // The SVG lens, then the same vibrancy as the CSS glass.
  el.style.backdropFilter = `url(#${id}) ${cs.getPropertyValue('--lg-tone').trim() || 'saturate(1.7) brightness(1.04)'}`;
  el.dataset.lens = '';
}

let started = false;

/** Turns on lensing (where possible) and touch light for every glass surface, now and as they appear. */
export function startLiquidGlass() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // The TV app draws plain solid surfaces: no touch light, no lens, no watchers at all.
  if (document.documentElement.dataset.tv != null) return;
  const solid = () =>
    document.documentElement.dataset.tv != null || matchMedia('(prefers-reduced-transparency: reduce)').matches;

  // Touch light: remember where the finger is on the glass it pressed.
  const press = (e: PointerEvent) => {
    const target = e.target as Element | null;
    // A tab bar's glass is a layer behind its tabs: light that layer, and flex the whole bar.
    const host = target?.closest?.('.glass-host') as HTMLElement | null;
    const el = (host ? host.querySelector(':scope > .glass') : target?.closest?.(GLASS_SELECTOR)) as HTMLElement | null;
    if (!el || solid()) return;
    if (host) host.dataset.lit = '';
    const b = el.getBoundingClientRect();
    el.style.setProperty('--lg-x', `${e.clientX - b.left}px`);
    el.style.setProperty('--lg-y', `${e.clientY - b.top}px`);
    el.dataset.lit = '';
    const off = () => {
      delete el.dataset.lit;
      if (host) delete host.dataset.lit;
      window.removeEventListener('pointerup', off, true);
      window.removeEventListener('pointercancel', off, true);
    };
    window.addEventListener('pointerup', off, true);
    window.addEventListener('pointercancel', off, true);
  };
  window.addEventListener('pointerdown', press, { capture: true, passive: true });

  if (!canLens()) return;
  const sizes = new ResizeObserver((entries) => {
    if (solid()) return;
    for (const e of entries) lens(e.target as HTMLElement);
  });
  const watched = new WeakSet<Element>();
  const scan = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>(LENS_SELECTOR).forEach((el) => {
      if (watched.has(el)) return;
      watched.add(el);
      sizes.observe(el);
    });
  };
  scan(document);
  new MutationObserver((records) => {
    for (const rec of records) {
      rec.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const el = n as HTMLElement;
        if (el.matches(LENS_SELECTOR) && !watched.has(el)) {
          watched.add(el);
          sizes.observe(el);
        }
        scan(el);
      });
      if (rec.type === 'attributes' && rec.target.nodeType === 1) {
        const el = rec.target as HTMLElement;
        if (el.matches(LENS_SELECTOR) && !watched.has(el)) {
          watched.add(el);
          sizes.observe(el);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}
