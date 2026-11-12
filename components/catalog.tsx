'use client';
/**
 * Catalog Mode (TMDB):
 *   query → TMDB multi-search → pick title → (series: season/episode) → torrent streams by IMDB id
 * Fallback: no TMDB key or zero TMDB matches → raw torrent search for the same text.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { useApp } from '@/lib/store';
import { posterUrl } from '@/lib/tmdb';
import type { TmdbDetails, TmdbEpisode, TmdbItem } from '@/lib/types';
import { IconBack, IconFilm, IconStar, IconTv } from './icons';
import { TorrentSearch } from './torrent-search';

export function Catalog({ active }: { active: boolean }) {
  const submitted = useApp((s) => s.submittedQuery);
  const mode = useApp((s) => s.mode);
  const caps = useApp((s) => s.caps);
  const userKey = useApp((s) => s.settings.tmdbKey);
  const tmdbAvailable = !!userKey || !!caps?.tmdb;
  const query = mode === 'catalog' ? submitted : '';

  const [items, setItems] = useState<TmdbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<TmdbItem>();
  const [fallback, setFallback] = useState<string>();

  useEffect(() => {
    if (!active || !caps) return;
    setSelected(undefined);
    setFallback(undefined);
    if (!tmdbAvailable) {
      if (query) setFallback(query);
      setItems([]);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(undefined);
    (query ? api.tmdbSearch(query, ac.signal) : api.tmdbTrending(ac.signal))
      .then(({ results }) => {
        setItems(results);
        if (query && !results.length) setFallback(query); // Option C: no TMDB match → raw torrent search
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
        if (query) setFallback(query);
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [query, active, tmdbAvailable, caps]);

  if (selected) return <TitleDetail item={selected} onBack={() => setSelected(undefined)} />;

  if (fallback) {
    return (
      <div className="space-y-3">
        <div className="card border-accent/30 bg-accent/5 p-3 text-sm text-ink-200">
          {tmdbAvailable ? <>No catalog match for “{fallback}”.</> : <>TMDB isn’t configured.</>} Showing <b>raw torrent results</b> instead.
        </div>
        <TorrentSearch query={fallback} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-white">{query ? `Results for “${query}”` : 'Trending this week'}</h2>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {!tmdbAvailable && !query && (
        <div className="card p-4 text-sm text-ink-400">
          Add a TMDB API key in Settings (or <code>TMDB_API_KEY</code> on the server) for posters & metadata — or switch to <b>Direct Torrent</b> search.
        </div>
      )}
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-6">
        {loading && !items.length
          ? Array.from({ length: 12 }, (_, i) => <li key={i} className="aspect-[2/3] animate-pulse rounded-lg bg-ink-800" />)
          : items.map((it) => (
              <li key={`${it.type}-${it.id}`}>
                <button className="group block w-full text-left" onClick={() => setSelected(it)}>
                  <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-ink-800 ring-accent transition group-hover:ring-2 group-focus-visible:ring-2">
                    {it.posterPath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={posterUrl(it.posterPath, 'w342')} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
                    ) : (
                      <div className="grid h-full place-items-center text-ink-600">{it.type === 'series' ? <IconTv size={32} /> : <IconFilm size={32} />}</div>
                    )}
                    <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-200">{it.type === 'series' ? 'TV' : 'Movie'}</span>
                    {it.rating ? <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-accent"><IconStar size={10} />{it.rating.toFixed(1)}</span> : null}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs font-medium text-ink-200" dir="auto">{it.title}</p>
                  <p className="text-[11px] text-ink-400">{it.year ?? '—'}</p>
                </button>
              </li>
            ))}
      </ul>
    </div>
  );
}

function TitleDetail({ item, onBack }: { item: TmdbItem; onBack: () => void }) {
  const [details, setDetails] = useState<TmdbDetails>();
  const [season, setSeason] = useState<number>();
  const [episodes, setEpisodes] = useState<TmdbEpisode[]>([]);
  const [episode, setEpisode] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.tmdbDetails(item.type, item.id).then((d) => {
      setDetails(d);
      if (d.type === 'series') setSeason(d.seasons?.[0]?.seasonNumber ?? 1);
    }).catch((e) => setError(e.message));
  }, [item]);

  useEffect(() => {
    if (item.type !== 'series' || season == null) return;
    setEpisodes([]);
    setEpisode(undefined);
    api.tmdbSeason(item.id, season).then((r) => { setEpisodes(r.episodes); setEpisode(r.episodes[0]?.episodeNumber); }).catch((e) => setError(e.message));
  }, [item, season]);

  const d = details ?? item;
  const ready = !!details && (item.type === 'movie' || episode != null);

  const header = (
    <div className="space-y-4">
      <button className="btn-ghost -ml-2" onClick={onBack}><IconBack size={16} /> Back</button>
      <div className="relative overflow-hidden rounded-xl border border-ink-700">
        {d.backdropPath && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl(d.backdropPath, 'w500')} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />
        )}
        <div className="relative flex gap-4 bg-gradient-to-r from-ink-950 via-ink-950/80 to-transparent p-4">
          {d.posterPath && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterUrl(d.posterPath, 'w185')} alt="" className="hidden w-24 shrink-0 rounded-lg sm:block" />
          )}
          <div className="min-w-0 space-y-1">
            <h2 className="text-xl font-bold text-white" dir="auto">{d.title} <span className="font-normal text-ink-400">{d.year}</span></h2>
            <p className="text-xs text-ink-400">
              {details?.genres.join(' · ')}{details?.runtime ? ` · ${details.runtime} min` : ''}{details?.imdbId ? ` · ${details.imdbId}` : ''}
            </p>
            <p className="line-clamp-3 text-sm text-ink-200" dir="auto">{d.overview}</p>
          </div>
        </div>
      </div>

      {item.type === 'series' && details?.seasons && (
        <div className="space-y-2">
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
            {details.seasons.map((s) => (
              <button key={s.seasonNumber} onClick={() => setSeason(s.seasonNumber)}
                className={`pill shrink-0 ${season === s.seasonNumber ? 'border-accent bg-accent-soft text-accent' : 'border-ink-600 text-ink-400'}`}>
                Season {s.seasonNumber}
              </button>
            ))}
          </div>
          <select className="input" value={episode ?? ''} onChange={(e) => setEpisode(+e.target.value)} aria-label="Episode">
            {episodes.map((e) => <option key={e.episodeNumber} value={e.episodeNumber}>E{String(e.episodeNumber).padStart(2, '0')} · {e.name}</option>)}
          </select>
        </div>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {details && !details.imdbId && <p className="text-xs text-accent">No IMDB id on TMDB — falling back to a title search.</p>}
    </div>
  );

  if (!ready) return header;

  return (
    <TorrentSearch
      header={header}
      // No IMDB id → id-based indexers can't help; use the title as a raw query.
      query={details.imdbId ? undefined : `${details.title}${item.type === 'movie' && details.year ? ` ${details.year}` : season != null ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''}`}
      context={{ imdbId: details.imdbId, tmdbId: details.id, type: item.type, season: item.type === 'series' ? season : undefined, episode: item.type === 'series' ? episode : undefined, title: details.title, year: details.year }}
    />
  );
}
