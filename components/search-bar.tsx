'use client';
/**
 * Search bar: searches the catalog on Discover and torrents on Torrents (the tab
 * decides). Pasting a magnet, a bare info-hash or an http(s) video URL plays it.
 */
import { parseMagnet } from '@/lib/magnet';
import { usePlatform } from '@/lib/platform';
import { useApp } from '@/lib/store';
import { IconSearch, IconX } from './icons';

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
  const { mode, query, setQuery, submit } = useApp();
  const { mac } = usePlatform();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tryDirectPlay(query)) { setQuery(''); return; }
    submit();
    (document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null)?.blur();
  };

  return (
    <form onSubmit={onSubmit} className="relative" role="search">
      <IconSearch size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <input
        id={SEARCH_INPUT_ID}
        className="w-full rounded-xl border-0 bg-ink-800 py-2.5 pl-10 pr-16 text-ink-200 ring-1 ring-ink-700/70 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-accent"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={mode === 'catalog' ? 'Movies and shows' : 'Search torrents or paste a magnet'}
        aria-label={mode === 'catalog' ? 'Search movies and shows' : 'Search torrents, or paste a magnet link'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (parseMagnet(text)) { e.preventDefault(); tryDirectPlay(text); }
        }}
      />
      {query ? (
        <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-ink-400" onClick={() => setQuery('')} aria-label="Clear search"><IconX size={16} /></button>
      ) : (
        <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-ink-600 px-1.5 text-[10px] text-ink-400 lg:block">
          {mac ? '⌘' : 'Ctrl'} K
        </kbd>
      )}
    </form>
  );
}
