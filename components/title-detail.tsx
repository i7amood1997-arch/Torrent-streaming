'use client';
/**
 * Title page: backdrop, one Play button (starts the best stream found), seasons and
 * episodes for shows, and every stream underneath for those who want to choose.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { formatBytes } from '@/lib/release-parser';
import { useApp } from '@/lib/store';
import { posterUrl } from '@/lib/tmdb';
import type { TmdbDetails, TmdbEpisode, TmdbItem, TorrentResult } from '@/lib/types';
import { Shelf } from './home';
import { IconBack, IconPlay, IconStar } from './icons';
import { TorrentSearch } from './torrent-search';

interface StreamState { best?: TorrentResult; play: (r: TorrentResult) => void; loading: boolean; count: number }

export function TitleDetail({ item }: { item: TmdbItem }) {
  const onBack = useApp((s) => s.closeDetail);
  const [details, setDetails] = useState<TmdbDetails>();
  const [season, setSeason] = useState<number>();
  const [episodes, setEpisodes] = useState<TmdbEpisode[]>([]);
  const [episode, setEpisode] = useState<number>();
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);

  useEffect(() => {
    setDetails(undefined); setSeason(undefined); setEpisodes([]); setEpisode(undefined); setError(undefined); setMore(false);
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
  const series = item.type === 'series';
  const ready = !!details && (!series || episode != null);
  const tag = series && season != null && episode != null ? `S${season} · E${episode}` : '';
  const ep = episodes.find((e) => e.episodeNumber === episode);

  const top = (stream?: StreamState) => (
    <div className="space-y-7">
      <section className="relative -mx-[var(--gutter)] min-h-[62vh] overflow-hidden md:min-h-[min(72vh,64vw)]">
        {(d.backdropPath || d.posterPath) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl(d.backdropPath ?? d.posterPath, 'original')} alt="" className="fade absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/10" />
        <div className="absolute inset-0 hidden bg-gradient-to-r from-black/75 via-black/10 to-transparent md:block" />
        <button className="glass absolute left-[var(--gutter)] top-[max(1rem,env(safe-area-inset-top))] z-10 grid h-10 w-10 place-items-center rounded-full text-white md:top-20" onClick={onBack} aria-label="Back"><IconBack size={20} /></button>
        <div className="gutter rise absolute inset-x-0 bottom-0 flex flex-col items-center pb-6 text-center md:items-start md:pb-10 md:text-left">
          <h1 className="max-w-3xl text-balance text-4xl font-extrabold leading-[1.03] tracking-tight text-white drop-shadow-lg md:text-6xl xl:max-w-4xl xl:text-7xl" dir="auto">{d.title}</h1>
          <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-[13px] font-medium text-white/70 md:justify-start">
            {[details?.genres.slice(0, 2).join(' · '), d.year, details?.runtime ? `${details.runtime} min` : ''].filter(Boolean).join(' · ')}
            {d.rating ? <span className="inline-flex items-center gap-1 text-white/90"><IconStar size={12} />{d.rating.toFixed(1)}</span> : null}
          </p>
          <div className="mt-5 w-full max-w-sm">
            <button className="btn-primary h-[52px] w-full rounded-2xl text-[17px] disabled:bg-white/25 disabled:text-white/70 disabled:opacity-100" disabled={!stream?.best}
              onClick={() => stream?.best && stream.play(stream.best)}>
              {stream?.best ? <><IconPlay size={18} /> Play{tag ? ` ${tag}` : ''}</> : !ready || !stream || stream.loading ? <span className="animate-pulse">Finding streams…</span> : 'No streams found'}
            </button>
            {stream?.best && (
              <p className="mt-2 text-[11px] text-white/55">
                {[stream.best.quality !== 'Unknown' ? stream.best.quality : '', formatBytes(stream.best.sizeBytes), stream.best.url ? 'direct link' : `${stream.best.seeders} seeders`].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
        </div>
      </section>

      {(ep?.overview || d.overview) && (
        <button className="block max-w-3xl text-left" onClick={() => setMore((m) => !m)}>
          {ep?.name && series && <p className="mb-1 text-[13px] font-semibold text-white">{tag} · {ep.name}</p>}
          <p className={`text-[15px] leading-relaxed text-ink-200/90 ${more ? '' : 'line-clamp-3'}`} dir="auto">{ep?.overview || d.overview}</p>
        </button>
      )}

      {series && details?.seasons && (
        <section className="-mx-[var(--gutter)] space-y-3">
          <Shelf className="!gap-2 !py-0">
            {details.seasons.map((s) => (
              <button key={s.seasonNumber} onClick={() => setSeason(s.seasonNumber)}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${season === s.seasonNumber ? 'bg-white text-black' : 'bg-ink-800 text-ink-200 hover:bg-ink-700'}`}>
                Season {s.seasonNumber}
              </button>
            ))}
          </Shelf>
          <Shelf>
            {!episodes.length && Array.from({ length: 4 }, (_, i) => <div key={i} className="aspect-video w-56 animate-pulse rounded-xl bg-ink-900 md:w-64" />)}
            {episodes.map((e) => {
              const on = episode === e.episodeNumber;
              return (
                <button key={e.episodeNumber} onClick={() => setEpisode(e.episodeNumber)} className="group rounded-xl text-left outline-none w-56 md:w-64 xl:w-72" aria-pressed={on}>
                  <span className={`lift relative block aspect-video overflow-hidden rounded-xl bg-gradient-to-br from-ink-700 to-ink-900 ${on ? 'ring-[3px] ring-white' : 'group-focus-visible:ring-[3px] group-focus-visible:ring-white/60'}`}>
                    {e.stillPath && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={posterUrl(e.stillPath, 'w342')} alt="" loading="lazy" className="h-full w-full object-cover" onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />
                    )}
                    <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent" />
                    <span className="absolute bottom-2 left-3 text-[11px] font-bold uppercase tracking-wider text-white/85">Episode {e.episodeNumber}</span>
                  </span>
                  <span className={`mt-2 block truncate text-[13px] font-medium ${on ? 'text-white' : 'text-ink-200'}`} dir="auto">{e.name}</span>
                </button>
              );
            })}
          </Shelf>
        </section>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {ready && <h2 className="text-xl font-bold tracking-tight text-white">All Streams{stream?.count ? <span className="ml-2 text-sm font-medium text-ink-400">{stream.count}</span> : null}</h2>}
    </div>
  );

  return (
    <div className="gutter pb-12">
      {!ready || !details ? top() : (
        <TorrentSearch
          renderHeader={top}
          // No IMDB id → id-based sources can't help; use the title as a text query.
          query={details.imdbId ? undefined : `${details.title}${!series && details.year ? ` ${details.year}` : season != null ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''}`}
          context={{ imdbId: details.imdbId, tmdbId: details.source === 'tmdb' ? details.id : undefined, type: item.type, season: series ? season : undefined, episode: series ? episode : undefined, title: details.title, year: details.year, poster: d.posterPath ?? undefined, backdrop: (series && ep?.stillPath) || d.backdropPath || undefined }}
        />
      )}
    </div>
  );
}
