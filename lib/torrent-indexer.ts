/**
 * Multi-source torrent indexer.
 *
 *   searchTorrents({ q: "dune part two 2160p" })                 // raw text search
 *   searchTorrents({ imdbId: "tt15239678", type: "movie" })      // id search
 *   searchTorrents({ tmdbId: 693134, type: "movie" })            // TMDB id → IMDB id
 *   searchTorrents({ imdbId: "tt0903747", type: "series", season: 1, episode: 1 })
 *
 * Every adapter normalises into `TorrentResult` (infoHash, magnet, parsed
 * quality, size, seeders, audio, release group). Results from all sources are
 * merged by info-hash and sorted by seeders (desc), then quality.
 *
 * SERVER ONLY: runs in the Cloudflare Worker (worker/index.ts → lib/server/handlers.ts)
 * so indexer requests aren't subject to browser CORS and Torznab keys never reach clients.
 */
import { XMLParser } from 'fast-xml-parser';
import { buildMagnet, parseMagnet } from './magnet';
import { parseRelease, parseSize, QUALITY_ORDER } from './release-parser';
import type { IndexerError, SearchQuery, SearchResponse, TorrentResult } from './types';

// ─── Configuration ──────────────────────────────────────────────────────────

export type IndexerId = 'torrentio' | 'torznab' | 'yts' | 'eztv' | 'apibay';

export const ALL_INDEXERS: IndexerId[] = ['torrentio', 'torznab', 'yts', 'eztv', 'apibay'];

export interface IndexerConfig {
  enabled: IndexerId[];
  torrentioUrl: string;
  /** Optional Torrentio config segment, e.g. "providers=yts,eztv|sort=seeders". */
  torrentioOptions?: string;
  torznabUrl?: string;
  torznabApiKey?: string;
  ytsUrl: string;
  eztvUrl: string;
  apibayUrl: string;
  timeoutMs: number;
  /** Used to translate tmdbId → imdbId when only a TMDB id is supplied. */
  resolveImdbId?: (tmdbId: number, type: 'movie' | 'series') => Promise<string | undefined>;
}

export function configFromEnv(env: Record<string, string | undefined>): IndexerConfig {
  const enabled = (env.INDEXERS ?? 'torrentio,torznab,yts,eztv')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is IndexerId => (ALL_INDEXERS as string[]).includes(s));
  return {
    enabled,
    torrentioUrl: trimSlash(env.TORRENTIO_URL || 'https://torrentio.strem.fun'),
    torrentioOptions: env.TORRENTIO_OPTIONS || undefined,
    torznabUrl: env.TORZNAB_URL ? trimSlash(env.TORZNAB_URL) : undefined,
    torznabApiKey: env.TORZNAB_API_KEY || undefined,
    ytsUrl: trimSlash(env.YTS_URL || 'https://yts.mx'),
    eztvUrl: trimSlash(env.EZTV_URL || 'https://eztvx.to'),
    apibayUrl: trimSlash(env.APIBAY_URL || 'https://apibay.org'),
    timeoutMs: Number(env.INDEXER_TIMEOUT_MS || 9000),
  };
}

// ─── Adapter contract ───────────────────────────────────────────────────────

interface Ctx {
  config: IndexerConfig;
  fetchJson: <T>(url: string, init?: RequestInit) => Promise<T>;
  fetchText: (url: string, init?: RequestInit) => Promise<string>;
}

interface IndexerAdapter {
  id: IndexerId;
  /** Return false to skip silently (e.g. needs IMDB id but only text given). */
  supports(q: SearchQuery, config: IndexerConfig): boolean;
  search(q: SearchQuery, ctx: Ctx): Promise<TorrentResult[]>;
}

const UA = 'Mozilla/5.0 (compatible; TorrentStreamingPWA/0.1)';

function trimSlash(s: string) {
  return s.replace(/\/+$/, '');
}

/** Free-text query to use for indexers that cannot search by id. */
export function textQueryFor(q: SearchQuery): string | undefined {
  if (q.q?.trim()) return q.q.trim();
  if (!q.title) return undefined;
  if (q.type === 'series' && q.season != null) {
    const s = String(q.season).padStart(2, '0');
    return q.episode != null ? `${q.title} S${s}E${String(q.episode).padStart(2, '0')}` : `${q.title} S${s}`;
  }
  return q.year ? `${q.title} ${q.year}` : q.title;
}

function makeResult(
  partial: Omit<TorrentResult, 'id' | 'magnet' | keyof ReturnType<typeof parseRelease>> & {
    magnet?: string;
  },
): TorrentResult {
  const infoHash = partial.infoHash.toLowerCase();
  const parsed = parseRelease(partial.fileName || partial.title);
  // Pack titles often carry the quality while the file name doesn't (or vice versa).
  if (parsed.quality === 'Unknown' && partial.fileName) {
    const fromTitle = parseRelease(partial.title);
    parsed.quality = fromTitle.quality;
    parsed.resolution = fromTitle.resolution;
  }
  return {
    ...parsed,
    ...partial,
    infoHash,
    magnet: partial.magnet || buildMagnet(infoHash, partial.title),
    id: partial.fileIdx != null ? `${infoHash}:${partial.fileIdx}` : infoHash,
  };
}

// ─── Torrentio (Stremio add-on protocol) ────────────────────────────────────

interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: { filename?: string; bingeGroup?: string; videoSize?: number };
}

/**
 * Torrentio packs stats into the title:
 *   "Show.S01.1080p.WEB-DL.DDP5.1-GRP\nShow.S01E03.1080p.mkv\n👤 152 💾 1.43 GB ⚙️ 1337x\nMulti Audio"
 */
export function parseTorrentioStream(s: StremioStream): TorrentResult | null {
  if (!s.infoHash) return null;
  const text = s.title ?? s.description ?? '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const statsIdx = lines.findIndex((l) => l.includes('👤') || l.includes('💾'));
  const nameLines = statsIdx >= 0 ? lines.slice(0, statsIdx) : lines.slice(0, 1);
  const stats = statsIdx >= 0 ? lines[statsIdx] : '';
  const seeders = Number(stats.match(/👤\s*(\d+)/)?.[1] ?? 0);
  const sizeBytes = s.behaviorHints?.videoSize ?? parseSize(stats.match(/💾\s*([\d.,]+\s*[KMGT]?i?B)/i)?.[1]);
  const tracker = stats.match(/⚙️\s*(.+)$/)?.[1]?.trim();
  const title = nameLines[0] ?? s.behaviorHints?.filename ?? s.infoHash;
  const fileName = s.behaviorHints?.filename ?? (nameLines.length > 1 ? nameLines[nameLines.length - 1] : undefined);
  return makeResult({
    title,
    fileName: fileName !== title ? fileName : undefined,
    infoHash: s.infoHash,
    fileIdx: s.fileIdx,
    sizeBytes,
    seeders,
    leechers: 0,
    indexer: 'torrentio',
    tracker,
  });
}

const torrentio: IndexerAdapter = {
  id: 'torrentio',
  supports: (q) => !!q.imdbId,
  async search(q, { config, fetchJson }) {
    const kind = q.type === 'series' ? 'series' : 'movie';
    const id = kind === 'series' && q.season != null ? `${q.imdbId}:${q.season}:${q.episode ?? 1}` : q.imdbId!;
    const opts = config.torrentioOptions ? `/${config.torrentioOptions}` : '';
    const data = await fetchJson<{ streams?: StremioStream[] }>(`${config.torrentioUrl}${opts}/stream/${kind}/${id}.json`);
    return (data.streams ?? []).map(parseTorrentioStream).filter((r): r is TorrentResult => r !== null);
  },
};

// ─── Torznab (Jackett / Prowlarr) ───────────────────────────────────────────

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'item' || name === 'torznab:attr' });

/** Parse a Torznab RSS response into normalised results. */
export function parseTorznabXml(body: string, indexerLabel = 'torznab'): TorrentResult[] {
  const doc = xml.parse(body);
  const error = doc?.error?.['@_description'];
  if (error) throw new Error(`Torznab: ${error}`);
  const items: any[] = doc?.rss?.channel?.item ?? [];
  const out: TorrentResult[] = [];
  for (const it of items) {
    const attrs: Record<string, string> = {};
    for (const a of it['torznab:attr'] ?? []) attrs[a['@_name']] = String(a['@_value']);
    const link: string = typeof it.link === 'string' ? it.link : '';
    const enclosure: string = it.enclosure?.['@_url'] ?? '';
    const magnetCandidate = attrs.magneturl || [link, enclosure, it.guid?.['#text'] ?? it.guid].find((u) => typeof u === 'string' && u.startsWith('magnet:'));
    const parsedMagnet = magnetCandidate ? parseMagnet(magnetCandidate) : null;
    const infoHash = (attrs.infohash || parsedMagnet?.infoHash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) continue; // .torrent-only results can't be streamed without a fetch
    const seeders = Number(attrs.seeders ?? 0);
    const peers = Number(attrs.peers ?? 0);
    out.push(
      makeResult({
        title: String(it.title ?? infoHash),
        infoHash,
        magnet: parsedMagnet?.magnet,
        sizeBytes: Number(attrs.size ?? it.size ?? it.enclosure?.['@_length']) || undefined,
        seeders,
        leechers: Math.max(0, peers - seeders),
        indexer: indexerLabel,
        tracker: it.jackettindexer?.['#text'] ?? it.prowlarrindexer?.['#text'] ?? it.jackettindexer ?? it.prowlarrindexer,
        publishedAt: it.pubDate,
      }),
    );
  }
  return out;
}

const torznab: IndexerAdapter = {
  id: 'torznab',
  supports: (q, c) => !!c.torznabUrl && (!!q.imdbId || !!textQueryFor(q)),
  async search(q, { config, fetchText }) {
    const p = new URLSearchParams();
    if (config.torznabApiKey) p.set('apikey', config.torznabApiKey);
    if (q.imdbId && q.type === 'series') {
      p.set('t', 'tvsearch');
      p.set('imdbid', q.imdbId);
      if (q.season != null) p.set('season', String(q.season));
      if (q.episode != null) p.set('ep', String(q.episode));
    } else if (q.imdbId) {
      p.set('t', 'movie');
      p.set('imdbid', q.imdbId);
    } else {
      p.set('t', 'search');
      p.set('q', textQueryFor(q)!);
    }
    p.set('cat', q.type === 'series' ? '5000' : q.type === 'movie' ? '2000' : '2000,5000');
    const base = config.torznabUrl!.endsWith('/api') ? config.torznabUrl! : `${config.torznabUrl}/api`;
    return parseTorznabXml(await fetchText(`${base}?${p}`));
  },
};

// ─── YTS (movies) ───────────────────────────────────────────────────────────

interface YtsMovie {
  title_long: string;
  imdb_code: string;
  torrents?: { hash: string; quality: string; type: string; size_bytes: number; seeds: number; peers: number; video_codec?: string; audio_channels?: string; date_uploaded?: string }[];
}

const yts: IndexerAdapter = {
  id: 'yts',
  supports: (q) => q.type !== 'series' && !!(q.imdbId || textQueryFor(q)),
  async search(q, { config, fetchJson }) {
    const term = q.imdbId ?? textQueryFor(q)!;
    const data = await fetchJson<{ data?: { movies?: YtsMovie[] } }>(
      `${config.ytsUrl}/api/v2/list_movies.json?limit=20&query_term=${encodeURIComponent(term)}`,
    );
    const out: TorrentResult[] = [];
    for (const m of data.data?.movies ?? []) {
      if (q.imdbId && m.imdb_code !== q.imdbId) continue;
      for (const t of m.torrents ?? []) {
        if (t.quality === '3D') continue;
        const codec = t.video_codec === 'x265' ? 'x265' : 'x264';
        const ch = t.audio_channels ? ` ${t.audio_channels}` : '';
        out.push(
          makeResult({
            title: `${m.title_long} ${t.quality} ${t.type === 'bluray' ? 'BluRay' : 'WEBRip'} ${codec} AAC${ch}-YTS`,
            infoHash: t.hash,
            sizeBytes: t.size_bytes,
            seeders: t.seeds,
            leechers: t.peers,
            indexer: 'yts',
            tracker: 'YTS',
            publishedAt: t.date_uploaded,
          }),
        );
      }
    }
    return out;
  },
};

// ─── EZTV (series, by IMDB id) ──────────────────────────────────────────────

const eztv: IndexerAdapter = {
  id: 'eztv',
  supports: (q) => q.type === 'series' && !!q.imdbId,
  async search(q, { config, fetchJson }) {
    const imdbNum = q.imdbId!.replace(/^tt/, '');
    const data = await fetchJson<{
      torrents?: { title: string; hash: string; magnet_url: string; seeds: number; peers: number; size_bytes: string; season: string; episode: string; date_released_unix: number }[];
    }>(`${config.eztvUrl}/api/get-torrents?imdb_id=${imdbNum}&limit=100`);
    return (data.torrents ?? [])
      .filter((t) => (q.season == null || +t.season === q.season) && (q.episode == null || +t.episode === q.episode || +t.episode === 0))
      .map((t) =>
        makeResult({
          title: t.title,
          infoHash: t.hash,
          magnet: parseMagnet(t.magnet_url)?.magnet,
          sizeBytes: Number(t.size_bytes) || undefined,
          seeders: t.seeds,
          leechers: Math.max(0, t.peers - t.seeds),
          indexer: 'eztv',
          tracker: 'EZTV',
          publishedAt: t.date_released_unix ? new Date(t.date_released_unix * 1000).toISOString() : undefined,
        }),
      );
  },
};

// ─── apibay (raw text search) ───────────────────────────────────────────────

const apibay: IndexerAdapter = {
  id: 'apibay',
  supports: (q) => !!textQueryFor(q),
  async search(q, { config, fetchJson }) {
    // cat 200 = Video
    const data = await fetchJson<{ id: string; name: string; info_hash: string; seeders: string; leechers: string; size: string; added: string }[]>(
      `${config.apibayUrl}/q.php?cat=200&q=${encodeURIComponent(textQueryFor(q)!)}`,
    );
    return data
      .filter((t) => t.id !== '0' && /^[a-f0-9]{40}$/i.test(t.info_hash))
      .map((t) =>
        makeResult({
          title: t.name,
          infoHash: t.info_hash,
          sizeBytes: Number(t.size) || undefined,
          seeders: Number(t.seeders) || 0,
          leechers: Number(t.leechers) || 0,
          indexer: 'apibay',
          tracker: 'TPB',
          publishedAt: t.added ? new Date(Number(t.added) * 1000).toISOString() : undefined,
        }),
      );
  },
};

const ADAPTERS: Record<IndexerId, IndexerAdapter> = { torrentio, torznab, yts, eztv, apibay };

// ─── Merge / sort ───────────────────────────────────────────────────────────

/** Merge duplicates (same info-hash from several sources), keeping the richest record. */
export function mergeResults(results: TorrentResult[]): TorrentResult[] {
  const byHash = new Map<string, TorrentResult>();
  for (const r of results) {
    const prev = byHash.get(r.infoHash);
    if (!prev) { byHash.set(r.infoHash, r); continue; }
    const trackers = new Set([prev.tracker, r.tracker].flatMap((t) => (t ? t.split(', ') : [])));
    byHash.set(r.infoHash, {
      ...prev,
      // keep the file-targeted entry (Torrentio packs) when available
      fileIdx: prev.fileIdx ?? r.fileIdx,
      fileName: prev.fileName ?? r.fileName,
      id: prev.fileIdx != null ? prev.id : r.id,
      seeders: Math.max(prev.seeders, r.seeders),
      leechers: Math.max(prev.leechers, r.leechers),
      sizeBytes: prev.sizeBytes ?? r.sizeBytes,
      tracker: [...trackers].join(', ') || undefined,
      indexer: prev.indexer === r.indexer ? prev.indexer : `${prev.indexer}+${r.indexer}`,
    });
  }
  return [...byHash.values()];
}

export function sortBySeeders(results: TorrentResult[]): TorrentResult[] {
  return [...results].sort(
    (a, b) => b.seeders - a.seeders || QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
  );
}

/** Drop wrong episodes returned by text-only indexers. Season packs are kept. */
function matchesEpisode(r: TorrentResult, q: SearchQuery): boolean {
  if (q.type !== 'series' || q.season == null) return true;
  if (r.season != null && r.season !== q.season) return false;
  if (q.episode != null && r.episode != null && r.episode !== q.episode) return false;
  return true;
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function searchTorrents(query: SearchQuery, config: IndexerConfig): Promise<SearchResponse> {
  const started = Date.now();
  const q: SearchQuery = { ...query };
  if (!q.imdbId && q.tmdbId && config.resolveImdbId) {
    q.imdbId = await config.resolveImdbId(q.tmdbId, q.type ?? 'movie').catch(() => undefined);
  }
  if (q.imdbId && !/^tt\d{5,}$/.test(q.imdbId)) throw new Error('Invalid IMDB id');

  const fetchWithTimeout = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, Accept: 'application/json, application/xml;q=0.9, */*;q=0.8', ...init?.headers },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  const ctx: Ctx = {
    config,
    fetchJson: async (url, init) => (await fetchWithTimeout(url, init)).json(),
    fetchText: async (url, init) => (await fetchWithTimeout(url, init)).text(),
  };

  const active = config.enabled.map((id) => ADAPTERS[id]).filter((a) => a.supports(q, config));
  const settled = await Promise.allSettled(active.map((a) => a.search(q, ctx)));

  const errors: IndexerError[] = [];
  const all: TorrentResult[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') all.push(...s.value);
    else errors.push({ indexer: active[i].id, message: s.reason instanceof Error ? s.reason.message : String(s.reason) });
  });

  const results = sortBySeeders(mergeResults(all).filter((r) => matchesEpisode(r, q)));
  return { query: q, results, errors, tookMs: Date.now() - started };
}
