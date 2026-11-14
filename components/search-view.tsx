'use client';
/**
 * Search: one field, two scopes — the catalog ("Movies & Shows") or every torrent
 * source ("Torrents"). Pasting a magnet, info-hash or video link plays it. With an
 * empty field, genre tiles open a browsable grid.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { parseMagnet } from '@/lib/magnet';
import { useApp } from '@/lib/store';
import type { TmdbItem } from '@/lib/types';
import { Poster } from './home';
import { IconBack, IconSearch, IconX } from './icons';
import { TorrentSearch } from './torrent-search';
import { Segmented } from './ui';

export const SEARCH_INPUT_ID = 'main-search';

/** Try to treat raw input as something directly playable. Returns true if handled. */
export function tryDirectPlay(input: string): boolean {
  const text = input.trim();
  const { play } = useApp.getState();
  const m = parseMagnet(text);
  if (m) {
    const title = m.name ?? `Magnet ${m.infoHash.slice(0, 8)}…`;
    play({
      kind: 'torrent',
      title,
      result: {
        id: m.infoHash, infoHash: m.infoHash, magnet: m.magnet, title, seeders: 0, leechers: 0, indexer: 'magnet',
        quality: 'Unknown', hdr: [], remux: false, audio: [],
      },
    });
    return true;
  }
  if (/^https?:\/\/\S+\.(m3u8|mp4|m4v|webm|mov|mkv)(\?\S*)?$/i.test(text)) {
    play({ kind: 'url', url: text, title: decodeURIComponent(text.split('/').pop()!.split('?')[0]) });
    return true;
  }
  return false;
}

const TILES: { label: string; type: 'movie' | 'series'; genre: string; colors: string }[] = [
  { label: 'Action', type: 'movie', genre: 'Action', colors: 'from-[#ff453a] to-[#7a1009]' },
  { label: 'Comedy', type: 'movie', genre: 'Comedy', colors: 'from-[#ffd60a] to-[#a35a00]' },
  { label: 'Drama', type: 'series', genre: 'Drama', colors: 'from-[#5e5ce6] to-[#1d1b6b]' },
  { label: 'Sci-Fi', type: 'movie', genre: 'Sci-Fi', colors: 'from-[#64d2ff] to-[#0a4a75]' },
  { label: 'Crime', type: 'series', genre: 'Crime', colors: 'from-[#8e8e93] to-[#1c1c1e]' },
  { label: 'Animation', type: 'series', genre: 'Animation', colors: 'from-[#ff9f0a] to-[#b02a5b]' },
  { label: 'Horror', type: 'movie', genre: 'Horror', colors: 'from-[#bf5af2] to-[#2a0845]' },
  { label: 'Family', type: 'movie', genre: 'Family', colors: 'from-[#30d158] to-[#0b5a3c]' },
  { label: 'Romance', type: 'movie', genre: 'Romance', colors: 'from-[#ff375f] to-[#6b0f3a]' },
  { label: 'Documentary', type: 'movie', genre: 'Documentary', colors: 'from-[#66d4cf] to-[#134e4a]' },
];

const GRID = 'grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9 md:gap-x-4';

function PosterGrid({ items, loading }: { items: TmdbItem[]; loading: boolean }) {
  if (loading && !items.length) return <div className={GRID}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-ink-900" />)}</div>;
  return <div className={GRID}>{items.map((it) => <Poster key={`${it.type}-${it.id}`} item={it} wide />)}</div>;
}

export function SearchView({ active }: { active: boolean }) {
  const { mode, setMode, query, setQuery, submit, submittedQuery } = useApp();
  const [items, setItems] = useState<TmdbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [browse, setBrowse] = useState<(typeof TILES)[number]>();

  const q = submittedQuery;
  useEffect(() => {
    if (!active || mode !== 'catalog' || (!q && !browse)) { if (!q && !browse) setItems([]); return; }
    const ac = new AbortController();
    setLoading(true); setError(undefined); setItems([]);
    (q ? api.tmdbSearch(q, ac.signal) : api.shelf(browse!.type, browse!.genre, ac.signal))
      .then(({ results }) => setItems(results))
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [active, mode, q, browse]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tryDirectPlay(query)) { setQuery(''); return; }
    setBrowse(undefined);
    submit();
    (document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null)?.blur();
  };
  const clear = () => { setQuery(''); submit(''); };

  return (
    <div className="gutter mx-auto max-w-[1600px] space-y-5 pb-12 pt-[max(1.25rem,env(safe-area-inset-top))] md:pt-24">
      <h1 className="text-[34px] font-extrabold tracking-tight text-white md:hidden">Search</h1>
      <form onSubmit={onSubmit} className="relative mx-auto md:max-w-2xl" role="search">
        <IconSearch size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          id={SEARCH_INPUT_ID}
          className="h-12 w-full rounded-2xl border-0 bg-ink-800 pl-11 pr-11 text-[17px] text-white placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-white/40"
          type="search" enterKeyHint="search" autoComplete="off" autoCorrect="off" spellCheck={false}
          placeholder={mode === 'catalog' ? 'Movies, shows and more' : 'Torrent name, or paste a magnet'}
          aria-label={mode === 'catalog' ? 'Search movies and shows' : 'Search torrents, or paste a magnet link'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPaste={(e) => { const text = e.clipboardData.getData('text'); if (parseMagnet(text)) { e.preventDefault(); tryDirectPlay(text); } }}
        />
        {query && <button type="button" className="absolute right-3 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full bg-ink-600 text-ink-200" onClick={clear} aria-label="Clear search"><IconX size={12} /></button>}
      </form>
      <div className="flex justify-center">
        <Segmented label="Search in" value={mode} onChange={(m) => { setMode(m); if (query.trim()) submit(); }}
          options={[{ value: 'catalog', label: 'Movies & Shows' }, { value: 'torrent', label: 'Torrents' }]} />
      </div>

      {mode === 'torrent' ? (
        q ? <TorrentSearch query={q} /> : (
          <div className="mx-auto max-w-md space-y-4 pt-4 text-center text-sm text-ink-400">
            <p>Search every torrent source by release name, or paste a <b className="text-ink-200">magnet</b> or <b className="text-ink-200">video link</b> to play it straight away.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {['dune part two 2160p', 'the bear s03e01', 'frieren 1080p'].map((x) => (
                <button key={x} className="rounded-full bg-ink-800 px-3.5 py-1.5 text-ink-200 hover:bg-ink-700" onClick={() => submit(x)}>{x}</button>
              ))}
            </div>
          </div>
        )
      ) : q || browse ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {browse && !q && <button className="grid h-8 w-8 place-items-center rounded-full bg-ink-800 text-white" onClick={() => setBrowse(undefined)} aria-label="Back to categories"><IconBack size={16} /></button>}
            <h2 className="text-xl font-bold tracking-tight text-white">{q ? <>Results for “{q}”</> : browse!.label}</h2>
          </div>
          {error && <p className="text-sm text-ink-400">Couldn’t search the catalog ({error}).</p>}
          <PosterGrid items={items} loading={loading} />
          {!loading && !items.length && q && (
            <div className="space-y-3 text-sm text-ink-400">
              <p>Nothing in the catalog for “{q}”.</p>
              <button className="btn-glass rounded-full px-4" onClick={() => { setMode('torrent'); submit(); }}>Search torrents instead</button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <h2 className="text-xl font-bold tracking-tight text-white">Browse</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {TILES.map((t) => (
              <button key={t.label} onClick={() => setBrowse(t)}
                className={`group relative h-24 overflow-hidden rounded-2xl bg-gradient-to-br ${t.colors} p-3.5 text-left transition active:scale-[0.97] md:h-28`}>
                <span className="text-lg font-bold tracking-tight text-white drop-shadow">{t.label}</span>
                <span className="absolute -bottom-6 -right-3 text-[5.5rem] font-black leading-none text-white/10 transition group-hover:text-white/20" aria-hidden>{t.label[0]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
