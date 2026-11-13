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
import { useApp, type View } from '@/lib/store';

const TITLES: Record<Exclude<View, 'player'>, string> = { discover: 'Discover', search: 'Torrents', settings: 'Settings' };

const NAV: { id: View; label: string; icon: typeof IconFilm; mobileOnly?: boolean }[] = [
  { id: 'discover', label: 'Discover', icon: IconFilm },
  { id: 'search', label: 'Torrents', icon: IconList },
  { id: 'player', label: 'Player', icon: IconTv, mobileOnly: true },
  { id: 'settings', label: 'Settings', icon: IconSettings },
];

export default function Home() {
  const { view, listView, setView, setMode, mode, submittedQuery, submit, nowPlaying, caps } = useApp();
  const go = (id: View) => (id === 'search' ? setMode('torrent') : id === 'discover' ? setMode('catalog') : setView(id));
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
            <button key={n.id} onClick={() => go(n.id)}
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
        <header className="sticky top-0 z-30 bg-ink-950/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">{TITLES[listView]}</h1>
            <nav className="hidden gap-1 md:flex xl:hidden">
              {NAV.filter((n) => !n.mobileOnly).map((n) => (
                <button key={n.id} onClick={() => go(n.id)} aria-label={n.label}
                  className={`grid h-9 w-9 place-items-center rounded-lg ${listView === n.id ? 'bg-accent-soft text-accent' : 'text-ink-400 hover:bg-ink-800'}`}>
                  <n.icon size={18} />
                </button>
              ))}
            </nav>
          </div>
          {listView !== 'settings' && <SearchBar />}
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
              <div className="mx-auto mt-4 max-w-md space-y-4 text-sm text-ink-400">
                <p>Search every torrent source by name. Add a quality or season to narrow it down:</p>
                <div className="flex flex-wrap gap-2">
                  {['dune part two 2160p', 'the bear s03e01', 'frieren 1080p', 'oppenheimer'].map((q) => (
                    <button key={q} className="rounded-full bg-ink-800 px-3 py-1.5 text-ink-200 hover:bg-ink-700" onClick={() => submit(q)}>{q}</button>
                  ))}
                </div>
                <p>You can also paste a <b className="text-ink-200">magnet link</b> or a <b className="text-ink-200">video link</b> into the search box to play it straight away.</p>
              </div>
            )}
          </div>
          <div className={shown('settings')}><SettingsPanel /></div>
        </div>
      </main>

      {/* Player pane: its own screen on iPhone, right pane on iPad/desktop */}
      <section className={`${view === 'player' ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col overflow-y-auto bg-ink-950 pb-[calc(4.5rem+env(safe-area-inset-bottom))] scrollbar-thin md:flex md:border-l md:border-ink-800 md:px-5 md:pb-6 xl:max-w-[44%]`}>
        <VideoPlayer onBack={() => setView(listView)} />
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
          <button key={n.id} onClick={() => go(n.id)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${view === n.id ? 'text-accent' : 'text-ink-400'}`}
            aria-current={view === n.id ? 'page' : undefined}>
            <n.icon size={22} /> {n.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
