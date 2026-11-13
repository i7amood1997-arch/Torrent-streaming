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
import { IconBack, IconStar } from './icons';
import { Segmented } from './ui';
import { TorrentSearch } from './torrent-search';

export function Catalog({ active }: { active: boolean }) {
  const submitted = useApp((s) => s.submittedQuery);
  const mode = useApp((s) => s.mode);
  const caps = useApp((s) => s.caps);
  const userKey = useApp((s) => s.settings.tmdbKey);
  // Without a TMDB key the backend uses the keyless Cinemeta catalog, so the catalog is always available.
  const tmdbAvailable = !!caps && !caps.offline;
  void userKey;
  const query = mode === 'catalog' ? submitted : '';

  const [items, setItems] = useState<TmdbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<TmdbItem>();
  const [fallback, setFallback] = useState<string>();
  const [kind, setKind] = useState<'all' | 'movie' | 'series'>('all');

  useEffect(() => {
    if (!active || !caps || caps.offline) return;
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
        <p className="rounded-xl bg-accent/10 px-3 py-2 text-sm text-ink-200">
          Nothing in the catalog for “{fallback}”, so here are <b>torrent results</b> instead.
        </p>
        <TorrentSearch query={fallback} />
      </div>
    );
  }

  const shownItems = items.filter((i) => kind === 'all' || i.type === kind);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">{query ? <>Results for “{query}”</> : 'Trending this week'}</h2>
        <Segmented label="Show" size="sm" value={kind} onChange={setKind}
          options={[{ value: 'all', label: 'All' }, { value: 'movie', label: 'Movies' }, { value: 'series', label: 'Shows' }]} />
      </div>
      {error && (
        <div className="rounded-2xl bg-ink-900 p-4 text-sm ring-1 ring-ink-700/70">
          <p className="text-ink-200">The catalog didn’t load.</p>
          <p className="mt-1 text-xs text-ink-400">{error}</p>
        </div>
      )}
      <ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {loading && !items.length
          ? Array.from({ length: 12 }, (_, i) => <li key={i}><div className="aspect-[2/3] animate-pulse rounded-xl bg-ink-800" /><div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-ink-800" /></li>)
          : shownItems.map((it) => (
              <li key={`${it.type}-${it.id}`}>
                <button className="group block w-full text-left" onClick={() => setSelected(it)}>
                  <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/5 transition group-hover:ring-2 group-hover:ring-accent group-focus-visible:ring-2 group-focus-visible:ring-accent">
                    {it.posterPath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={posterUrl(it.posterPath, 'w342')} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
                    ) : (
                      <div className="grid h-full place-items-center p-2 text-center text-xs text-ink-400">{it.title}</div>
                    )}
                    {it.rating ? (
                      <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur"><IconStar size={10} />{it.rating.toFixed(1)}</span>
                    ) : null}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-ink-200" dir="auto">{it.title}</p>
                  <p className="mt-0.5 text-[11px] text-ink-400">{[it.year, it.type === 'series' ? 'Series' : 'Movie'].filter(Boolean).join(' · ')}</p>
                </button>
              </li>
            ))}
      </ul>
      {!loading && !error && !shownItems.length && items.length > 0 && <p className="text-sm text-ink-400">Nothing here in this category.</p>}
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

  const [more, setMore] = useState(false);
  const header = (
    <div className="space-y-5">
      <div className="relative -mx-4 -mt-4 md:mx-0 md:mt-0 md:overflow-hidden md:rounded-2xl">
        <div className="relative h-52 bg-ink-900 sm:h-64">
          {(d.backdropPath || d.posterPath) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterUrl(d.backdropPath ?? d.posterPath, 'w500')} alt="" className="h-full w-full object-cover opacity-60" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/40 to-transparent" />
          <button className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur" onClick={onBack} aria-label="Back"><IconBack size={20} /></button>
        </div>
        <div className="relative -mt-24 flex items-end gap-4 px-4">
          {d.posterPath && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterUrl(d.posterPath, 'w185')} alt="" className="w-24 shrink-0 rounded-xl shadow-2xl ring-1 ring-white/10 sm:w-28" />
          )}
          <div className="min-w-0 space-y-1 pb-1">
            <h2 className="text-xl font-bold leading-tight text-white sm:text-2xl" dir="auto">{d.title}</h2>
            <p className="text-xs text-ink-400">
              {[d.year, details?.runtime ? `${details.runtime} min` : '', item.type === 'series' ? 'Series' : 'Movie'].filter(Boolean).join(' · ')}
              {d.rating ? <span className="ml-2 inline-flex items-center gap-0.5 text-accent"><IconStar size={11} />{d.rating.toFixed(1)}</span> : null}
            </p>
            {!!details?.genres.length && <p className="text-xs text-ink-400">{details.genres.slice(0, 3).join(' · ')}</p>}
          </div>
        </div>
      </div>

      {d.overview && (
        <button className="block text-left" onClick={() => setMore((m) => !m)}>
          <p className={`text-sm leading-relaxed text-ink-200 ${more ? '' : 'line-clamp-3'}`} dir="auto">{d.overview}</p>
        </button>
      )}

      {item.type === 'series' && details?.seasons && (
        <div className="space-y-3">
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin max-md:-mx-4 max-md:px-4">
            {details.seasons.map((s) => (
              <button key={s.seasonNumber} onClick={() => setSeason(s.seasonNumber)}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${season === s.seasonNumber ? 'bg-white text-ink-950' : 'bg-ink-800 text-ink-200 hover:bg-ink-700'}`}>
                Season {s.seasonNumber}
              </button>
            ))}
          </div>
          <div className="flex snap-x gap-2 overflow-x-auto pb-1 scrollbar-thin max-md:-mx-4 max-md:px-4">
            {!episodes.length && Array.from({ length: 4 }, (_, i) => <div key={i} className="h-[72px] w-40 shrink-0 animate-pulse rounded-xl bg-ink-800" />)}
            {episodes.map((e) => (
              <button key={e.episodeNumber} onClick={() => setEpisode(e.episodeNumber)}
                className={`w-40 shrink-0 snap-start rounded-xl p-3 text-left transition ${episode === e.episodeNumber ? 'bg-accent/15 ring-1 ring-accent' : 'bg-ink-900 ring-1 ring-ink-700/70 hover:bg-ink-800'}`}>
                <span className={`block text-xs font-semibold ${episode === e.episodeNumber ? 'text-accent' : 'text-ink-400'}`}>Episode {e.episodeNumber}</span>
                <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-ink-200" dir="auto">{e.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {details && !details.imdbId && <p className="text-xs text-accent">No IMDB id for this title, so streams are found by name.</p>}
      {ready && <h3 className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Streams{item.type === 'series' && season != null && episode != null ? ` · S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''}</h3>}
    </div>
  );

  if (!ready) return header;

  return (
    <TorrentSearch
      header={header}
      // No IMDB id → id-based indexers can't help; use the title as a raw query.
      query={details.imdbId ? undefined : `${details.title}${item.type === 'movie' && details.year ? ` ${details.year}` : season != null ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''}`}
      context={{ imdbId: details.imdbId, tmdbId: details.source === 'tmdb' ? details.id : undefined, type: item.type, season: item.type === 'series' ? season : undefined, episode: item.type === 'series' ? episode : undefined, title: details.title, year: details.year }}
    />
  );
}
