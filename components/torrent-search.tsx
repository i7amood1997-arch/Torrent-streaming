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
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { searchProgressive } from '@/lib/search-progressive';
import { formatBytes, qualityLabel } from '@/lib/release-parser';
import { applyFilters, countByQuality, DEFAULT_FILTERS, pickBest, rankResults, type ResultFilters, type SortKey } from '@/lib/result-filters';
import { audioPlayable, canPlayMkv } from '@/lib/platform';
import { hasDebrid, useApp, usesRelayStreaming } from '@/lib/store';
import type { IndexerError, MediaType, QualityTier, TorrentResult } from '@/lib/types';
import { IconCopy, IconFilter, IconLeech, IconPlay, IconSeed } from './icons';

export interface SearchContext {
  imdbId?: string;
  tmdbId?: number;
  type?: MediaType;
  season?: number;
  episode?: number;
  /** Episode number counted from the show's first episode. */
  absEpisode?: number;
  title?: string;
  year?: number;
  poster?: string;
  backdrop?: string;
}

interface Props {
  query?: string;
  context?: SearchContext;
  /** Rendered above the results (e.g. the selected title's header). */
  header?: React.ReactNode;
  /** Like `header`, with the best stream for a one-tap Play button. */
  renderHeader?: (h: { best?: TorrentResult; play: (r: TorrentResult) => void; loading: boolean; count: number; instant?: boolean }) => React.ReactNode;
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

const SOURCE_NAMES: Record<string, string> = { archive: 'Internet Archive', animetosho: 'AnimeTosho', mediafusion: 'MediaFusion', addons: 'Your add-ons', torrentio: 'Torrentio', knaben: 'Knaben', yts: 'YTS', eztv: 'EZTV', nyaa: 'Nyaa', apibay: 'Pirate Bay', torrentscsv: 'Torrents-CSV', torznab: 'Jackett/Prowlarr', torrentsdb: 'TorrentsDB', bitsearch: 'Bitsearch' };
const sourceName = (ix: string) => SOURCE_NAMES[ix] ?? ix;

export function QualityBadge({ q }: { q: QualityTier }) {
  return <span className={`pill shrink-0 ${QUALITY_STYLES[q]}`}>{q === 'Unknown' ? '?' : q}</span>;
}

function seedColor(n: number) {
  if (n >= 100) return 'text-hd';
  if (n >= 20) return 'text-fhd';
  if (n >= 5) return 'text-accent';
  return 'text-red-400';
}

export function TorrentSearch({ query, context, header, renderHeader }: Props) {
  const debrid = useApp((s) => hasDebrid(s.settings, s.caps));
  const play = useApp((s) => s.play);
  const playingId = useApp((s) => s.nowPlaying?.result?.id);
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [errors, setErrors] = useState<IndexerError[]>([]);
  const [loading, setLoading] = useState(false);
  const [fatal, setFatal] = useState<string>();
  const [took, setTook] = useState<number>();
  const [pending, setPending] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [filters, setFilters] = useState<ResultFilters>(DEFAULT_FILTERS);
  const [drawer, setDrawer] = useState(false);
  const [showProblems, setShowProblems] = useState(false);

  const key = JSON.stringify({ query, context });
  useEffect(() => {
    if (!query && !context?.imdbId && !context?.tmdbId) return;
    const ac = new AbortController();
    setLoading(true);
    setFatal(undefined);
    setResults([]);
    setErrors([]);
    setTook(undefined);
    setPending([]);
    // Results appear source by source as they arrive.
    searchProgressive(
      query
        ? { q: query }
        : { imdb: context?.imdbId, tmdb: context?.tmdbId, type: context?.type, season: context?.season, episode: context?.episode, title: context?.title, year: context?.year },
      (s) => {
        setResults(s.results);
        setErrors(s.errors);
        setPending(s.pending);
        setSkipped(s.skipped);
        if (s.done) { setTook(s.tookMs); setLoading(false); }
      },
      ac.signal,
    ).catch((e) => { if (e.name !== 'AbortError') { setFatal(e.message); setLoading(false); } });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const counts = useMemo(() => countByQuality(results), [results]);
  const visible = useMemo(() => applyFilters(results, filters), [results, filters]);
  const set = (p: Partial<ResultFilters>) => setFilters((f) => ({ ...f, ...p }));
  const toggleTier = (q: QualityTier) =>
    set({ qualities: filters.qualities.includes(q) ? filters.qualities.filter((x) => x !== q) : [...filters.qualities, q] });

  const onPlay = (r: TorrentResult) =>
    play({ kind: r.url ? 'url' : 'torrent', url: r.url, result: r, title: context?.title ?? r.title, imdbId: context?.imdbId ?? r.imdbId, tmdbId: context?.tmdbId, type: context?.type ?? (r.season != null ? 'series' : undefined), season: context?.season ?? r.season, episode: context?.episode ?? r.episode, absEpisode: context?.absEpisode, poster: context?.poster, backdrop: context?.backdrop });
  // Debrid: check whether the leading results are ready to play at once (title page, once results settle).
  const [cache, setCache] = useState<Record<string, 'instant' | 'not' | 'unknown'>>({});
  const usesDebrid = useApp((s) => hasDebrid(s.settings, s.caps) && (s.settings.engine === 'auto' || s.settings.engine === 'debrid'));
  useEffect(() => { setCache({}); }, [key]);
  useEffect(() => {
    // Results still arriving: check once they've been steady for a moment (a slow source mustn't hold it up).
    if (!renderHeader || !usesDebrid || !results.length) return;
    const top = rankResults(results, { debrid: true, preferMp4: !canPlayMkv(), audioOk: audioPlayable }).filter((r) => !r.url && r.magnet && !(r.id in cache)).slice(0, 5);
    if (!top.length) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      api.checkDebridCache(top.map((r) => ({ infoHash: r.infoHash, magnet: r.magnet, fileIdx: r.fileIdx, season: context?.season ?? r.season, episode: context?.episode ?? r.episode })), ac.signal)
        .then((states) => setCache((c) => {
          const n = { ...c };
          for (const r of top) n[r.id] = states[r.infoHash.toLowerCase()] ?? 'unknown';
          return n;
        }))
        .catch(() => setCache((c) => { const n = { ...c }; for (const r of top) n[r.id] ??= 'unknown'; return n; }));
    }, loading ? 2500 : 800);
    return () => { clearTimeout(t); ac.abort(); };
  }, [renderHeader, usesDebrid, loading, results]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => (renderHeader ? pickBest(results, { debrid, preferMp4: !canPlayMkv(), audioOk: audioPlayable, cache }) : undefined), [results, debrid, renderHeader, cache]);

  // Title page, streaming through the relay: open the torrent there now, so peers are connected and
  // the start of the file is downloading before Play is pressed (the relay drops it if unused).
  const warmed = useRef('');
  useEffect(() => {
    if (!best || best.url || !best.infoHash) return;
    const st = useApp.getState();
    if (!usesRelayStreaming(st.settings, st.caps)) return;
    const season = context?.season ?? best.season;
    const episode = context?.episode ?? best.episode;
    const k = `${best.infoHash}|${season}|${episode}`;
    if (warmed.current === k) return;
    const t = setTimeout(() => { warmed.current = k; api.streamPrepare(best, { season, episode }).catch(() => undefined); }, 1200); // results settle first
    return () => clearTimeout(t);
  }, [best, context?.season, context?.episode]);

  const activeFilterCount = filters.qualities.length + (filters.minSeeders > 0 ? 1 : 0) + (filters.hdrOnly ? 1 : 0) + (filters.text ? 1 : 0) + (filters.maxSizeGb ? 1 : 0);

  const qualityPills = (
    <div className="flex gap-2 md:flex-wrap" role="group" aria-label="Quality" data-tv-row>
      <button aria-pressed={filters.qualities.length === 0} className={`pill shrink-0 ${filters.qualities.length === 0 ? 'border-accent bg-accent-soft text-accent' : 'border-ink-600 text-ink-400'}`} onClick={() => set({ qualities: [] })}>
        All <span className="opacity-70">{results.length}</span>
      </button>
      {TIERS.map((q) => {
        const on = filters.qualities.includes(q);
        return (
          <button key={q} aria-pressed={on} disabled={!counts[q]} onClick={() => toggleTier(q)}
            className={`pill shrink-0 disabled:opacity-30 ${on ? QUALITY_STYLES[q] : 'border-ink-600 text-ink-400 hover:text-ink-200'}`}>
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
      {renderHeader?.({ best, play: onPlay, loading, count: results.length, instant: !!best && cache[best.id] === 'instant' })}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 overflow-x-auto scrollbar-thin">{qualityPills}</div>
        <button className="btn-ghost relative shrink-0 bg-ink-800 md:hidden" onClick={() => setDrawer(true)} aria-label="Open filters">
          <IconFilter size={16} />
          {activeFilterCount > 0 && <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-ink-950">{activeFilterCount}</span>}
        </button>
      </div>
      <div className="hidden max-w-6xl rounded-2xl bg-ink-900 p-3 ring-1 ring-white/[0.06] md:block">{filterControls}</div>

      {/* Status line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
        {results.length > 0 && <span>{visible.length === results.length ? `${results.length} streams` : `${visible.length} of ${results.length} streams`}{took != null ? ` · ${(took / 1000).toFixed(1)} s` : ''}</span>}
        {loading && <span className="animate-pulse">Searching {pending.map(sourceName).join(', ') || '…'}</span>}
        {!loading && !results.length && took != null && <span>No streams · {(took / 1000).toFixed(1)} s</span>}
        {(errors.length > 0 || skipped.length > 0) && (
          <button className="-my-2 py-2 underline decoration-ink-600 underline-offset-2 hover:text-ink-200" onClick={() => setShowProblems((v) => !v)} aria-expanded={showProblems}>
            {errors.length + skipped.length} source{errors.length + skipped.length === 1 ? '' : 's'} didn’t answer
          </button>
        )}
      </div>
      {showProblems && (
        <ul className="space-y-1 rounded-xl bg-ink-900 p-3 text-xs text-ink-400 ring-1 ring-white/[0.06]">
          {errors.map((e) => <li key={e.indexer}><b className="text-ink-200">{sourceName(e.indexer)}</b>: {e.message}</li>)}
          {skipped.length > 0 && <li><b className="text-ink-200">{skipped.map(sourceName).join(', ')}</b>: failed a few minutes ago, skipped for now.</li>}
        </ul>
      )}
      {fatal && <div className="card border-red-500/40 p-4 text-sm text-red-300">{fatal}</div>}

      {/* Results — table on desktop, cards elsewhere */}
      {loading && !results.length ? (
        <ul className="grid gap-2">{Array.from({ length: 6 }, (_, i) => <li key={i} className="card h-[76px] animate-pulse bg-ink-800/60" />)}</ul>
      ) : !loading && !fatal && took != null && !visible.length ? (
        <div className="card p-6 text-center text-sm text-ink-400">No streams match. Loosen filters or try another query.</div>
      ) : (
        // One row component; layout adapts to the *pane* width via a container query (.results in globals.css),
        // so it works in the narrow iPad/desktop list pane as well as full-width.
        <ul className="results grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-2">
          {visible.some((r) => r.url) && (
            <li className="flex items-center gap-2 px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-hd">
              Direct links <span className="font-normal normal-case text-ink-400">· start instantly, no seeders needed</span>
            </li>
          )}
          {[...visible.filter((r) => r.url), ...visible.filter((r) => !r.url)].map((r, i, all) => (
            <Fragment key={r.id}>
            {!r.url && i > 0 && all[i - 1].url && (
              <li className="px-1 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-400">Torrents</li>
            )}
            <li className={`result-row rounded-2xl p-3 ring-1 transition ${r.id === playingId ? 'bg-accent/5 ring-accent/60' : 'bg-ink-900 ring-ink-700/70 hover:ring-ink-600'}`}>
              <div className="rr-main min-w-0">
                <div className="mb-1.5 flex min-w-0 items-center gap-2">
                  <QualityBadge q={r.quality} />
                  <ContainerBadge r={r} />
                  <span className="truncate text-xs text-ink-400">{r.tracker ?? sourceName(r.indexer)}</span>
                </div>
                <ResultTitle r={r} />
              </div>
              <div className="rr-stats text-xs tabular-nums">
                <span className="rr-size text-ink-200">{formatBytes(r.sizeBytes)}</span>
                {r.url ? (
                  <span className="text-hd" title="Direct link: no seeders involved">Direct</span>
                ) : (
                  <>
                    {cache[r.id] === 'instant' && <span className="font-semibold text-hd" title="Ready on Real-Debrid: starts at once">⚡ Instant</span>}
                    <span className={`inline-flex items-center gap-0.5 ${seedColor(r.seeders)}`} title="Seeders"><IconSeed size={12} />{r.seeders}</span>
                    <span className="inline-flex items-center gap-0.5 text-ink-400" title="Leechers"><IconLeech size={12} />{r.leechers}</span>
                  </>
                )}
              </div>
              <div className="rr-actions"><RowActions r={r} onPlay={onPlay} /></div>
            </li>
            </Fragment>
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
            <div className="mb-4 [&>div]:flex-wrap">{qualityPills}</div>
            {filterControls}
            <button className="btn-primary mt-4 w-full" onClick={() => setDrawer(false)}>Show {visible.length} streams</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** File type, when known. MP4 plays everywhere; MKV is converted on the fly on iPhone (lib/mkv). */
function ContainerBadge({ r }: { r: TorrentResult }) {
  const c = r.container ?? r.fileName?.split('.').pop()?.toLowerCase();
  if (!c || !['mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm'].includes(c)) return null;
  const easy = ['mp4', 'm4v', 'mov'].includes(c);
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${easy ? 'bg-hd/15 text-hd' : 'bg-ink-700 text-ink-400'}`}
      title={easy ? 'Plays on every device, including iPhone' : c === 'mkv' ? 'Converted on the fly on iPhone/iPad (iOS 17.1+); some codecs (10-bit H.264, DTS) still need another release' : 'iPhone Safari cannot play this format'}>
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
      <p className="line-clamp-2 break-all text-[13px] font-medium leading-snug text-ink-200" title={r.title}>{r.title.replace(/[._]/g, (c) => `${c}\u200b`)}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
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
    try { await navigator.clipboard.writeText(r.url ?? r.magnet); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* denied */ }
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button className="rr-play btn-primary h-11 w-11 rounded-full p-0" onClick={() => onPlay(r)} aria-label={`Play ${r.title}`}>
        <IconPlay size={16} /> <span className="rr-play-label">Play</span>
      </button>
      <button className="btn-ghost px-2 text-ink-400" onClick={copy} aria-label={r.url ? "Copy link" : "Copy magnet link"} title={r.url ? "Copy link" : "Copy magnet"}>
        {copied ? <span className="text-xs text-hd">✓</span> : <IconCopy size={14} />}
      </button>
    </div>
  );
}
