'use client';
/**
 * A Liquid Glass tab bar, after Apple's: the selected tab sits on a dark glass platter; when you
 * switch, the platter turns into a clear lens (bright rim, bending what's under it) that glides to
 * the new tab, then settles back into a platter.
 *
 * The glass surface is its own layer behind the tabs, not their parent: Safari leaves stale
 * paint behind when a child of a backdrop-filtered element animates past its edges, and the
 * lens has to sit above the labels to bend them.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface GlassTab {
  id: string;
  label: string;
  /** Bottom bar: drawn above the label. */
  icon?: ReactNode;
}

/** How long the lens is out, ms (Apple's switch takes about this long). */
const LENS_MS = 380;

export function GlassTabs({ tabs, active, onSelect, layout, children }: {
  tabs: GlassTab[];
  active: string | null;
  onSelect: (id: string) => void;
  layout: 'top' | 'bottom';
  children?: ReactNode;
}) {
  const bar = useRef<HTMLElement>(null);
  const [spot, setSpot] = useState<{ x: number; w: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [placed, setPlaced] = useState(false); // the first placement doesn't animate
  const prev = useRef(active);

  useLayoutEffect(() => {
    const tab = active == null ? null : bar.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!tab) {
      setSpot(null);
      setPlaced(false);
      return;
    }
    const measure = () => setSpot({ x: tab.offsetLeft, w: tab.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tab);
    return () => ro.disconnect();
  }, [active]);

  useEffect(() => {
    if (!spot || placed) return;
    const id = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(id);
  }, [spot, placed]);

  // Lift the lens while the selection travels.
  useEffect(() => {
    const from = prev.current;
    prev.current = active;
    if (from == null || active == null || from === active) return;
    setMoving(true);
    const t = setTimeout(() => setMoving(false), LENS_MS);
    return () => clearTimeout(t);
  }, [active]);

  const top = layout === 'top';
  const pad = top ? 'inset-y-[5px]' : 'inset-y-1';
  // `translate`, not `transform`: the lens also scales, and `scale` would stretch a transform's offset too.
  const at = spot ? { translate: `${spot.x}px 0` } : undefined;
  return (
    <nav ref={bar} aria-label="Main" data-moving={moving ? '' : undefined}
      className={`glass-host relative flex items-center rounded-full ${top ? 'h-[3.25rem] p-[5px]' : 'h-[3.875rem] p-1'}`}>
      <span aria-hidden className="glass absolute inset-0 rounded-full" />
      {spot && (
        <span aria-hidden className={`glass-pill ${pad}`} data-still={placed ? undefined : ''} style={{ ...at, width: spot.w }} />
      )}
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button key={t.id} data-tab={t.id} onClick={() => onSelect(t.id)} aria-current={on ? 'page' : undefined}
            className={`glass-tab relative flex h-full items-center justify-center rounded-full font-semibold transition-colors duration-300 ${
              on ? 'text-[#4ba3ff]' : 'text-white'} ${
              top ? 'px-5 text-[15px]' : 'w-[4.75rem] flex-col gap-px text-[10px] leading-3 tracking-[0.01em]'}`}>
            {top ? t.label : (<>{t.icon}<span>{t.label}</span></>)}
          </button>
        );
      })}
      {children}
      {/* The lens rides above the labels so it can bend them; it jumps to its new width and only glides sideways. */}
      {spot && (
        <span aria-hidden className={`glass-lens ${pad}`} data-still={placed ? undefined : ''} style={{ ...at, width: spot.w }} />
      )}
    </nav>
  );
}
