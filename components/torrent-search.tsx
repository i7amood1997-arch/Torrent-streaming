'use client';
/**
 * Direct Torrent Search UI.
 *
 * Used in two places:
 *  - Raw mode: `query="dune 2160p"` → free-text search across indexers
 *  - Catalog mode: `context={ imdbId, type, season, episode, ... }` → id search
 *
 * Live client-side filtering by quality tier, minimum seeders, HDR, text and
 * size, with a filter drawer on phones and an inline bar on iPad/desktop.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client-api';
import { formatBytes, qualityLabel } from '@/lib/release-parser';
import { applyFilters, countByQuality, DEFAULT_FILTERS, type ResultFilters, type SortKey } from '@/lib/result-filters';
import { useApp } from '@/lib/store';
import type { IndexerError, MediaType, QualityTier, TorrentResult } from '@/lib/types';
import { IconCopy, IconFilter, IconLeech, IconPlay, IconSeed } from './icons';

export interface SearchContext {
  imdbId?: string;
  tmdbId?: number;
  type?: MediaType;
  season?: number;
  episode?: number;
  title?: string;
  year?: number;
}

interface Props {
  query?: string;
  context?: SearchContext;
  /** Rendered above the results (e.g. the selected title's header). */
  header?: React.ReactNode;
}

const TIERS: QualityTier[] = ['4K', '1080p', '720p', 'SD'];
const SEED_STEPS = [0, 1, 5, 10, 25, 50, 100, 250, 500];

export const QUALITY_STYLES: Record<QualityTier, string> = {
  '4K': 'border-uhd/50 bg-uhd/15 text-uhd',
  '1080p': 'border-fhd/50 bg-fhd/15 text-fhd',
  '720p': 'border-hd/50 bg-hd/15 text-hd',
  SD: 'border-ink-400/40 bg-ink-600/40 text-ink-200',
  Unknown: 'border-ink-600 bg-ink-800 text-ink-400',
};

export function QualityBadge({ q }: { q: QualityTier }) {
  return <span className={`pill shrink-0 ${QUALITY_STYLES[q]}`}>{q === 'Unknown' ? '?' : q}</span>;
}

function seedColor(n: number) {
  if (n >= 100) return 'text-hd';
  if (n >= 20) return 'text-fhd';
  if (n >= 5) return 'text-accent';
  return 'text-red-400';
}

export function TorrentSearch({ query, context, header }: Props) {
  const play = useApp((s) => s.play);
  const playingId = useApp((s) => s.nowPlaying?.result?.id);
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [errors, setErrors] = useState<IndexerError[]>([]);
  const [loading, setLoading] = useState(false);
  const [fatal, setFatal] = useState<string>();
  const [took, setTook] = useState<number>();
  const [filters, setFilters] = useState<ResultFilters>(DEFAULT_FILTERS);
  const [drawer, setDrawer] = useState(false);

  const key = JSON.stringify({ query, context });
  useEffect(() => {
    if (!query && !context?.imdbId && !context?.tmdbId) return;
    const ac = new AbortController();
    setLoading(true);
    setFatal(undefined);
    setResults([]);
    api
      .search(
        query
          ? { q: query }
          : { imdb: context?.imdbId, tmdb: context?.tmdbId, type: context?.type, season: context?.season, episode: context?.episode, title: context?.title, year: context?.year },
        ac.signal,
      )
      .then((r) => { setResults(r.results); setErrors(r.errors); setTook(r.tookMs); })
      .catch((e) => { if (e.name !== 'AbortError') setFatal(e.message); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const counts = useMemo(() => countByQuality(results), [results]);
  const visible = useMemo(() => applyFilters(results, filters), [results, filters]);
  const set = (p: Partial<ResultFilters>) => setFilters((f) => ({ ...f, ...p }));
  const toggleTier = (q: QualityTier) =>
    set({ qualities: filters.qualities.includes(q) ? filters.qualities.filter((x) => x !== q) : [...filters.qualities, q] });

  const onPlay = (r: TorrentResult) =>
    play({ kind: 'torrent', result: r, title: context?.title ?? r.title, imdbId: context?.imdbId ?? r.imdbId, tmdbId: context?.tmdbId, type: context?.type ?? (r.season != null ? 'series' : undefined), season: context?.season ?? r.season, episode: context?.episode ?? r.episode });

  const activeFilterCount = filters.qualities.length + (filters.minSeeders > 0 ? 1 : 0) + (filters.hdrOnly ? 1 : 0) + (filters.text ? 1 : 0) + (filters.maxSizeGb ? 1 : 0);

  const qualityPills = (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Quality">
      <button className={`pill ${filters.qualities.length === 0 ? 'border-accent bg-accent-soft text-accent' : 'border-ink-600 text-ink-400'}`} onClick={() => set({ qualities: [] })}>
        All <span className="opacity-70">{results.length}</span>
      </button>
      {TIERS.map((q) => {
        const on = filters.qualities.includes(q);
        return (
          <button key={q} aria-pressed={on} disabled={!counts[q]} onClick={() => toggleTier(q)}
            className={`pill disabled:opacity-30 ${on ? QUALITY_STYLES[q] : 'border-ink-600 text-ink-400 hover:text-ink-200'}`}>
            {qualityLabel(q)} <span className="opacity-70">{counts[q]}</span>
          </button>
        );
      })}
    </div>
  );

  const filterControls = (
    <div className="grid gap-4 md:flex md:flex-wrap md:items-end md:gap-x-4 md:gap-y-3 [&>*]:min-w-0 md:[&>*:nth-child(1)]:flex-[2_1_180px] md:[&>*:nth-child(2)]:flex-[1_1_150px] md:[&>*:nth-child(3)]:w-36">
      <div>
        <label className="label" htmlFor="flt-text">Filter results</label>
        <input id="flt-text" className="input" placeholder="Release group, tracker, codec…" value={filters.text} onChange={(e) => set({ text: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="flt-seed">Min seeders: <span className="text-accent">{filters.minSeeders}</span></label>
        <input id="flt-seed" type="range" min={0} max={SEED_STEPS.length - 1} step={1} className="w-full"
          value={Math.max(0, SEED_STEPS.indexOf(filters.minSeeders))} onChange={(e) => set({ minSeeders: SEED_STEPS[+e.target.value] })} />
      </div>
      <div>
        <label className="label" htmlFor="flt-sort">Sort</label>
        <select id="flt-sort" className="input" value={filters.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
          <option value="seeders">Seeders</option>
          <option value="quality">Quality</option>
          <option value="size">Size</option>
          <option value="date">Newest</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-3 pb-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={filters.hdrOnly} onChange={(e) => set({ hdrOnly: e.target.checked })} /> HDR/DV</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={filters.hideCam} onChange={(e) => set({ hideCam: e.target.checked })} /> Hide CAM</label>
      </div>
    </div>
  );

  return (
    <section className="flex min-h-0 flex-col gap-3">
      {header}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 overflow-x-auto scrollbar-thin">{qualityPills}</div>
        <button className="btn-ghost relative shrink-0 border border-ink-600 md:hidden" onClick={() => setDrawer(true)} aria-label="Open filters">
          <IconFilter size={16} /> Filters
          {activeFilterCount > 0 && <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-ink-950">{activeFilterCount}</span>}
        </button>
      </div>
      <div className="hidden md:block card p-3">{filterControls}</div>

      {/* Status line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
        {loading ? <span className="animate-pulse">Searching indexers…</span> : took != null && <span>{visible.length} of {results.length} streams · {took} ms</span>}
        {errors.map((e) => <span key={e.indexer} className="text-red-400/80" title={e.message}>⚠ {e.indexer}: {e.message}</span>)}
      </div>
      {fatal && <div className="card border-red-500/40 p-4 text-sm text-red-300">{fatal}</div>}

      {/* Results — table on desktop, cards elsewhere */}
      {loading && !results.length ? (
        <ul className="grid gap-2">{Array.from({ length: 6 }, (_, i) => <li key={i} className="card h-[76px] animate-pulse bg-ink-800/60" />)}</ul>
      ) : !loading && !fatal && took != null && !visible.length ? (
        <div className="card p-6 text-center text-sm text-ink-400">No streams match. Loosen filters or try another query.</div>
      ) : (
        // One row component; layout adapts to the *pane* width via a container query (.results in globals.css),
        // so it works in the narrow iPad/desktop list pane as well as full-width.
        <ul className="results grid grid-cols-[minmax(0,1fr)] gap-2">
          {visible.map((r) => (
            <li key={r.id} className={`result-row card p-3 ${r.id === playingId ? 'border-accent/60 bg-accent/5' : 'hover:border-ink-600'}`}>
              <div className="rr-main min-w-0">
                <div className="mb-1.5 flex min-w-0 items-center gap-2">
                  <QualityBadge q={r.quality} />
                  <ContainerBadge r={r} />
                  <span className="truncate text-xs text-ink-400">{r.tracker ?? r.indexer}</span>
                </div>
                <ResultTitle r={r} />
              </div>
              <div className="rr-stats text-xs tabular-nums">
                <span className="rr-size text-ink-200">{formatBytes(r.sizeBytes)}</span>
                <span className={`inline-flex items-center gap-0.5 ${seedColor(r.seeders)}`} title="Seeders"><IconSeed size={12} />{r.seeders}</span>
                <span className="inline-flex items-center gap-0.5 text-ink-400" title="Leechers"><IconLeech size={12} />{r.leechers}</span>
              </div>
              <div className="rr-actions"><RowActions r={r} onPlay={onPlay} /></div>
            </li>
          ))}
        </ul>
      )}

      {/* Mobile filter drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Torrent filters">
          <button className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} aria-label="Close filters" />
          <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-ink-600 bg-ink-900 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Filters</h2>
              <button className="btn-ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset</button>
            </div>
            <div className="mb-4">{qualityPills}</div>
            {filterControls}
            <button className="btn-primary mt-4 w-full" onClick={() => setDrawer(false)}>Show {visible.length} streams</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** File type, when known. MP4 plays on iPhone via the relay; MKV needs Debrid or the online player there. */
function ContainerBadge({ r }: { r: TorrentResult }) {
  const c = r.container ?? r.fileName?.split('.').pop()?.toLowerCase();
  if (!c || !['mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm'].includes(c)) return null;
  const easy = ['mp4', 'm4v', 'mov'].includes(c);
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${easy ? 'bg-hd/15 text-hd' : 'bg-ink-700 text-ink-400'}`}
      title={easy ? 'Plays on every device, including iPhone' : 'iPhone Safari cannot play this format directly'}>
      {c}
    </span>
  );
}

function ResultTitle({ r }: { r: TorrentResult }) {
  const tags = [
    ...r.hdr,
    r.remux ? 'REMUX' : undefined,
    r.source && !r.remux ? r.source : undefined,
    r.videoCodec,
    [r.audio.slice(0, 2).join('/'), r.channels].filter(Boolean).join(' ') || undefined,
  ].filter(Boolean) as string[];
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-ink-200" title={r.title}>{r.title}</p>
      {r.fileName && <p className="truncate text-xs text-ink-400" title={r.fileName}>{r.fileName}</p>}
      <div className="mt-1 flex flex-wrap gap-1">
        {tags.map((t) => (
          <span key={t} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${t === 'DV' || t.startsWith('HDR') ? 'bg-uhd/20 text-uhd' : 'bg-ink-700 text-ink-200'}`}>{t}</span>
        ))}
        {r.releaseGroup && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{r.releaseGroup}</span>}
      </div>
    </div>
  );
}

function RowActions({ r, onPlay }: { r: TorrentResult; onPlay: (r: TorrentResult) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.magnet); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* denied */ }
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button className="btn-primary px-3" onClick={() => onPlay(r)} aria-label={`Play ${r.title}`}>
        <IconPlay size={14} /> <span className="rr-play-label">Play</span>
      </button>
      <button className="btn-ghost px-2 text-ink-400" onClick={copy} aria-label="Copy magnet link" title="Copy magnet">
        {copied ? <span className="text-xs text-hd">✓</span> : <IconCopy size={14} />}
      </button>
    </div>
  );
}
