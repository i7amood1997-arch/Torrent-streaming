'use client';
import { create } from 'zustand';
import { unlockAudio } from './audio-tap';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { DebridProvider, MediaType, TmdbItem, TorrentResult } from './types';

export type View = 'discover' | 'search' | 'player' | 'settings';
export type SearchMode = 'catalog' | 'torrent';
export type EnginePref = 'auto' | 'debrid' | 'cloud' | 'webtor' | 'webtorrent';

export interface SubtitleStyle {
  scale: number; // 0.6 – 2
  bgOpacity: number; // 0 – 1
  color: string;
  arabicFont: 'Cairo' | 'Tajawal';
  position: number; // % from bottom, 4–40
  primaryLang: 'ar' | 'en';
  dual: boolean; // render secondary language too
  /** Sync downloaded subtitles to the soundtrack automatically. */
  autoSync: boolean;
  /** Translate a subtitle from another language when Arabic or English is missing. */
  autoTranslate: boolean;
  /** No subtitles at all: generate them from the speech (needs the relay). */
  autoGenerate: boolean;
  /** Who translates: an AI model on the relay (better, uses its free daily allowance) or Google. */
  translator: 'ai' | 'google';
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
  /** Torrent sources to query (subset of what the API offers). */
  indexers: string[];
  /** Extra Stremio add-on manifest URLs (one per line), searched like Torrentio. */
  stremioAddons: string;
  /** No-backend mode: retry blocked sources through public relays (keyless searches only). */
  publicRelays: boolean;
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
  /** Episode number counted from the show's first episode (to match anime subtitles). */
  absEpisode?: number;
  /** Artwork for Continue Watching. */
  poster?: string;
  backdrop?: string;
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
  /** Backend can stream torrents itself (built-in cloud streaming). */
  stream?: boolean;
  /** Relay can turn speech into subtitles (Workers AI). */
  ai?: boolean;
  /** The relay has a Claude API key: last-resort translator when everything else refused. */
  claude?: boolean;
  /** True when running without a backend (API code runs in the browser). */
  direct?: boolean;
  /** Set when a configured backend could not be reached or rejected us. */
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
  /** Title page shown over the current view. */
  detail?: TmdbItem;
  openDetail: (item: TmdbItem) => void;
  closeDetail: () => void;
  /** Recently played, newest first (Continue Watching). */
  history: Omit<PlayRequest, 'nonce'>[];
  forget: (index: number) => void;
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
  indexers: ['torrentio', 'knaben', 'yts', 'eztv', 'nyaa', 'animetosho', 'archive', 'mediafusion', 'apibay', 'torrentscsv'],
  stremioAddons: '',
  publicRelays: true,
  engine: 'auto',
  subtitle: { scale: 1, bgOpacity: 0.55, color: '#ffffff', arabicFont: 'Cairo', position: 8, primaryLang: 'ar', dual: true, autoSync: true, autoTranslate: true, autoGenerate: true, translator: 'ai' },
};

/**
 * The browser's localStorage, or an in-memory stand-in when it is blocked (some private
 * modes, locked-down profiles). Without a storage, zustand drops the persist API and the
 * app crashed on start; now settings simply last until the tab closes.
 */
export function safeStorage(): Storage {
  try {
    const ls = window.localStorage;
    const k = '__ts_probe';
    ls.setItem(k, '1');
    ls.removeItem(k);
    return ls;
  } catch {
    const m = new Map<string, string>();
    return {
      get length() { return m.size; },
      clear: () => m.clear(),
      getItem: (k) => m.get(k) ?? null,
      key: (i) => [...m.keys()][i] ?? null,
      removeItem: (k) => { m.delete(k); },
      setItem: (k, v) => { m.set(k, String(v)); },
    };
  }
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      view: 'discover',
      listView: 'discover',
      mode: 'catalog',
      query: '',
      submittedQuery: '',
      settings: DEFAULT_SETTINGS,
      history: [],
      forget: (index) => set({ history: get().history.filter((_, i) => i !== index) }),
      openDetail: (detail) => set(get().view === 'player' ? { detail, view: get().listView } : { detail }),
      closeDetail: () => set({ detail: undefined }),
      setView: (view) => set(view === 'player' ? { view } : { view, listView: view, detail: get().view === 'player' ? get().detail : undefined }),
      setMode: (mode) => set({ mode }),
      setQuery: (query) => set({ query }),
      submit: (q) => {
        const query = (q ?? get().query).trim();
        set({ query, submittedQuery: query, view: 'search', listView: 'search', detail: undefined });
      },
      play: (r) => {
        unlockAudio(); // called from a tap: lets subtitle auto-sync listen to the audio later
        const same = (h: Omit<PlayRequest, 'nonce'>) => (r.imdbId ? h.imdbId === r.imdbId && h.season === r.season && h.episode === r.episode : (h.result?.id ?? h.url) === (r.result?.id ?? r.url));
        set({ nowPlaying: { ...r, nonce: Date.now() }, view: 'player', history: [r, ...get().history.filter((h) => !same(h))].slice(0, 12) });
      },
      updateSettings: (p) => set({ settings: { ...get().settings, ...p } }),
      updateSubtitleStyle: (p) => set({ settings: { ...get().settings, subtitle: { ...get().settings.subtitle, ...p } } }),
      setCaps: (caps) => set({ caps }),
    }),
    {
      name: 'ts-settings',
      version: 4,
      // v2 added sources (Knaben, Nyaa, Torrents-CSV) and made the Pirate Bay API default: switch them on once for existing users.
      migrate: (persisted: any, version) => {
        if (version < 2 && Array.isArray(persisted?.settings?.indexers)) {
          persisted.settings.indexers = [...new Set([...persisted.settings.indexers, 'knaben', 'nyaa', 'apibay', 'torrentscsv'])];
        }
        // v4 added the Internet Archive (direct links).
        if (version < 4 && Array.isArray(persisted?.settings?.indexers)) {
          persisted.settings.indexers = [...new Set([...persisted.settings.indexers, 'archive'])];
        }
        // v3 added AnimeTosho and MediaFusion.
        if (version < 3 && Array.isArray(persisted?.settings?.indexers)) {
          persisted.settings.indexers = [...new Set([...persisted.settings.indexers, 'animetosho', 'mediafusion'])];
        }
        return persisted;
      },
      skipHydration: true, // rehydrated in a client effect to avoid SSR mismatch
      storage: createJSONStorage(safeStorage),
      partialize: (s) => ({ settings: s.settings, mode: s.mode, history: s.history }),
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

/** True when a torrent will stream through the user's relay (same choice the player makes). */
export function usesRelayStreaming(s: Settings, caps?: ServerCaps): boolean {
  if (!caps?.stream) return false;
  return s.engine === 'cloud' || (s.engine === 'auto' && !hasDebrid(s, caps));
}

/** True if a debrid key is usable for the selected provider (user key or server key). */
export function hasDebrid(s: Settings, caps?: ServerCaps) {
  return !!s.debridKeys[s.debridProvider] || !!caps?.debrid[s.debridProvider];
}
