'use client';
/**
 * A Liquid Glass tab bar. The selected tab sits on one glass "platter" that travels between tabs
 * with a spring and swells while it moves (like a gel bubble), rather than each tab lighting up
 * on its own. The bar itself is `.glass` (lensing, rim light, touch light: see globals.css and
 * lib/liquid-glass.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface GlassTab {
  id: string;
  label: string;
  /** Rendered instead of the label (top bar) or above it (bottom bar). */
  icon?: ReactNode;
  /** Top bar: show only the icon (the label becomes the accessible name). */
  iconOnly?: boolean;
}

export function GlassTabs({ tabs, active, onSelect, layout, children }: {
  tabs: GlassTab[];
  active: string | null;
  onSelect: (id: string) => void;
  layout: 'top' | 'bottom';
  children?: ReactNode;
}) {
  const bar = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const placed = useRef(false); // the first placement doesn't animate
  const prev = useRef(active);

  useLayoutEffect(() => {
    const tab = active == null ? null : bar.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!tab) {
      setPill(null);
      placed.current = false;
      return;
    }
    const measure = () => setPill({ x: tab.offsetLeft, w: tab.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tab);
    return () => ro.disconnect();
  }, [active]);

  useEffect(() => {
    if (pill) requestAnimationFrame(() => (placed.current = true));
  }, [pill]);

  // Swell while travelling from one tab to another.
  useEffect(() => {
    const from = prev.current;
    prev.current = active;
    if (from == null || active == null || from === active) return;
    setMoving(true);
    const t = setTimeout(() => setMoving(false), 380);
    return () => clearTimeout(t);
  }, [active]);

  const top = layout === 'top';
  return (
    <nav ref={bar} aria-label="Main"
      className={`glass glass-bar relative flex items-center rounded-full ${top ? 'h-[3.25rem] p-[5px]' : 'h-[3.875rem] p-1'}`}>
      {pill && (
        <span aria-hidden className={`glass-pill ${top ? 'inset-y-[5px]' : 'inset-y-1'}`} data-moving={moving ? '' : undefined} data-still={placed.current ? undefined : ''}
          style={{ width: pill.w, transform: `translateX(${pill.x}px)` }} />
      )}
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button key={t.id} data-tab={t.id} onClick={() => onSelect(t.id)} aria-current={on ? 'page' : undefined}
            aria-label={t.iconOnly ? t.label : undefined}
            className={`glass-tab relative z-[1] flex h-full items-center justify-center rounded-full font-semibold transition-colors duration-300 ${
              on ? 'text-[#4ba3ff]' : 'text-white'} ${
              top ? (t.iconOnly ? 'w-[3.25rem]' : 'px-5 text-[15px]') : 'min-w-[4.75rem] flex-col gap-px px-3 text-[10px] leading-3 tracking-[0.01em]'}`}>
            {top ? (t.iconOnly ? t.icon : t.label) : (<>{t.icon}<span>{t.label}</span></>)}
          </button>
        );
      })}
      {children}
    </nav>
  );
}
