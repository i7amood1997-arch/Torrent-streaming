'use client';
/**
 * Pictures that appear cleanly. A picture is drawn as it downloads (top first, on iPhone), and a
 * missing one shows a broken-image mark; neither should ever be seen.
 *
 *  - <Picture>: posters and episode pictures. Hidden until it has fully arrived, then fades in
 *    over its tile; one that fails leaves the tile (and whatever `fallback` puts on it).
 *  - <Backdrop>: the big covers (Home's featured title, a title page). The picture on screen stays
 *    until the next one has fully arrived, then the new one fades in over it: no black gap, no
 *    strip. Before the first one arrives, an optional placeholder (the poster, already on the
 *    device) shows blurred.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Done loading, whether just now or from the browser's cache (no load event may come for those). */
const loaded = (img: HTMLImageElement | null) => !!img && img.complete && img.naturalWidth > 0;

export function Picture({ src, also, className = '', imgClassName = 'object-cover', lazy = true, fallback }: {
  src?: string | null;
  /** Other addresses to try, in order, if the first can't be loaded. */
  also?: (string | null | undefined)[];
  /** The tile (size, rounding, background). */
  className?: string;
  imgClassName?: string;
  lazy?: boolean;
  /** Shown on the tile when there is no picture or none could be loaded. */
  fallback?: ReactNode;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const sources = [src, ...(also ?? [])].filter((x): x is string => !!x);
  const key = sources.join('|');
  const [at, setAt] = useState(0);
  const [state, setState] = useState<'loading' | 'shown' | 'failed'>('loading');
  // New addresses: start over (already in the cache → shown at once, without a fade).
  useLayoutEffect(() => { setAt(0); setState(loaded(ref.current) ? 'shown' : 'loading'); }, [key]);
  const current = sources[at];
  const show = !!current && state !== 'failed';
  const failed = () => {
    if (at + 1 < sources.length) { setAt(at + 1); setState('loading'); } // the next choice
    else setState('failed');
  };
  return (
    <span className={`${/\babsolute\b/.test(className) ? '' : 'relative '}block overflow-hidden ${className}`}>
      {!show && fallback}
      {show && (
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={ref} key={current} src={current} alt="" decoding="async" loading={lazy ? 'lazy' : undefined} draggable={false}
          onLoad={() => setState('shown')} onError={failed}
          className={`absolute inset-0 h-full w-full transition-opacity duration-300 ease-out ${state === 'shown' ? 'opacity-100' : 'opacity-0'} ${imgClassName}`} />
      )}
    </span>
  );
}

interface Layer { src: string; ready: boolean }

export function Backdrop({ src, placeholder, imgClassName = '', priority = true }: {
  src?: string | null;
  /** Shown blurred until the first picture has arrived (e.g. the poster). */
  placeholder?: string | null;
  /** Extra classes for each picture (e.g. the slow zoom on Home). */
  imgClassName?: string;
  priority?: boolean;
}) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // A new picture goes on top, hidden; the newest one already shown stays below it until then.
  useEffect(() => {
    if (!src) return;
    setLayers((ls) => (ls.some((l) => l.src === src) ? ls : [...ls.filter((l) => l.ready).slice(-1), { src, ready: false }]));
  }, [src]);

  const ready = (s: string) => {
    setLayers((ls) => ls.map((l) => (l.src === s ? { ...l, ready: true } : l)));
    // Once it has faded in, drop the ones beneath it.
    timers.current.push(setTimeout(() => setLayers((ls) => { const i = ls.findIndex((l) => l.src === s); return i > 0 ? ls.slice(i) : ls; }), 600));
  };
  const failed = (s: string) => setLayers((ls) => ls.filter((l) => l.src !== s));
  const anyShown = layers.some((l) => l.ready);

  return (
    <>
      {placeholder && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={placeholder} alt="" aria-hidden draggable={false}
          className={`absolute inset-0 h-full w-full scale-110 object-cover blur-2xl transition-opacity duration-500 ${anyShown ? 'opacity-0' : 'opacity-60'}`} />
      )}
      {layers.map((l) => (
        <BackdropLayer key={l.src} layer={l} priority={priority} className={imgClassName} onReady={ready} onFail={failed} />
      ))}
    </>
  );
}

function BackdropLayer({ layer, priority, className, onReady, onFail }: { layer: Layer; priority: boolean; className: string; onReady: (s: string) => void; onFail: (s: string) => void }) {
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => { if (!layer.ready && loaded(ref.current)) onReady(layer.src); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={ref} src={layer.src} alt="" decoding="async" fetchPriority={priority ? 'high' : undefined} draggable={false}
      onLoad={() => onReady(layer.src)} onError={() => onFail(layer.src)}
      className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ease-out ${layer.ready ? 'opacity-100' : 'opacity-0'} ${className}`} />
  );
}
