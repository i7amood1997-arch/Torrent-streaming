'use client';
/**
 * On top of the video:
 *  - Skip Intro / Skip Recap, while the opening or the "previously on" plays (times from
 *    TheIntroDB through the relay).
 *  - Next Episode: when the end credits start (or near the end, if their time isn't known), a card
 *    with a 10-second countdown that starts the next episode; Play Now, or Cancel to keep watching.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { findNext, playNext, streamFor, type NextEp } from '@/lib/next-episode';
import type { PlayRequest } from '@/lib/store';
import { posterUrl } from '@/lib/tmdb';
import type { TorrentResult } from '@/lib/types';
import type { Segments } from '@/lib/server/handlers';
import { IconPlay } from './icons';

const COUNTDOWN = 10;
/** No credits time known: offer the next episode this long before the end. */
const NEAR_END = 25;

export function useSegments(req: PlayRequest | undefined, duration: number): Segments {
  const [seg, setSeg] = useState<Segments>({});
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!req || !(duration > 60)) return;
    const k = `${req.nonce}`;
    if (asked.current === k) return;
    asked.current = k;
    setSeg({});
    const ac = new AbortController();
    api.segments({ tmdb: req.tmdbId, imdb: req.imdbId, type: req.type, season: req.season, episode: req.episode, duration }, ac.signal)
      .then((s) => setSeg(s ?? {}))
      .catch(() => undefined);
    return () => ac.abort();
  }, [req, duration]);
  return seg;
}

export function SkipButton({ seg, time, seek, tv }: { seg: Segments; time: number; seek: (t: number) => void; tv: boolean }) {
  const part = seg.recap && time >= seg.recap.start && time < seg.recap.end - 1 ? { label: 'Skip Recap', end: seg.recap.end }
    : seg.intro && time >= seg.intro.start && time < seg.intro.end - 1 ? { label: 'Skip Intro', end: seg.intro.end } : undefined;
  const ref = useRef<HTMLButtonElement>(null);
  const label = part?.label;
  // TV: the button takes focus so OK skips, as on TV streaming apps.
  useEffect(() => {
    if (!tv || !label) return;
    ref.current?.focus({ preventScroll: true });
    const btn = ref.current;
    return () => { if (document.activeElement === btn) btn?.blur(); };
  }, [tv, label]);
  if (!part) return null;
  return (
    <button ref={ref} className="btn-glass absolute bottom-24 right-4 z-20 h-12 rounded-full px-6 text-[15px] md:bottom-28 md:right-8"
      onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); seek(part.end); }} onClick={(e) => { if (e.detail === 0) seek(part.end); }}>
      {part.label}
    </button>
  );
}

type Card = { k: 'off' } | { k: 'shown'; next: NextEp; left: number } | { k: 'cancelled' };

export function NextUp({ req, seg, time, duration, ended, tv }: { req: PlayRequest; seg: Segments; time: number; duration: number; ended: boolean; tv: boolean }) {
  const [next, setNext] = useState<NextEp | null>();
  const [stream, setStream] = useState<TorrentResult | null>();
  const [card, setCard] = useState<Card>({ k: 'off' });
  const playRef = useRef<HTMLButtonElement>(null);
  const series = req.type === 'series';

  // A new episode: forget the last one's card.
  useEffect(() => { setNext(undefined); setStream(undefined); setCard({ k: 'off' }); }, [req.nonce]);

  const at = seg.credits?.start ?? (duration > 300 ? duration - NEAR_END : Infinity);
  const near = series && duration > 0 && time >= at - 120;
  const due = series && duration > 0 && (time >= at || ended);

  // About two minutes before: find which episode is next and its stream, so it starts at once.
  useEffect(() => {
    if (!near || next !== undefined) return;
    let live = true;
    findNext(req).then((n) => live && setNext(n ?? null)).catch(() => live && setNext(null));
    return () => { live = false; };
  }, [near, next, req]);
  useEffect(() => {
    if (!next || stream !== undefined) return;
    const ac = new AbortController();
    streamFor(req, next, ac.signal).then((s) => setStream(s ?? null)).catch(() => { if (!ac.signal.aborted) setStream(null); });
    return () => ac.abort();
  }, [next, stream, req]);

  // Credits: show the card and count down.
  useEffect(() => {
    if (due && next && card.k === 'off') setCard({ k: 'shown', next, left: COUNTDOWN });
    if (!due && card.k === 'shown' && !ended) setCard({ k: 'off' }); // went back before the credits
  }, [due, next, card.k, ended]);
  useEffect(() => {
    if (card.k !== 'shown' || !stream) return;
    if (card.left <= 0) { playNext(req, card.next, stream); return; }
    const t = setTimeout(() => setCard((c) => (c.k === 'shown' ? { ...c, left: c.left - 1 } : c)), 1000);
    return () => clearTimeout(t);
  }, [card, stream, req]);
  useEffect(() => { if (tv && card.k === 'shown') playRef.current?.focus({ preventScroll: true }); }, [tv, card.k]);

  if (card.k !== 'shown') return null;
  const n = card.next;
  const ready = !!stream;
  const progress = ready ? (COUNTDOWN - card.left) / COUNTDOWN : 0;
  return (
    <div className="absolute bottom-24 right-4 z-20 w-[min(22rem,calc(100%-2rem))] overflow-hidden rounded-3xl bg-black/70 shadow-2xl ring-1 ring-white/15 backdrop-blur-xl md:bottom-28 md:right-8"
      onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
      {n.still && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={posterUrl(n.still, 'w500')} alt="" className="aspect-video w-full object-cover" />
      )}
      <div className="p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">Next Episode</p>
        <p className="mt-1 truncate text-[15px] font-semibold text-white" dir="auto">S{n.season} · E{n.episode}{n.name ? ` · ${n.name}` : ''}</p>
        {stream === null && <p className="mt-1 text-xs text-white/55">No stream found for it yet.</p>}
        <div className="mt-3 flex gap-2">
          <button ref={playRef} className="btn-primary relative h-11 flex-1 overflow-hidden rounded-full text-[15px]" disabled={!ready}
            onClick={() => stream && playNext(req, n, stream)}>
            <span className="absolute inset-y-0 left-0 bg-black/10 transition-[width] duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
            <span className="relative inline-flex items-center gap-2"><IconPlay size={15} /> {ready ? (card.left > 0 ? `Play in ${card.left}` : 'Starting…') : stream === null ? 'Not available' : 'Finding…'}</span>
          </button>
          <button className="btn-glass h-11 rounded-full px-5 text-[15px]" onClick={() => setCard({ k: 'cancelled' })}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
