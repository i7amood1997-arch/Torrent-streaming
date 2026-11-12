'use client';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DebridProvider, MediaType, TorrentResult } from './types';

export type View = 'discover' | 'search' | 'player' | 'settings';
export type SearchMode = 'catalog' | 'torrent';
export type EnginePref = 'auto' | 'debrid' | 'webtorrent';

export interface SubtitleStyle {
  scale: number; // 0.6 – 2
  bgOpacity: number; // 0 – 1
  color: string;
  arabicFont: 'Cairo' | 'Tajawal';
  position: number; // % from bottom, 4–40
  primaryLang: 'ar' | 'en';
  dual: boolean; // render secondary language too
}

export interface Settings {
  /** API backend (Cloudflare Worker) URL; empty = build-time default. */
  apiBase: string;
  /** Shared secret if the backend sets ACCESS_TOKEN. */
  accessToken: string;
  tmdbKey: string;
  debridProvider: DebridProvider;
  debridKeys: Record<DebridProvider, string>;
  openSubtitlesKey: string;
  subdlKey: string;
  torznabUrl: string;
  torznabKey: string;
  engine: EnginePref;
  subtitle: SubtitleStyle;
}

/** What the player is asked to play, plus metadata context for subtitles. */
export interface PlayRequest {
  kind: 'torrent' | 'url';
  result?: TorrentResult;
  url?: string;
  title: string;
  imdbId?: string;
  tmdbId?: number;
  type?: MediaType;
  season?: number;
  episode?: number;
  /** Bumps on every request so re-playing the same item restarts it. */
  nonce: number;
}

export interface ServerCaps {
  tmdb: boolean;
  debrid: Record<DebridProvider, boolean>;
  subtitles: { opensubtitles: boolean; subdl: boolean };
  indexers: string[];
  clientTorznab: boolean;
  accessToken?: boolean;
  /** Set when the backend could not be reached or rejected us. */
  offline?: string;
}

interface AppState {
  view: View;
  /** Last non-player view — shown in the left pane on iPad/desktop while playing. */
  listView: Exclude<View, 'player'>;
  mode: SearchMode;
  query: string;
  submittedQuery: string;
  nowPlaying?: PlayRequest;
  settings: Settings;
  caps?: ServerCaps;
  setView: (v: View) => void;
  setMode: (m: SearchMode) => void;
  setQuery: (q: string) => void;
  submit: (q?: string) => void;
  play: (r: Omit<PlayRequest, 'nonce'>) => void;
  updateSettings: (p: Partial<Settings>) => void;
  updateSubtitleStyle: (p: Partial<SubtitleStyle>) => void;
  setCaps: (c: ServerCaps) => void;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: '',
  accessToken: '',
  tmdbKey: '',
  debridProvider: 'realdebrid',
  debridKeys: { realdebrid: '', torbox: '', debridlink: '' },
  openSubtitlesKey: '',
  subdlKey: '',
  torznabUrl: '',
  torznabKey: '',
  engine: 'auto',
  subtitle: { scale: 1, bgOpacity: 0.55, color: '#ffffff', arabicFont: 'Cairo', position: 8, primaryLang: 'ar', dual: true },
};

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      view: 'discover',
      listView: 'discover',
      mode: 'catalog',
      query: '',
      submittedQuery: '',
      settings: DEFAULT_SETTINGS,
      setView: (view) => set(view === 'player' ? { view } : { view, listView: view }),
      setMode: (mode) => { const v = mode === 'torrent' ? 'search' : 'discover'; set({ mode, view: v, listView: v }); },
      setQuery: (query) => set({ query }),
      submit: (q) => {
        const query = (q ?? get().query).trim();
        const v = get().mode === 'torrent' ? 'search' : 'discover';
        set({ query, submittedQuery: query, view: v, listView: v });
      },
      play: (r) => set({ nowPlaying: { ...r, nonce: Date.now() }, view: 'player' }),
      updateSettings: (p) => set({ settings: { ...get().settings, ...p } }),
      updateSubtitleStyle: (p) => set({ settings: { ...get().settings, subtitle: { ...get().settings.subtitle, ...p } } }),
      setCaps: (caps) => set({ caps }),
    }),
    {
      name: 'ts-settings',
      version: 1,
      skipHydration: true, // rehydrated in a client effect to avoid SSR mismatch
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ settings: s.settings, mode: s.mode }),
      merge: (persisted: any, current) => ({
        ...current,
        ...persisted,
        settings: {
          ...DEFAULT_SETTINGS,
          ...persisted?.settings,
          debridKeys: { ...DEFAULT_SETTINGS.debridKeys, ...persisted?.settings?.debridKeys },
          subtitle: { ...DEFAULT_SETTINGS.subtitle, ...persisted?.settings?.subtitle },
        },
      }),
    },
  ),
);

/** True if a debrid key is usable for the selected provider (user key or server key). */
export function hasDebrid(s: Settings, caps?: ServerCaps) {
  return !!s.debridKeys[s.debridProvider] || !!caps?.debrid[s.debridProvider];
}
