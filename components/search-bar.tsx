'use client';
/**
 * Unified search bar: Catalog (TMDB) ↔ Direct Torrent toggle, plus the
 * "Paste magnet / info-hash" box. Pasting a magnet, a bare info-hash or an
 * http(s) video URL into either field starts playback immediately.
 */
import { useState } from 'react';
import { parseMagnet } from '@/lib/magnet';
import { usePlatform } from '@/lib/platform';
import { useApp } from '@/lib/store';
import { IconMagnet, IconPlay, IconSearch, IconX } from './icons';

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

export function SearchBar() {
  const { mode, setMode, query, setQuery, submit } = useApp();
  const { mac } = usePlatform();
  const [magnetOpen, setMagnetOpen] = useState(false);
  const [magnet, setMagnet] = useState('');
  const [magnetError, setMagnetError] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tryDirectPlay(query)) { setQuery(''); return; }
    submit();
    (document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null)?.blur();
  };

  const onMagnet = (e: React.FormEvent) => {
    e.preventDefault();
    if (tryDirectPlay(magnet)) { setMagnet(''); setMagnetError(false); setMagnetOpen(false); }
    else setMagnetError(true);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="Search mode" className="flex shrink-0 rounded-lg border border-ink-600 bg-ink-900 p-0.5 text-xs font-semibold">
          {(['catalog', 'torrent'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); if (query) submit(); }}
              className={`rounded-md px-2.5 py-1.5 transition ${mode === m ? 'bg-accent text-ink-950' : 'text-ink-400 hover:text-ink-200'}`}>
              <span className="sm:hidden">{m === 'catalog' ? 'Catalog' : 'Torrent'}</span>
              <span className="hidden sm:inline">{m === 'catalog' ? 'Catalog (TMDB)' : 'Direct Torrent'}</span>
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="relative min-w-0 flex-1" role="search">
          <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            id={SEARCH_INPUT_ID}
            className="input pl-9 pr-16"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={mode === 'catalog' ? 'Search movies & shows…' : 'Raw torrent search, magnet or info-hash…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (parseMagnet(text)) { e.preventDefault(); tryDirectPlay(text); }
            }}
          />
          {query ? (
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-400" onClick={() => setQuery('')} aria-label="Clear search"><IconX size={16} /></button>
          ) : (
            <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-ink-600 px-1.5 text-[10px] text-ink-400 lg:block">
              {mac ? '⌘' : 'Ctrl'} K
            </kbd>
          )}
        </form>

        <button className={`btn-ghost shrink-0 border ${magnetOpen ? 'border-accent text-accent' : 'border-ink-600'} lg:hidden`} onClick={() => setMagnetOpen((o) => !o)} aria-expanded={magnetOpen} aria-label="Paste magnet link">
          <IconMagnet size={16} />
        </button>
      </div>

      <form onSubmit={onMagnet} className={`${magnetOpen ? 'flex' : 'hidden'} gap-2 lg:flex`}>
        <div className="relative flex-1">
          <IconMagnet size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            className={`input pl-9 font-mono text-xs ${magnetError ? 'border-red-500' : ''}`}
            placeholder="Paste magnet link / info-hash / .m3u8 URL"
            autoComplete="off"
            spellCheck={false}
            value={magnet}
            onChange={(e) => { setMagnet(e.target.value); setMagnetError(false); }}
            aria-invalid={magnetError}
            aria-label="Magnet link or info hash"
          />
        </div>
        <button className="btn-primary shrink-0" disabled={!magnet.trim()}><IconPlay size={14} /> Stream</button>
      </form>
      {magnetError && <p className="text-xs text-red-400">Not a valid magnet link, 40-char hex / 32-char base32 info-hash, or video URL.</p>}
    </div>
  );
}
