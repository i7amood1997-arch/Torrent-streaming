'use client';
/**
 * Home: a full-bleed featured title, then shelves — Continue Watching, a numbered
 * Top 10, and genre rows that load as they scroll into view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { useApp } from '@/lib/store';
import { posterUrl } from '@/lib/tmdb';
import type { TmdbItem } from '@/lib/types';
import { initialFocus } from '@/lib/tv';
import { IconBack, IconChevron, IconPlay, IconStar, IconX } from './icons';

export function Poster({ item, numeral, wide }: { item: TmdbItem; numeral?: number; wide?: boolean }) {
  const open = useApp((s) => s.openDetail);
  return (
    <button className={`group rounded-xl text-left outline-none ${numeral ? 'flex items-end' : 'block'} ${wide ? 'w-full' : ''}`} onClick={() => open(item)} aria-label={item.title}>
      {numeral && <span className="top-numeral -mr-3 w-[4.2rem] select-none text-right xl:w-[5.4rem] xl:text-[7rem]" aria-hidden>{numeral}</span>}
      <span className={`block ${wide ? 'w-full' : 'w-[7.4rem] md:w-40 xl:w-48 2xl:w-52'}`}>
        <span className="lift relative block aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 group-focus-visible:ring-[3px] group-focus-visible:ring-white">
          {item.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img decoding="async" src={posterUrl(item.posterPath, 'w342')} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full place-items-center p-3 text-center text-sm font-semibold text-ink-200">{item.title}</span>
          )}
        </span>
        {!numeral && <span className="mt-2 block truncate text-[13px] font-medium text-ink-200" dir="auto">{item.title}</span>}
        {!numeral && <span className="block text-[11px] text-ink-400">{[item.year, item.type === 'series' ? 'TV Show' : 'Movie'].filter(Boolean).join(' · ')}</span>}
      </span>
    </button>
  );
}

export function ShelfTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="gutter text-xl font-bold tracking-tight text-white md:text-2xl">{children}</h2>;
}

const Skeleton = () => (
  <>{Array.from({ length: 9 }, (_, i) => <div key={i} className="aspect-[2/3] w-[7.4rem] animate-pulse rounded-xl bg-ink-900 md:w-40 xl:w-48 2xl:w-52" />)}</>
);

/**
 * A horizontal row. Touch: swipe. Mouse: chevrons appear on hover (a vertical wheel
 * can't scroll sideways), and trackpads scroll it natively.
 */
export function Shelf({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  // Arrows are for mouse users only; elsewhere skip the bookkeeping (it re-rendered the row on every scroll frame).
  const [fine, setFine] = useState(false); // decided after mount: the server can't know the pointer
  useEffect(() => setFine(matchMedia('(pointer: fine)').matches), []);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el || !fine) return;
    const start = el.scrollLeft < 8;
    const end = el.scrollLeft + el.clientWidth > el.scrollWidth - 8;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, [fine]);
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, children]);
  const page = (dir: number) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.82, behavior: 'smooth' });
  };
  const arrow = 'absolute top-1/2 z-10 hidden h-[60%] max-h-40 w-[calc(var(--gutter)-0.5rem)] min-w-10 -translate-y-1/2 place-items-center text-white opacity-0 transition group-hover/shelf:opacity-100 [@media(pointer:fine)]:grid';
  return (
    <div className="group/shelf relative">
      <div ref={ref} onScroll={fine ? update : undefined} className={`shelf ${className}`}>{children}</div>
      {fine && !edges.start && <button className={`${arrow} left-0 bg-gradient-to-r from-black/80 to-transparent`} onClick={() => page(-1)} aria-label="Scroll left" tabIndex={-1}><IconBack size={28} /></button>}
      {fine && !edges.end && <button className={`${arrow} right-0 bg-gradient-to-l from-black/80 to-transparent`} onClick={() => page(1)} aria-label="Scroll right" tabIndex={-1}><IconChevron size={28} /></button>}
    </div>
  );
}

/** A row that fetches its titles when it comes near the screen. */
function LazyShelf({ title, type, genre }: { title: string; type: 'movie' | 'series'; genre?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [items, setItems] = useState<TmdbItem[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      api.shelf(type, genre).then((r) => setItems(r.results)).catch(() => setFailed(true));
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [type, genre]);
  if (failed || (items && !items.length)) return null;
  return (
    <section ref={ref} className="space-y-1">
      <ShelfTitle>{title}</ShelfTitle>
      <Shelf>{items ? items.map((it) => <Poster key={`${it.type}-${it.id}`} item={it} />) : <Skeleton />}</Shelf>
    </section>
  );
}

function Hero({ items }: { items: TmdbItem[] }) {
  const open = useApp((s) => s.openDetail);
  const [i, setI] = useState(0);
  const heroRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => {
      // Don't swap the title under the viewer's focus, or while it's scrolled away / the tab is hidden
      // (loading a big new picture mid-scroll causes hitches on TVs).
      if (document.activeElement?.hasAttribute('data-tv-start') || document.hidden) return;
      const hero = heroRef.current?.getBoundingClientRect();
      if (!hero || hero.bottom < 80 || hero.width === 0) return;
      setI((x) => (x + 1) % items.length);
    }, 10000);
    return () => clearInterval(t);
  }, [items.length]);
  const it = items[i % Math.max(1, items.length)];
  // TV: start on the featured title's Play button.
  useEffect(() => { if (items.length) setTimeout(() => initialFocus('[data-tv-start]'), 300); }, [items.length]);
  if (!it) return <div className="h-[68vh] min-h-[420px] animate-pulse bg-ink-900 md:h-[min(78vh,70vw)]" />;
  return (
    <section ref={heroRef} className="relative h-[68vh] min-h-[420px] overflow-hidden md:h-[min(78vh,70vw)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img decoding="async" key={it.id} src={posterUrl(it.backdropPath ?? it.posterPath, 'w1280')} alt="" className="fade kenburns absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/35 to-black/10" />
      <div className="absolute inset-0 hidden bg-gradient-to-r from-black/70 via-transparent to-transparent md:block" />
      <div key={`t-${it.id}`} className="gutter rise absolute inset-x-0 bottom-0 flex flex-col items-center pb-9 text-center md:items-start md:pb-14 md:text-left">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/70">{it.type === 'series' ? 'TV Show' : 'Movie'}{it.year ? ` · ${it.year}` : ''}</p>
        <h1 className="max-w-3xl text-balance text-4xl font-extrabold leading-[1.02] tracking-tight text-white drop-shadow-lg md:text-6xl xl:max-w-4xl xl:text-7xl" dir="auto">{it.title}</h1>
        {it.overview && <p className="mt-3 line-clamp-2 max-w-xl text-sm leading-relaxed text-white/75 md:text-base xl:max-w-2xl xl:text-lg" dir="auto">{it.overview}</p>}
        <div className="mt-5 flex items-center gap-3">
          <button data-tv-start className="btn-primary h-12 rounded-full px-8 text-base xl:h-14 xl:px-10 xl:text-lg" onClick={() => open(it)}><IconPlay size={18} /> Play</button>
          {it.rating ? <span className="inline-flex items-center gap-1 text-sm font-semibold text-white/80"><IconStar size={13} />{it.rating.toFixed(1)}</span> : null}
        </div>
        {items.length > 1 && (
          <div className="mt-3 flex gap-1.5">
            {items.map((x, k) => (
              // Small dot, finger-sized hit area.
              <button key={x.id} tabIndex={-1} onClick={() => setI(k)} aria-label={`Show ${x.title}`} className="-mx-1 grid h-8 min-w-[1.25rem] place-items-center px-1">
                <span className={`block h-1.5 rounded-full transition-all ${k === i ? 'w-5 bg-white' : 'w-1.5 bg-white/35'}`} />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ContinueWatching() {
  const history = useApp((s) => s.history);
  const play = useApp((s) => s.play);
  const forget = useApp((s) => s.forget);
  if (!history.length) return null;
  return (
    <section className="space-y-1">
      <ShelfTitle>Continue Watching</ShelfTitle>
      <Shelf>
        {history.map((h, i) => (
          <div key={`${h.imdbId ?? h.result?.id ?? h.url}-${h.season}-${h.episode}`} className="group relative w-60 md:w-72 xl:w-80">
            <button className="block w-full text-left" onClick={() => play(h)}>
              <span className="lift relative block aspect-video overflow-hidden rounded-xl bg-gradient-to-br from-ink-700 to-ink-900">
                {(h.backdrop || h.poster) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img decoding="async" src={posterUrl(h.backdrop ?? h.poster, 'w500')} alt="" loading="lazy" className="h-full w-full object-cover" />
                )}
                <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent" />
                <span className="absolute bottom-2.5 left-2.5 grid h-8 w-8 place-items-center rounded-full bg-white/20 text-white backdrop-blur"><IconPlay size={13} /></span>
              </span>
              <span className="mt-2 block truncate text-[13px] font-medium text-ink-200" dir="auto">{h.title}</span>
              <span className="block text-[11px] text-ink-400">{h.season != null ? `S${h.season} · E${h.episode}` : h.result?.quality && h.result.quality !== 'Unknown' ? h.result.quality : 'Resume'}</span>
            </button>
            <button className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/50 text-white/80 opacity-0 backdrop-blur transition group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100" onClick={() => forget(i)} aria-label={`Remove ${h.title}`}><IconX size={12} /></button>
          </div>
        ))}
      </Shelf>
    </section>
  );
}

const SHELVES: { title: string; type: 'movie' | 'series'; genre?: string }[] = [
  { title: 'Popular Movies', type: 'movie' },
  { title: 'Popular TV Shows', type: 'series' },
  { title: 'Action', type: 'movie', genre: 'Action' },
  { title: 'Drama Series', type: 'series', genre: 'Drama' },
  { title: 'Comedy', type: 'movie', genre: 'Comedy' },
  { title: 'Sci-Fi', type: 'movie', genre: 'Sci-Fi' },
  { title: 'Crime Series', type: 'series', genre: 'Crime' },
  { title: 'Animation', type: 'series', genre: 'Animation' },
  { title: 'Thrillers', type: 'movie', genre: 'Thriller' },
  { title: 'Documentaries', type: 'movie', genre: 'Documentary' },
];

export function Home({ active }: { active: boolean }) {
  const caps = useApp((s) => s.caps);
  const setView = useApp((s) => s.setView);
  const [items, setItems] = useState<TmdbItem[]>([]);
  const [error, setError] = useState<string>();
  const ready = !!caps && !caps.offline;

  useEffect(() => {
    if (!active || !ready || items.length) return;
    const ac = new AbortController();
    setError(undefined);
    api.tmdbTrending(ac.signal).then(({ results }) => setItems(results)).catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => ac.abort();
  }, [active, ready, items.length]);

  if (caps?.offline || error) {
    return (
      <div className="gutter grid min-h-[70vh] place-items-center text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-2xl font-bold text-white">Can’t load the catalog</h1>
          <p className="text-sm text-ink-400">{caps?.offline ?? error}</p>
          <button className="btn-glass rounded-full px-5" onClick={() => (caps?.offline ? setView('settings') : setError(undefined))}>{caps?.offline ? 'Open Settings' : 'Try again'}</button>
        </div>
      </div>
    );
  }

  const featured = items.filter((i) => i.backdropPath).slice(0, 5);
  return (
    <div className="space-y-7 pb-10">
      <Hero items={featured} />
      <ContinueWatching />
      <section className="space-y-1">
        <ShelfTitle>Top 10 This Week</ShelfTitle>
        <Shelf className="!gap-1">{items.length ? items.slice(0, 10).map((it, i) => <Poster key={`${it.type}-${it.id}`} item={it} numeral={i + 1} />) : <Skeleton />}</Shelf>
      </section>
      {ready && SHELVES.map((s) => <LazyShelf key={s.title} {...s} />)}
    </div>
  );
}
