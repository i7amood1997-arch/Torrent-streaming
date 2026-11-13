'use client';
/**
 * App shell — three layouts from one tree:
 *  - iPhone (<768px):   one view at a time, bottom tab bar, safe-area padding, mini "now playing" bar
 *  - iPad (768–1279px): dual pane — results list left, live player right
 *  - Desktop (≥1280px): sidebar nav + multi-column content + player pane; ⌘/Ctrl+K, Space, F
 *
 * All views stay mounted (hidden via CSS) so search state and playback survive tab switches.
 */
import { useEffect, useState } from 'react';
import { Catalog } from '@/components/catalog';
import { IconFilm, IconList, IconPlay, IconSettings, IconTv } from '@/components/icons';
import { SEARCH_INPUT_ID, SearchBar } from '@/components/search-bar';
import { SettingsPanel } from '@/components/settings-panel';
import { TorrentSearch } from '@/components/torrent-search';
import { VideoPlayer } from '@/components/VideoPlayer';
import { api } from '@/lib/client-api';
import { asset, BASE_PATH } from '@/lib/config';
import { formatBytes } from '@/lib/release-parser';
import { useApp, type View } from '@/lib/store';

const NAV: { id: View; label: string; icon: typeof IconFilm; mobileOnly?: boolean }[] = [
  { id: 'discover', label: 'Discover', icon: IconFilm },
  { id: 'search', label: 'Torrents', icon: IconList },
  { id: 'player', label: 'Player', icon: IconTv, mobileOnly: true },
  { id: 'settings', label: 'Settings', icon: IconSettings },
];

export default function Home() {
  const { view, listView, setView, setMode, mode, submittedQuery, nowPlaying, caps } = useApp();
  const apiBaseSetting = useApp((s) => s.settings.apiBase);
  const accessToken = useApp((s) => s.settings.accessToken);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    Promise.resolve(useApp.persist.rehydrate()).then(() => setHydrated(true));
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register(asset('/sw.js'), { scope: `${BASE_PATH}/` }).catch(() => undefined);
    }
  }, []);

  // (Re)probe the backend once settings are loaded and whenever its URL / token changes.
  useEffect(() => {
    if (hydrated) api.loadCaps();
  }, [hydrated, apiBaseSetting, accessToken]);

  // ⌘/Ctrl+K → Direct Torrent Search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMode('torrent');
        const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
        input?.focus();
        input?.select();
      } else if (e.key === 'Escape' && document.activeElement?.id === SEARCH_INPUT_ID) {
        (document.activeElement as HTMLElement).blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode]);

  const shown = (v: View) => (listView === v ? '' : 'hidden');
  const r = nowPlaying?.result;

  return (
    <div className="fixed inset-0 flex overflow-hidden pl-safe-l pr-safe-r">
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60 p-4 xl:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={asset('/icons/icon.svg')} alt="" className="h-8 w-8" />
          <span className="text-lg font-bold tracking-tight text-white">Streamdeck</span>
        </div>
        <nav className="space-y-1">
          {NAV.filter((n) => !n.mobileOnly).map((n) => (
            <button key={n.id} onClick={() => (n.id === 'search' ? setMode('torrent') : n.id === 'discover' ? setMode('catalog') : setView(n.id))}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${listView === n.id ? 'bg-accent-soft text-accent' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'}`}>
              <n.icon size={18} /> {n.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-2 text-[11px] text-ink-400">
          <p><kbd>⌘/Ctrl K</kbd> torrent search</p>
          <p><kbd>Space</kbd> pause · <kbd>F</kbd> fullscreen</p>
          <p><kbd>←/→</kbd> seek · <kbd>[ ]</kbd> sub delay</p>
        </div>
      </aside>

      {/* Main column (list pane on iPad/desktop) */}
      <main className={`${view === 'player' ? 'hidden md:flex' : 'flex'} min-w-0 flex-1 flex-col md:max-w-[50%] xl:max-w-none`}>
        <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-950/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
          <div className="mb-2 flex items-center justify-between xl:hidden">
            <span className="text-base font-bold tracking-tight text-white">Streamdeck</span>
            <nav className="hidden gap-1 md:flex">
              {NAV.filter((n) => !n.mobileOnly).map((n) => (
                <button key={n.id} onClick={() => (n.id === 'search' ? setMode('torrent') : n.id === 'discover' ? setMode('catalog') : setView(n.id))}
                  className={`btn px-2.5 py-1.5 text-xs ${listView === n.id ? 'bg-accent-soft text-accent' : 'text-ink-400'}`}>
                  <n.icon size={14} /> {n.label}
                </button>
              ))}
            </nav>
          </div>
          <SearchBar />
        </header>

        <div className="flex-1 overflow-y-auto px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-4 scrollbar-thin md:pb-6">
          {caps?.offline && listView !== 'settings' && (
            <div className="card mb-4 flex flex-wrap items-center gap-3 border-accent/40 bg-accent/5 p-3 text-sm">
              <p className="min-w-0 flex-1 text-ink-200">
                <b className="text-accent">Backend not reachable.</b> {caps.offline} Fix the URL in Settings, or clear it to use the app without a backend.
              </p>
              <button className="btn-primary" onClick={() => setView('settings')}>Set up</button>
            </div>
          )}
          <div className={shown('discover')}><Catalog active={listView === 'discover'} /></div>
          <div className={shown('search')}>
            {mode === 'torrent' && submittedQuery ? (
              <TorrentSearch query={submittedQuery} />
            ) : (
              <div className="card mx-auto mt-6 max-w-md space-y-2 p-6 text-sm text-ink-400">
                <h2 className="text-base font-semibold text-white">Direct Torrent Search</h2>
                <p>Search raw indexers (Jackett/Prowlarr Torznab, YTS, apibay…) by release name, e.g. <code className="text-ink-200">dune part two 2160p</code>.</p>
                <p>Or paste a magnet link / info-hash to stream instantly.</p>
              </div>
            )}
          </div>
          <div className={shown('settings')}><SettingsPanel /></div>
        </div>
      </main>

      {/* Player pane: full screen view on iPhone, right pane on iPad/desktop */}
      <section className={`${view === 'player' ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col bg-black md:flex md:border-l md:border-ink-800 md:bg-ink-950 md:p-4 xl:max-w-[44%]`}>
        <div className="md:sticky md:top-4">
          <VideoPlayer onBack={() => setView(listView)} />
          {nowPlaying && (
            <div className="space-y-1 p-4 text-sm md:px-0">
              <p className="font-semibold text-white" dir="auto">{nowPlaying.title}</p>
              {r && (
                <p className="break-all text-xs text-ink-400">
                  {r.quality !== 'Unknown' && `${r.quality} · `}{formatBytes(r.sizeBytes)} · {r.seeders} seeders{r.tracker ? ` · ${r.tracker}` : ''}{r.releaseGroup ? ` · ${r.releaseGroup}` : ''}
                </p>
              )}
              {r && <p className="break-all font-mono text-[10px] text-ink-600">{r.infoHash}</p>}
            </div>
          )}
        </div>
      </section>

      {/* iPhone: mini now-playing bar */}
      {nowPlaying && view !== 'player' && (
        <button onClick={() => setView('player')}
          className="absolute inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-800/95 p-2.5 text-left shadow-lg backdrop-blur md:hidden">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-ink-950"><IconPlay size={14} /></span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink-200">{nowPlaying.title}</span>
        </button>
      )}

      {/* iPhone: bottom tab bar */}
      <nav className="absolute inset-x-0 bottom-0 z-40 flex border-t border-ink-800 bg-ink-950/95 pb-safe-b backdrop-blur md:hidden" aria-label="Main">
        {NAV.map((n) => (
          <button key={n.id} onClick={() => (n.id === 'search' ? setMode('torrent') : n.id === 'discover' ? setMode('catalog') : setView(n.id))}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${view === n.id ? 'text-accent' : 'text-ink-400'}`}
            aria-current={view === n.id ? 'page' : undefined}>
            <n.icon size={22} /> {n.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
