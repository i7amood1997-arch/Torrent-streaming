'use client';
/**
 * App shell. One full-screen view at a time on every device, on a black canvas:
 *  Home (featured title + shelves) · Search · Settings, a title page that opens over
 * them, and the player. Navigation is a floating glass bar: bottom on phones, top on
 * iPad/desktop. Views stay mounted so scroll position, search and playback survive.
 */
import { useEffect, useState } from 'react';
import { Home } from '@/components/home';
import { IconGearFill, IconHomeFill, IconPlay, IconSearch } from '@/components/icons';
import { SEARCH_INPUT_ID, SearchView } from '@/components/search-view';
import { SettingsPanel } from '@/components/settings-panel';
import { TitleDetail } from '@/components/title-detail';
import { VideoPlayer } from '@/components/VideoPlayer';
import { api } from '@/lib/client-api';
import { asset, BASE_PATH } from '@/lib/config';
import { useApp, type View } from '@/lib/store';
import { initialFocus, isTV, onTvBack, popFocus, pushFocus, startTvMode } from '@/lib/tv';

/** The tabs in the floating bar; Search sits apart in its own glass circle, as on Apple TV. */
const NAV: { id: Exclude<View, 'player' | 'search'>; label: string; icon: typeof IconHomeFill }[] = [
  { id: 'discover', label: 'Home', icon: IconHomeFill },
  { id: 'settings', label: 'Settings', icon: IconGearFill },
];

export default function App() {
  const { view, listView, setView, nowPlaying, detail } = useApp();
  const apiBaseSetting = useApp((s) => s.settings.apiBase);
  const accessToken = useApp((s) => s.settings.accessToken);
  const [hydrated, setHydrated] = useState(false);

  // Android TV app: remote-control navigation, and Back walks back through the app before leaving it.
  useEffect(() => {
    startTvMode();
    if (!isTV()) return;
    // Remember the poster/button that opened a title or the player, to return to it.
    const unsub = useApp.subscribe((s, prev) => {
      if ((s.detail && s.detail !== prev.detail) || (s.view === 'player' && prev.view !== 'player')) pushFocus();
    });
    const off = onTvBack(() => {
      const s = useApp.getState();
      if (s.view === 'player') { s.setView(s.listView); popFocus(); return true; }
      if (s.detail) { s.closeDetail(); popFocus(); return true; }
      if (s.listView !== 'discover') { s.setView('discover'); setTimeout(() => initialFocus('[data-tv-start]', true), 80); return true; }
      return false;
    }, -1);
    return () => { unsub(); off(); };
  }, []);

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

  // ⌘/Ctrl+K → Search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('search');
        setTimeout(() => { const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null; input?.focus(); input?.select(); }, 30);
      } else if (e.key === 'Escape') {
        const el = document.activeElement as HTMLElement | null;
        if (el?.closest('input, textarea, select')) { el.blur(); return; }
        const s = useApp.getState();
        if (document.fullscreenElement) return; // the browser leaves fullscreen first
        if (s.view === 'player') s.setView(s.listView);
        else if (s.detail) s.closeDetail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView]);

  const inPlayer = view === 'player';
  // Phones: room for the bottom bar, plus the now-playing bar when it shows.
  const padBottom = nowPlaying ? 'pb-[calc(9.5rem+env(safe-area-inset-bottom))]' : 'pb-[calc(5.5rem+env(safe-area-inset-bottom))]';
  const pane = (v: View) => `absolute inset-0 overflow-y-auto overscroll-contain scrollbar-thin ${padBottom} md:pb-8 ${!inPlayer && !detail && listView === v ? '' : 'hidden'}`;
  const paneOn = (v: View) => (!inPlayer && !detail && listView === v ? '' : undefined);
  const nowLabel = nowPlaying ? `${nowPlaying.title}${nowPlaying.season != null ? ` · S${nowPlaying.season} E${nowPlaying.episode}` : ''}` : '';

  return (
    <div className="fixed inset-0 overflow-hidden bg-black pl-safe-l pr-safe-r">
      <main className="absolute inset-0">
        <div className={pane('discover')} data-tv-pane={paneOn('discover')}><Home active={listView === 'discover'} /></div>
        <div className={pane('search')} data-tv-pane={paneOn('search')}><SearchView active={listView === 'search'} /></div>
        <div className={pane('settings')} data-tv-pane={paneOn('settings')}>
          <div className="gutter mx-auto max-w-2xl pt-[max(1.25rem,env(safe-area-inset-top))] md:pt-24">
            <h1 className="mb-6 text-[34px] font-extrabold tracking-tight text-white">Settings</h1>
            <SettingsPanel />
          </div>
        </div>
        {detail && (
          <div key={`${detail.type}-${detail.id}`} data-tv-pane={inPlayer ? undefined : ''} className={`fade absolute inset-0 overflow-y-auto overscroll-contain bg-black scrollbar-thin ${padBottom} md:pb-8 ${inPlayer ? 'hidden' : ''}`}>
            <TitleDetail item={detail} />
          </div>
        )}
      </main>

      {/* Player: its own screen */}
      <section className={`absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-black scrollbar-thin ${inPlayer ? '' : 'hidden'}`}>
        <VideoPlayer onBack={() => setView(listView)} />
      </section>

      {/* Navigation: floating glass bar (top on iPad/desktop, bottom on phones) */}
      {!inPlayer && (
        <>
          {/* Keeps scrolled content from showing through behind the floating bar */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 hidden h-24 bg-gradient-to-b from-black/50 via-black/20 to-transparent md:block" />
          <div data-tv-nav className="absolute left-1/2 top-4 z-40 hidden -translate-x-1/2 items-center gap-3 md:flex">
            <nav className="glass flex items-center gap-1 rounded-full p-1.5" aria-label="Main">
              {NAV.map((n) => {
                const on = listView === n.id && !detail;
                return (
                  <button key={n.id} onClick={() => setView(n.id)} aria-current={on ? 'page' : undefined}
                    className={`rounded-full px-5 py-2 text-[15px] font-semibold transition ${on ? 'glass-selected' : 'text-white hover:bg-white/5'}`}>
                    {n.label}
                  </button>
                );
              })}
              {nowPlaying && (
                <button onClick={() => setView('player')} className="ml-1 flex max-w-[16rem] items-center gap-2 rounded-full py-2 pl-3 pr-4 text-[13px] font-semibold text-white hover:bg-white/5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-black"><IconPlay size={10} /></span>
                  <span className="truncate">{nowLabel}</span>
                </button>
              )}
            </nav>
            <button onClick={() => setView('search')} aria-label="Search" aria-current={listView === 'search' && !detail ? 'page' : undefined}
              className={`glass grid h-[3.25rem] w-[3.25rem] place-items-center rounded-full transition ${listView === 'search' && !detail ? 'text-[#4ba3ff]' : 'text-white'}`}>
              <IconSearch size={22} strokeWidth={2.6} />
            </button>
          </div>

          <div className="absolute inset-x-3 bottom-[max(0.6rem,env(safe-area-inset-bottom))] z-40 space-y-2 md:hidden">
            {nowPlaying && (
              <button onClick={() => setView('player')} className="glass flex w-full items-center gap-3 rounded-2xl p-2 pr-4 text-left">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-black"><IconPlay size={14} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">{nowPlaying.title}</span>
                  <span className="block text-[11px] text-white/60">{nowPlaying.season != null ? `Season ${nowPlaying.season} · Episode ${nowPlaying.episode}` : 'Now playing'}</span>
                </span>
              </button>
            )}
            <div data-tv-nav className="flex items-center gap-2.5">
              <nav className="glass flex flex-1 rounded-full p-1.5" aria-label="Main">
                {NAV.map((n) => {
                  const on = listView === n.id;
                  return (
                    <button key={n.id} onClick={() => setView(n.id)} aria-current={on ? 'page' : undefined}
                      className={`flex flex-1 flex-col items-center gap-0.5 rounded-full py-2 text-[11px] font-semibold transition ${on ? 'glass-selected' : 'text-white'}`}>
                      <n.icon size={26} /> {n.label}
                    </button>
                  );
                })}
              </nav>
              <button onClick={() => setView('search')} aria-label="Search" aria-current={listView === 'search' ? 'page' : undefined}
                className={`glass grid h-[4.25rem] w-[4.25rem] shrink-0 place-items-center rounded-full transition ${listView === 'search' ? 'text-[#4ba3ff]' : 'text-white'}`}>
                <IconSearch size={26} strokeWidth={2.6} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
