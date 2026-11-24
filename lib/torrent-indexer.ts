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
import { fetchJsonWithRelays } from './relays';
import { describeError, isBrowser, serverOnlyHeaders } from './runtime';
import type { IndexerError, SearchQuery, SearchResponse, TorrentResult } from './types';

// ─── Configuration ──────────────────────────────────────────────────────────

export type IndexerId = 'torrentio' | 'torznab' | 'yts' | 'eztv' | 'apibay' | 'knaben' | 'torrentscsv' | 'nyaa' | 'animetosho' | 'mediafusion' | 'addons' | 'archive' | 'torrentsdb' | 'bitsearch' | 'torrentclaw' | 'torrentdownload' | 'torrentgalaxy' | 'therarbg' | 'kickass' | 'limetorrents' | 'glotorrents';

export const ALL_INDEXERS: IndexerId[] = ['torrentio', 'torznab', 'yts', 'eztv', 'apibay', 'knaben', 'torrentscsv', 'nyaa', 'animetosho', 'mediafusion', 'addons', 'archive', 'torrentsdb', 'bitsearch', 'torrentclaw', 'torrentdownload', 'torrentgalaxy', 'therarbg', 'kickass', 'limetorrents', 'glotorrents'];

export interface IndexerConfig {
  enabled: IndexerId[];
  torrentioUrl: string;
  /** Optional Torrentio config segment, e.g. "providers=yts,eztv|sort=seeders". */
  torrentioOptions?: string;
  torznabUrl?: string;
  torznabApiKey?: string;
  /** YTS mirrors, tried in order; the one that answers is remembered. */
  ytsUrls: string[];
  /** EZTV mirrors, tried in order; the one that answers is remembered. */
  eztvUrls: string[];
  animetoshoUrl: string;
  archiveUrl: string;
  mediafusionUrl: string;
  /** Extra Stremio add-ons (manifest URLs) whose torrent streams are included. */
  stremioAddons: string[];
  apibayUrl: string;
  knabenUrl: string;
  torrentsCsvUrl: string;
  nyaaUrl: string;
  torrentsdbUrl: string;
  bitsearchUrl: string;
  torrentclawUrl: string;
  /** TorrentClaw only gives each torrent's info-hash to requests with an API key. */
  torrentclawKey?: string;
  torrentdownloadUrl: string;
  torrentgalaxyUrl: string;
  therarbgUrl: string;
  kickassUrl: string;
  limetorrentsUrl: string;
  glotorrentsUrl: string;
  timeoutMs: number;
  /** Browser only: retry keyless JSON indexers through public CORS relays when blocked. */
  publicRelays?: boolean;
  /** Used to translate tmdbId → imdbId when only a TMDB id is supplied. */
  resolveImdbId?: (tmdbId: number, type: 'movie' | 'series') => Promise<string | undefined>;
}

export function configFromEnv(env: Record<string, string | undefined>): IndexerConfig {
  const enabled = (env.INDEXERS ?? ALL_INDEXERS.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is IndexerId => (ALL_INDEXERS as string[]).includes(s));
  return {
    enabled,
    torrentioUrl: trimSlash(env.TORRENTIO_URL || 'https://torrentio.strem.fun'),
    torrentioOptions: env.TORRENTIO_OPTIONS || undefined,
    torznabUrl: env.TORZNAB_URL ? trimSlash(env.TORZNAB_URL) : undefined,
    torznabApiKey: env.TORZNAB_API_KEY || undefined,
    // YTS changes domain often (yts.mx died in 2025). Configured URL(s) first, then known mirrors.
    ytsUrls: [...new Set([...(env.YTS_URL ?? '').split(','), ...YTS_MIRRORS].map((u) => trimSlash(u.trim())).filter(Boolean))],
    eztvUrls: [...new Set([...(env.EZTV_URL ?? '').split(','), ...EZTV_MIRRORS].map((u) => trimSlash(u.trim())).filter(Boolean))],
    animetoshoUrl: trimSlash(env.ANIMETOSHO_URL || 'https://feed.animetosho.net'),
    archiveUrl: trimSlash(env.ARCHIVE_URL || 'https://archive.org'),
    mediafusionUrl: trimSlash(env.MEDIAFUSION_URL || 'https://mediafusion.elfhosted.com'),
    stremioAddons: parseAddonList(env.STREMIO_ADDONS),
    apibayUrl: trimSlash(env.APIBAY_URL || 'https://apibay.org'),
    knabenUrl: trimSlash(env.KNABEN_URL || 'https://api.knaben.org'),
    torrentsCsvUrl: trimSlash(env.TORRENTS_CSV_URL || 'https://torrents-csv.com'),
    nyaaUrl: trimSlash(env.NYAA_URL || 'https://nyaa.si'),
    torrentsdbUrl: trimSlash(env.TORRENTSDB_URL || 'https://torrentsdb.com'),
    bitsearchUrl: trimSlash(env.BITSEARCH_URL || 'https://bitsearch.to'),
    torrentclawUrl: trimSlash(env.TORRENTCLAW_URL || 'https://torrentclaw.com'),
    torrentclawKey: env.TORRENTCLAW_API_KEY || undefined,
    torrentdownloadUrl: trimSlash(env.TORRENTDOWNLOAD_URL || 'https://www.torrentdownload.info'),
    torrentgalaxyUrl: trimSlash(env.TORRENTGALAXY_URL || 'https://torrentgalaxy.to'),
    therarbgUrl: trimSlash(env.THERARBG_URL || 'https://therarbg.com'),
    kickassUrl: trimSlash(env.KICKASS_URL || 'https://katcr.to'),
    limetorrentsUrl: trimSlash(env.LIMETORRENTS_URL || 'https://www.limetorrents.lol'),
    glotorrentsUrl: trimSlash(env.GLOTORRENTS_URL || 'https://glodls.to'),
    timeoutMs: Number(env.INDEXER_TIMEOUT_MS || 6500),
    publicRelays: env.USE_PUBLIC_RELAYS === 'true',
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
/**
 * All text queries worth running. For a single episode, the season pack too:
 * packs usually have far more seeders, and the right episode is picked from the
 * pack's file list at play time.
 */
export function textQueriesFor(q: SearchQuery): string[] {
  const main = textQueryFor(q);
  if (!main) return [];
  if (!q.q?.trim() && q.title && q.type === 'series' && q.season != null && q.episode != null) {
    return [main, `${q.title} S${String(q.season).padStart(2, '0')}`];
  }
  return [main];
}

/** Run a text search for every query and concatenate the results (one failing query is tolerated). */
async function eachQuery(q: SearchQuery, run: (term: string) => Promise<TorrentResult[]>): Promise<TorrentResult[]> {
  const terms = textQueriesFor(q);
  const settled = await Promise.allSettled(terms.map(run));
  const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  if (!ok.length && settled[0]?.status === 'rejected') throw settled[0].reason;
  return ok.flat();
}

export function textQueryFor(q: SearchQuery): string | undefined {
  if (q.q?.trim()) return q.q.trim();
  if (!q.title) return undefined;
  // Anime are released as "Title - 009", numbered within their Kitsu entry (straight through for a
  // long-running show); "Title S02E01" finds a live-action show of the same name instead.
  if (q.kitsu) { const n = q.kitsu.episode; return `${q.title} ${String(n).padStart(n >= 100 ? 3 : 2, '0')}`; }
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
  /** Direct HTTP stream (debrid-backed add-ons, HTTP sources). */
  url?: string;
  behaviorHints?: {
    filename?: string;
    bingeGroup?: string;
    videoSize?: number;
    notWebReady?: boolean;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

/** Short stable id for a URL (direct results have no info-hash). */
function urlId(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return `url:${h.toString(16)}:${url.length}`;
}

/** A direct-link result. */
export function makeDirectResult(p: { title: string; url: string; fileName?: string; sizeBytes?: number; indexer: string; tracker?: string; headers?: Record<string, string>; notWebReady?: boolean; imdbId?: string; quality?: TorrentResult['quality'] }): TorrentResult {
  const parsed = parseRelease(p.fileName || p.title);
  if (parsed.quality === 'Unknown' && p.fileName) {
    const fromTitle = parseRelease(p.title);
    parsed.quality = fromTitle.quality;
    parsed.resolution = fromTitle.resolution;
  }
  if (p.quality && parsed.quality === 'Unknown') parsed.quality = p.quality;
  const container = parsed.container ?? p.url.split('?')[0].match(/\.(mp4|m4v|mov|mkv|webm|avi|m3u8)$/i)?.[1].toLowerCase();
  const { quality, ...rest } = p;
  void quality;
  return { ...parsed, ...rest, container, id: urlId(p.url), infoHash: '', magnet: '', seeders: 0, leechers: 0 };
}

/** Direct (HTTP) streams in a Stremio response. */
function parseStremioDirect(s: StremioStream, label: string, imdbId?: string): TorrentResult | null {
  if (!s.url || !/^https?:\/\//i.test(s.url) || s.infoHash) return null;
  const text = [s.title ?? s.description ?? '', s.name ?? ''].join('\n');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = s.behaviorHints?.filename ?? lines.find((l) => /\b(2160p|1080p|720p|480p|web|bluray|x26[45]|hevc)\b/i.test(l)) ?? lines[0] ?? s.url;
  const host = (() => { try { return new URL(s.url!).host; } catch { return undefined; } })();
  const headers = s.behaviorHints?.proxyHeaders?.request;
  return makeDirectResult({
    title,
    url: s.url,
    fileName: s.behaviorHints?.filename,
    sizeBytes: s.behaviorHints?.videoSize ?? parseSize(text.match(/💾\s*([\d.,]+\s*[KMGT]?i?B)/i)?.[1]),
    indexer: label,
    tracker: s.name?.split('\n')[0]?.trim() || host,
    headers: headers && Object.keys(headers).length ? headers : undefined,
    notWebReady: s.behaviorHints?.notWebReady,
    imdbId,
  });
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

/** Torrent streams from any Stremio add-on (base URL = manifest URL without /manifest.json). */
async function stremioStreams(base: string, q: SearchQuery, fetchJson: Ctx['fetchJson'], label: string, byKitsu = false): Promise<TorrentResult[]> {
  const kind = q.type === 'series' ? 'series' : 'movie';
  // Anime: ask by Kitsu id first (anime releases, right episode); the IMDb id if that finds nothing.
  if (byKitsu && q.kitsu) {
    const found = await stremioStreams(base, { ...q, kitsu: undefined, imdbId: `kitsu:${q.kitsu.id}`, season: undefined, episode: q.kitsu.episode }, fetchJson, label).catch(() => []);
    if (found.length) return found.map((r) => ({ ...r, imdbId: q.imdbId }));
  }
  const id = q.imdbId?.startsWith('kitsu:') ? `${q.imdbId}:${q.episode ?? 1}` : kind === 'series' && q.season != null ? `${q.imdbId}:${q.season}:${q.episode ?? 1}` : q.imdbId!;
  const data = await fetchJson<{ streams?: StremioStream[] }>(`${base}/stream/${q.imdbId?.startsWith('kitsu:') ? 'series' : kind}/${id}.json`);
  return (data.streams ?? []).flatMap((s) => {
    const direct = parseStremioDirect(s, label, q.imdbId);
    if (direct) return [direct];
    const r = parseTorrentioStream(s);
    if (!r) return [];
    r.indexer = label;
    r.imdbId = q.imdbId;
    return [r];
  });
}

/** "https://x/abc/manifest.json https://y/manifest.json" → base URLs (https only, max 5). */
export function parseAddonList(raw?: string | null): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((u) => u.trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''))
    .filter((u) => /^https:\/\/[^\s/]+\.[^\s/]+/i.test(u))
    .slice(0, 5);
}

const torrentio: IndexerAdapter = {
  id: 'torrentio',
  supports: (q) => !!q.imdbId,
  search: (q, { config, fetchJson }) =>
    stremioStreams(config.torrentioUrl + (config.torrentioOptions ? `/${config.torrentioOptions}` : ''), q, fetchJson, 'torrentio', true),
};

/** MediaFusion's public instance (aggregates Prowlarr, Zilean, Torrentio and more). May hide torrents for anonymous users. */
const mediafusion: IndexerAdapter = {
  id: 'mediafusion',
  supports: (q) => !!q.imdbId,
  search: (q, { config, fetchJson }) => stremioStreams(config.mediafusionUrl, q, fetchJson, 'mediafusion', true),
};

/** TorrentsDB: a large torrent catalogue served as a Stremio add-on (by IMDb id, like Torrentio). */
const torrentsdb: IndexerAdapter = {
  id: 'torrentsdb',
  supports: (q) => !!q.imdbId,
  search: (q, { config, fetchJson }) => stremioStreams(config.torrentsdbUrl, q, fetchJson, 'torrentsdb'),
};

/** The user's own Stremio add-ons (e.g. a configured AIOStreams, Comet, TorrentClaw or MediaFusion). */
const addons: IndexerAdapter = {
  id: 'addons',
  supports: (q, c) => !!q.imdbId && c.stremioAddons.length > 0,
  async search(q, { config, fetchJson }) {
    const settled = await Promise.allSettled(config.stremioAddons.map((base) => stremioStreams(base, q, fetchJson, 'addons')));
    const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
    if (!ok.length && settled.every((s) => s.status === 'rejected')) throw (settled[0] as PromiseRejectedResult).reason;
    return ok;
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

// Primary domains per Prowlarr's maintained definitions (Nov 2026): yts.gg (the others redirect to it), eztvx.to.
export const YTS_MIRRORS = ['https://yts.gg', 'https://yts.bz', 'https://yts.lt', 'https://yts.am', 'https://yts.ag', 'https://yts.mx'];
export const EZTV_MIRRORS = ['https://eztvx.to', 'https://eztv.wf', 'https://eztv.tf', 'https://eztv.yt', 'https://eztv1.xyz'];

/** Mirror that answered last, per mirror group (per process / page session) — tried first next time. */
const preferredMirror = new Map<string, string>();

/** Try mirrors in order until one returns valid API JSON. */
export async function fetchFromMirrors<T>(mirrors: string[], path: string, fetchJson: (url: string) => Promise<T>, isValid: (d: T) => boolean): Promise<T> {
  const group = mirrors.join('|');
  const pref = preferredMirror.get(group);
  const order = pref && mirrors.includes(pref) ? [pref, ...mirrors.filter((m) => m !== pref)] : mirrors;
  const failures: string[] = [];
  for (const base of order) {
    try {
      const data = await fetchJson(base + path);
      if (!isValid(data)) throw new Error('unexpected response');
      preferredMirror.set(group, base);
      return data;
    } catch (e) {
      failures.push(`${new URL(base).host}: ${describeError(e)}`);
    }
  }
  preferredMirror.delete(group);
  throw new Error(`all mirrors failed (${failures.join('; ')})`);
}

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
    const data = await fetchFromMirrors<{ status?: string; data?: { movies?: YtsMovie[] } }>(
      config.ytsUrls,
      `/api/v2/list_movies.json?limit=20&query_term=${encodeURIComponent(term)}`,
      (url) => fetchJson(url),
      (d) => d?.status === 'ok' && typeof d.data === 'object',
    );
    const out: TorrentResult[] = [];
    for (const m of data.data?.movies ?? []) {
      if (q.imdbId && m.imdb_code !== q.imdbId) continue;
      for (const t of m.torrents ?? []) {
        if (t.quality === '3D') continue;
        const codec = t.video_codec === 'x265' ? 'x265' : 'x264';
        const ch = t.audio_channels ? ` ${t.audio_channels}` : '';
        const r = makeResult({
            title: `${m.title_long} ${t.quality} ${t.type === 'bluray' ? 'BluRay' : 'WEBRip'} ${codec} AAC${ch}-YTS`,
            infoHash: t.hash,
            sizeBytes: t.size_bytes,
            seeders: t.seeds,
            leechers: t.peers,
            indexer: 'yts',
            tracker: 'YTS',
            imdbId: m.imdb_code,
            publishedAt: t.date_uploaded,
        });
        r.container = 'mp4'; // YTS encodes are always MP4 — playable on iPhone
        out.push(r);
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
    const data = await fetchFromMirrors<{
      torrents_count?: number;
      torrents?: { title: string; hash: string; magnet_url: string; seeds: number; peers: number; size_bytes: string; season: string; episode: string; date_released_unix: number }[];
    }>(config.eztvUrls, `/api/get-torrents?imdb_id=${imdbNum}&limit=100`, (url) => fetchJson(url), (d: any) => d && typeof d === 'object' && 'torrents_count' in d);
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
          imdbId: q.imdbId,
          publishedAt: t.date_released_unix ? new Date(t.date_released_unix * 1000).toISOString() : undefined,
        }),
      );
  },
};

// ─── apibay (raw text search) ───────────────────────────────────────────────

const apibay: IndexerAdapter = {
  id: 'apibay',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchJson }) => eachQuery(q, async (term) => {
    // cat 200 = Video
    const data = await fetchJson<{ id: string; name: string; info_hash: string; seeders: string; leechers: string; size: string; added: string; imdb?: string }[]>(
      `${config.apibayUrl}/q.php?cat=200&q=${encodeURIComponent(term)}`,
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
          imdbId: t.imdb && /^tt\d+$/.test(t.imdb) ? t.imdb : undefined,
          publishedAt: t.added ? new Date(Number(t.added) * 1000).toISOString() : undefined,
        }),
      );
  }),
};

// ─── Knaben (meta-search across many public trackers) ──────────────────────

interface KnabenHit { title?: string; hash?: string; magnetUrl?: string; bytes?: number; seeders?: number; peers?: number; tracker?: string; date?: string }

const knaben: IndexerAdapter = {
  id: 'knaben',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchJson }) => eachQuery(q, async (term) => {
    const data = await fetchJson<{ hits?: KnabenHit[] }>(`${config.knabenUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_type: '100%', search_field: 'title', query: term, order_by: 'seeders', order_direction: 'desc',
        // 2000000 movies, 3000000 TV, 6000000 anime
        // Knaben categories (per Prowlarr): 2000000 TV, 3000000 movies, 6000000 anime.
        categories: q.type === 'movie' ? [3000000, 6000000] : q.type === 'series' ? [2000000, 6000000] : [2000000, 3000000, 6000000],
        from: 0, size: 100, hide_unsafe: true, hide_xxx: true,
      }),
    });
    return (data.hits ?? []).flatMap((h) => {
      const infoHash = (h.hash || (h.magnetUrl ? parseMagnet(h.magnetUrl)?.infoHash : '') || '').toLowerCase();
      const seeders = Number(h.seeders) || 0;
      if (!/^[a-f0-9]{40}$/.test(infoHash) || !h.title || seeders <= 0) return [];
      return [makeResult({
        title: h.title,
        infoHash,
        magnet: h.magnetUrl ? parseMagnet(h.magnetUrl)?.magnet : undefined,
        sizeBytes: Number(h.bytes) || undefined,
        seeders,
        leechers: Number(h.peers) || 0, // Knaben's `peers` already means leechers
        indexer: 'knaben',
        tracker: h.tracker,
        publishedAt: h.date,
      })];
    });
  }),
};

// ─── Torrents-CSV (open DHT-crawled index) ──────────────────────────────────

const torrentscsv: IndexerAdapter = {
  id: 'torrentscsv',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchJson }) => eachQuery(q, async (term) => {
    const data = await fetchJson<{ torrents?: { infohash: string; name: string; size_bytes: number; seeders: number; leechers: number; created_unix?: number }[] }>(
      `${config.torrentsCsvUrl}/service/search?size=50&q=${encodeURIComponent(term)}`,
    );
    return (data.torrents ?? [])
      .filter((t) => /^[a-f0-9]{40}$/i.test(t.infohash) && /\b(2160p|1080p|720p|480p|x26[45]|hevc|bluray|web|hdtv|dvdrip)\b/i.test(t.name)) // index covers all file types: keep video releases
      .map((t) =>
        makeResult({
          title: t.name,
          infoHash: t.infohash,
          sizeBytes: Number(t.size_bytes) || undefined,
          seeders: Number(t.seeders) || 0,
          leechers: Number(t.leechers) || 0,
          indexer: 'torrentscsv',
          tracker: 'Torrents-CSV',
          publishedAt: t.created_unix ? new Date(t.created_unix * 1000).toISOString() : undefined,
        }),
      );
  }),
};

// ─── Bitsearch (large general search engine; HTML results) ─────────────────

const decodeEntities = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/**
 * One result card per torrent: title, info-hash, size, seeders, leechers. Handles the current
 * layout ("torrent-result-card", hash in the download link) and the older one (magnet link,
 * "alt=Seeder" icons). Counts that wrapped below zero (4294967xxx) are treated as unknown.
 */
export function parseBitsearchHtml(html: string): TorrentResult[] {
  const count = (v?: string) => { const n = Number((v ?? '').replace(/[^\d]/g, '')); return n > 0 && n < 2 ** 31 ? n : 0; };
  const cards = html.split(/<(?:li|div)[^>]*class="[^"]*(?:torrent-result-card|search-result)[^"]*"/i).slice(1);
  return cards.flatMap((card) => {
    const magnet = /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(card)?.[1]?.replace(/&amp;/g, '&');
    const hash = /\/download\/torrent\/([a-f0-9]{40})/i.exec(card)?.[1];
    const parsed = magnet ? parseMagnet(magnet) : hash ? parseMagnet(hash) : undefined;
    if (!parsed) return [];
    const title = decodeEntities(/<h[35][^>]*>([\s\S]*?)<\/h[35]>/i.exec(card)?.[1] ?? '');
    const old = (label: string) => new RegExp(`alt="${label}"[^>]*>(?:\\s*<[^>]+>)*\\s*([^<]+)`, 'i').exec(card)?.[1];
    const swarm = (word: string) => new RegExp(`>\\s*([\\d,]+)\\s*</span>\\s*<span>\\s*${word}`, 'i').exec(card)?.[1];
    const seeders = count(swarm('seeders') ?? old('Seeders?'));
    if (!title || seeders <= 0) return [];
    const size = /fa-download"><\/i>\s*<span>([^<]+)<\/span>/i.exec(card)?.[1] ?? old('Size');
    return [makeResult({
      title,
      infoHash: parsed.infoHash,
      magnet: magnet ? parsed.magnet : undefined,
      sizeBytes: parseSize(size),
      seeders,
      leechers: count(swarm('leechers') ?? old('Leechers?')),
      indexer: 'bitsearch',
      tracker: 'Bitsearch',
    })];
  });
}

const bitsearch: IndexerAdapter = {
  id: 'bitsearch',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    // category 2 = video, sorted by seeders
    const html = await fetchText(`${config.bitsearchUrl}/search?q=${encodeURIComponent(term)}&category=2&sort=seeders`);
    const out = parseBitsearchHtml(html);
    if (!out.length && !/torrent-result|search-result|No results|no results/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    return out;
  }),
};

// ─── TorrentClaw (JSON API: aggregates public sources, with a quality score) ───
// Learned from its official qBittorrent plugin (LightDestory/qBittorrent-Search-Plugins).

interface ClawTorrent { infoHash?: string; magnetUrl?: string; rawTitle?: string; sizeBytes?: number; seeders?: number; leechers?: number }

export function parseTorrentClaw(body: { results?: { title?: string; torrents?: ClawTorrent[] }[] }): TorrentResult[] {
  return (body?.results ?? []).flatMap((c) => (c.torrents ?? []).flatMap((t) => {
    const hash = String(t.infoHash ?? (t.magnetUrl ? parseMagnet(t.magnetUrl)?.infoHash : '') ?? '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) return [];
    return [makeResult({
      title: t.rawTitle || c.title || hash,
      infoHash: hash,
      sizeBytes: Number(t.sizeBytes) || undefined,
      seeders: Number(t.seeders) || 0,
      leechers: Number(t.leechers) || 0,
      indexer: 'torrentclaw',
      tracker: 'TorrentClaw',
    })];
  }));
}

const torrentclaw: IndexerAdapter = {
  id: 'torrentclaw',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchJson }) => eachQuery(q, async (term) => {
    // Without a key it answers with titles but no info-hashes: nothing playable.
    if (!config.torrentclawKey) throw new Error('needs an API key on the relay (TORRENTCLAW_API_KEY): without one it gives no torrent links');
    const type = q.type === 'series' ? '&type=show' : q.type === 'movie' ? '&type=movie' : '';
    const body = await fetchJson<Record<string, unknown>>(`${config.torrentclawUrl}/api/v1/search?q=${encodeURIComponent(term)}&limit=50${type}`, { headers: { Authorization: `Bearer ${config.torrentclawKey}` } });
    const out = parseTorrentClaw(body as never);
    // An answer of another shape: say what it holds instead of silently finding nothing.
    if (!out.length && !Array.isArray(body?.results)) throw new Error(`unexpected answer (${Object.keys(body ?? {}).slice(0, 6).join(', ') || 'empty'})`);
    if (!out.length && Array.isArray(body.results) && body.results.length) {
      const first = (body.results as Record<string, unknown>[])[0] ?? {};
      const shape = Object.entries(first).map(([k, v]) => Array.isArray(v) ? `${k}[${v.length}]{${Object.keys((v[0] as object) ?? {}).slice(0, 40).join(' ')}}` : k).join(', ');
      throw new Error(`answer without torrents (${shape})`);
    }
    return out;
  }),
};

// ─── TorrentDownload.info (HTML; the info-hash is in each result's link) ──────

export function parseTorrentDownloadHtml(html: string): TorrentResult[] {
  const flat = html.replace(/\s+/g, ' ');
  const rows = flat.match(/<tr><td.+?tt-name.+?<\/tr>/g) ?? [];
  const num = (v?: string) => { const n = Number((v ?? '').replace(/[^\d]/g, '')); return Number.isFinite(n) ? n : 0; };
  return rows.flatMap((row) => {
    const m = /href="\/([0-9a-f]{40})\/[^"]*">(.*?)<\/a>.*?<td class="tdnormal">[^<]*<\/td>\s*<td class="tdnormal">([^<]*)<\/td>\s*<td class="tdseed">([^<]*)<\/td>\s*<td class="tdleech">([^<]*)<\/td>/i.exec(row);
    if (!m) return [];
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    if (!title) return [];
    return [makeResult({ title, infoHash: m[1], sizeBytes: parseSize(m[3]), seeders: num(m[4]), leechers: num(m[5]), indexer: 'torrentdownload', tracker: 'TorrentDownload' })];
  });
}

const torrentdownload: IndexerAdapter = {
  id: 'torrentdownload',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    const html = await fetchText(`${config.torrentdownloadUrl}/search?q=${encodeURIComponent(term).replace(/%20/g, '+')}`);
    const out = parseTorrentDownloadHtml(html);
    if (!out.length && !/tt-name|No results|did not match/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    return out;
  }),
};

// ─── TorrentGalaxy (HTML; magnet links in the results) ─────────────────────────

export function parseTorrentGalaxyHtml(html: string): TorrentResult[] {
  const rows = html.split(/<div[^>]*class="[^"]*tgxtablerow[^"]*"/i).slice(1);
  const num = (v?: string) => Number((v ?? '').replace(/[^\d]/g, '')) || 0;
  return rows.flatMap((row) => {
    const magnet = /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(row)?.[1]?.replace(/&amp;/g, '&');
    const parsed = magnet ? parseMagnet(magnet) : undefined;
    if (!parsed) return [];
    const title = decodeEntities(/<a[^>]*class="[^"]*txlight[^"]*"[^>]*title="([^"]+)"/i.exec(row)?.[1] ?? /<a[^>]*title="([^"]+)"[^>]*class="[^"]*txlight/i.exec(row)?.[1] ?? '');
    if (!title) return [];
    return [makeResult({
      title,
      infoHash: parsed.infoHash,
      magnet: parsed.magnet,
      sizeBytes: parseSize(/badge badge-secondary[^>]*>([^<]+)</i.exec(row)?.[1]),
      seeders: num(/<font color=['"]?green['"]?[^>]*>(?:<b>)?([\d,]+)/i.exec(row)?.[1]),
      leechers: num(/<font color=['"]?#ff0000['"]?[^>]*>(?:<b>)?([\d,]+)/i.exec(row)?.[1]),
      indexer: 'torrentgalaxy',
      tracker: 'TorrentGalaxy',
    })];
  });
}

const torrentgalaxy: IndexerAdapter = {
  id: 'torrentgalaxy',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    // Movies, TV and anime categories, most seeded first.
    const cats = 'c3=1&c46=1&c45=1&c42=1&c4=1&c1=1&c41=1&c5=1&c6=1&c7=1&c28=1&';
    const html = await fetchText(`${config.torrentgalaxyUrl}/torrents.php?${cats}sort=seeders&order=desc&search=${encodeURIComponent(term).replace(/%20/g, '+')}`);
    const out = parseTorrentGalaxyHtml(html);
    if (!out.length && !/tgxtable|No results/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    return out;
  }),
};

// ─── TheRARBG (HTML; the magnet is on each result's page: only the best few are opened) ─

export function parseTheRarbgList(html: string, base: string): { title: string; page: string; size?: number; seeders: number; leechers: number }[] {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? '';
  const rows = body.split(/<tr[\s>]/i).slice(1);
  const text = (c?: string) => decodeEntities((c ?? '').replace(/<[^>]+>/g, '')).trim();
  return rows.flatMap((row) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    const link = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cells[1] ?? '');
    if (!link) return [];
    const href = link[1].startsWith('http') ? link[1] : `${base}/${link[1].replace(/^\/+/, '')}`;
    const seeders = Number(text(cells[6]).replace(/[^\d]/g, '')) || 0;
    return [{ title: text(link[2]), page: href, size: parseSize(text(cells[5])), seeders, leechers: Number(text(cells[7]).replace(/[^\d]/g, '')) || 0 }];
  }).filter((r) => r.title);
}

/** How many result pages TheRARBG search may open for their magnet links. */
const THERARBG_PAGES = 6;

const therarbg: IndexerAdapter = {
  id: 'therarbg',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    const cat = q.type === 'series' ? 'category:TV:' : q.type === 'movie' ? 'category:Movies:' : '';
    const html = await fetchText(`${config.therarbgUrl}/get-posts/order:-se:${cat}keywords:${encodeURIComponent(term)}/`);
    const list = parseTheRarbgList(html, config.therarbgUrl).filter((r) => r.seeders > 0).sort((a, b) => b.seeders - a.seeders).slice(0, THERARBG_PAGES);
    if (!list.length && !/<title>Search for/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    const pages = await Promise.allSettled(list.map((r) => fetchText(r.page)));
    return list.flatMap((r, i) => {
      const p = pages[i];
      const magnet = p.status === 'fulfilled' ? /href="(magnet:\?xt=urn:btih:[^"]+)"/i.exec(p.value)?.[1]?.replace(/&amp;/g, '&') : undefined;
      const parsed = magnet ? parseMagnet(magnet) : undefined;
      if (!parsed) return [];
      return [makeResult({ title: r.title, infoHash: parsed.infoHash, magnet: parsed.magnet, sizeBytes: r.size, seeders: r.seeders, leechers: r.leechers, indexer: 'therarbg', tracker: 'TheRARBG' })];
    });
  }),
};

// ─── Kickass Torrents (HTML; like TheRARBG, the magnet is on each result's page) ─

export function parseKickassList(html: string, base: string): { title: string; page: string; size?: number; seeders: number; leechers: number }[] {
  const clean = html.replace(/<strong[^>]*>|<\/strong>/g, '');
  const rows = clean.match(/<tr class="(?:odd|even)"\s*>[\s\S]*?<\/tr>/g) ?? [];
  return rows.flatMap((tr) => {
    const m = /<div class="torrentname">[\s\S]*?<a href="([^"]+)"\s+class="cellMainLink">\s*([\s\S]*?)\s*<\/a>[\s\S]*?<td[^>]*>\s*([\d.]+\s*(?:TB|GB|MB|KB))\s*<\/td>[\s\S]*?<td class="green center">\s*([\d,]+)\s*<\/td>[\s\S]*?<td class="red lasttd center">\s*([\d,]+)\s*<\/td>/.exec(tr);
    if (!m) return [];
    const page = m[1].startsWith('http') ? m[1] : `${base}/${m[1].replace(/^\/+/, '')}`;
    return [{ title: decodeEntities(m[2]), page, size: parseSize(m[3]), seeders: Number(m[4].replace(/,/g, '')) || 0, leechers: Number(m[5].replace(/,/g, '')) || 0 }];
  }).filter((r) => r.title);
}

const kickass: IndexerAdapter = {
  id: 'kickass',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    const cat = q.type === 'series' ? 'category/tv/' : q.type === 'movie' ? 'category/movies/' : '';
    const html = await fetchText(`${config.kickassUrl}/search/${encodeURIComponent(term)}/${cat}`);
    const list = parseKickassList(html, config.kickassUrl).filter((r) => r.seeders > 0).sort((a, b) => b.seeders - a.seeders).slice(0, THERARBG_PAGES);
    if (!list.length && !/torrentname|Nothing found|no results/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    const pages = await Promise.allSettled(list.map((r) => fetchText(r.page)));
    return list.flatMap((r, i) => {
      const p = pages[i];
      const magnet = p.status === 'fulfilled' ? /"(magnet:\?xt=urn:btih:[^"]+)"/i.exec(p.value)?.[1]?.replace(/&amp;/g, '&') : undefined;
      const parsed = magnet ? parseMagnet(magnet) : undefined;
      if (!parsed) return [];
      return [makeResult({ title: r.title, infoHash: parsed.infoHash, magnet: parsed.magnet, sizeBytes: r.size, seeders: r.seeders, leechers: r.leechers, indexer: 'kickass', tracker: 'Kickass' })];
    });
  }),
};

// ─── LimeTorrents (HTML table; the hash is in the row's .torrent link, else on its page) ─

export function parseLimeTorrentsList(html: string, base: string): { title: string; page: string; hash?: string; size?: number; seeders: number; leechers: number }[] {
  const table = /class="table2"[\s\S]*?<\/table>/i.exec(html)?.[0] ?? '';
  const rows = table.match(/<tr[^>]*bgcolor="#(?:F4F4F4|FFFFFF)"[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  const text = (c?: string) => decodeEntities((c ?? '').replace(/<[^>]+>/g, '')).trim();
  return rows.flatMap((row) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    const page = [...(cells[0] ?? '').matchAll(/<a[^>]*href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi)].pop();
    if (!page) return [];
    const hash = /\/torrent\/([a-f0-9]{40})\.torrent/i.exec(cells[0] ?? '')?.[1]?.toLowerCase();
    const num = (c?: string) => Number(text(c).replace(/[^\d]/g, '')) || 0;
    return [{ title: text(page[2]), page: page[1].startsWith('http') ? page[1] : `${base}${page[1].startsWith('/') ? '' : '/'}${page[1]}`, hash, size: parseSize(text(cells[2])), seeders: num(cells[3]), leechers: num(cells[4]) }];
  }).filter((r) => r.title);
}

const limetorrents: IndexerAdapter = {
  id: 'limetorrents',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    const cat = q.type === 'series' ? 'tv' : q.type === 'movie' ? 'movies' : 'all';
    const html = await fetchText(`${config.limetorrentsUrl}/search/${cat}/${encodeURIComponent(term)}/seeds/1/`);
    const list = parseLimeTorrentsList(html, config.limetorrentsUrl).filter((r) => r.seeders > 0).sort((a, b) => b.seeders - a.seeders);
    if (!list.length && !/table2|No results|not found/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    // Rows that carry their hash need nothing more; the others: open the best few pages.
    const withHash = list.filter((r) => r.hash);
    const open = list.filter((r) => !r.hash).slice(0, THERARBG_PAGES);
    const pages = await Promise.allSettled(open.map((r) => fetchText(r.page)));
    const opened = open.map((r, i) => {
      const p = pages[i];
      const magnet = p.status === 'fulfilled' ? /href\s*=\s*"(magnet:\?xt=urn:btih:[^"]+)"/i.exec(p.value)?.[1]?.replace(/&amp;/g, '&') : undefined;
      return { ...r, hash: magnet ? parseMagnet(magnet)?.infoHash : undefined };
    });
    return [...withHash, ...opened].flatMap((r) => (r.hash ? [makeResult({ title: r.title, infoHash: r.hash, sizeBytes: r.size, seeders: r.seeders, leechers: r.leechers, indexer: 'limetorrents', tracker: 'LimeTorrents' })] : []));
  }),
};

// ─── GloTorrents (HTML; magnet links in the results) ──────────────────────────

export function parseGloTorrentsHtml(html: string): TorrentResult[] {
  const flat = html.replace(/\s+/g, ' ');
  const re = /title="(.+?)".+?href="(.+?)".+?<\/a>.+?align='center'>.+?href="(magnet:.*?)".+?([0-9,.]+ (?:TB|GB|MB|KB)).+?<font color='green'><b>([0-9,]+)<\/b>.+?<font color='#[0-9a-zA-Z]{6}'><b>([0-9,]+)<\/b>/g;
  const out: TorrentResult[] = [];
  for (const m of flat.matchAll(re)) {
    const parsed = parseMagnet(m[3].replace(/&amp;/g, '&'));
    if (!parsed) continue;
    out.push(makeResult({ title: decodeEntities(m[1]), infoHash: parsed.infoHash, magnet: parsed.magnet, sizeBytes: parseSize(m[4]), seeders: Number(m[5].replace(/,/g, '')) || 0, leechers: Number(m[6].replace(/,/g, '')) || 0, indexer: 'glotorrents', tracker: 'GloTorrents' }));
  }
  return out;
}

const glotorrents: IndexerAdapter = {
  id: 'glotorrents',
  supports: (q) => !!textQueryFor(q),
  search: (q, { config, fetchText }) => eachQuery(q, async (term) => {
    // cat 1 = movies, 41 = TV (its own ids); 0 = all.
    const cat = q.type === 'series' ? 41 : q.type === 'movie' ? 1 : 0;
    const html = await fetchText(`${config.glotorrentsUrl}/search_results.php?search=${encodeURIComponent(term).replace(/%20/g, '+')}&cat=${cat}&sort=seeders&order=desc&page=0&incldead=0&inclexternal=0`);
    const out = parseGloTorrentsHtml(html);
    if (!out.length && !/search_results|ttable|No torrents|Nothing found/i.test(html)) throw new Error('unexpected page (the site may have changed)');
    return out;
  }),
};

// ─── Nyaa (anime, RSS) ──────────────────────────────────────────────────────

/** Parse a Nyaa RSS feed (nyaa:infoHash / nyaa:seeders / nyaa:size extensions). */
export function parseNyaaRss(body: string): TorrentResult[] {
  const items: any[] = xml.parse(body)?.rss?.channel?.item ?? [];
  return items.flatMap((it) => {
    const infoHash = String(it['nyaa:infoHash'] ?? '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) return [];
    return [makeResult({
      title: String(it.title ?? infoHash),
      infoHash,
      sizeBytes: parseSize(String(it['nyaa:size'] ?? '')),
      seeders: Number(it['nyaa:seeders']) || 0,
      leechers: Number(it['nyaa:leechers']) || 0,
      indexer: 'nyaa',
      tracker: 'Nyaa',
      publishedAt: it.pubDate,
    })];
  });
}

const nyaa: IndexerAdapter = {
  id: 'nyaa',
  // Anime lives under "series"; plain movie lookups by id would only add noise.
  supports: (q) => !!textQueryFor(q) && !(q.imdbId && q.type === 'movie'),
  async search(q, { config, fetchText }) {
    // Anime releases are named "Title - 07", not "Title S01E07".
    const ep = q.absEpisode ?? q.episode;
    const term = q.q?.trim() || (q.title && ep != null ? `${q.title} ${String(ep).padStart(2, '0')}` : textQueryFor(q)!);
    // c=1_2: Anime, English-translated. f=0: no filter.
    return parseNyaaRss(await fetchText(`${config.nyaaUrl}/?page=rss&c=1_2&f=0&q=${encodeURIComponent(term)}`));
  },
};

// ─── AnimeTosho (anime; public Torznab feed, per Prowlarr's definition) ───────

const animetosho: IndexerAdapter = {
  id: 'animetosho',
  supports: (q) => !!textQueryFor(q) && !(q.imdbId && q.type === 'movie'),
  async search(q, { config, fetchText }) {
    // Anime releases are named "Title - 07", not "Title S01E07".
    const ep = q.absEpisode ?? q.episode;
    const term = q.q?.trim() || (q.title && ep != null ? `${q.title} ${String(ep).padStart(2, '0')}` : textQueryFor(q)!);
    const xmlBody = await fetchText(`${config.animetoshoUrl}/api/torznab?t=search&limit=100&q=${encodeURIComponent(term)}`);
    return parseTorznabXml(xmlBody, 'animetosho').filter((r) => r.seeders > 0);
  },
};

// ─── Internet Archive (free, legal direct links: public-domain and openly licensed films) ─

export interface IaFile { name: string; format?: string; size?: string; height?: string; length?: string; source?: string }

/** "01:32:10", "5530.2" → seconds */
const iaSeconds = (len?: string) => {
  if (!len) return undefined;
  if (len.includes(':')) return len.split(':').reduce((t, x) => t * 60 + Number(x), 0);
  return Number(len) || undefined;
};

/** Best browser-playable video file of an item: MP4/H.264, highest resolution, not a trailer. */
export function pickArchiveFile(files: IaFile[], minSeconds = 600): IaFile | undefined {
  const videos = files.filter((f) => /\.(mp4|m4v)$/i.test(f.name) && !/(trailer|sample|preview)/i.test(f.name) && (iaSeconds(f.length) ?? 9999) >= minSeconds);
  return videos.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0) || (Number(b.size) || 0) - (Number(a.size) || 0))[0];
}

const archive: IndexerAdapter = {
  id: 'archive',
  supports: (q) => q.type !== 'series' && !!(q.q?.trim() || q.title),
  async search(q, { config, fetchJson }) {
    const text = (q.q?.trim() || q.title!).replace(/["()]/g, ' ').trim();
    const parts = [`title:(${text})`, 'mediatype:(movies)'];
    if (q.year && !q.q) parts.push(`year:[${q.year - 1} TO ${q.year + 1}]`);
    const query = q.imdbId && !q.q ? `(external-identifier:"urn:imdb:${q.imdbId}" OR (${parts.join(' AND ')}))` : parts.join(' AND ');
    const search = await fetchJson<{ response?: { docs?: { identifier: string; title?: string; year?: string | number }[] } }>(
      `${config.archiveUrl}/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=year&sort[]=downloads+desc&rows=6&output=json`,
    );
    const docs = search.response?.docs ?? [];
    const items = await Promise.allSettled(
      docs.slice(0, 5).map((d) => fetchJson<{ files?: IaFile[]; metadata?: { title?: string; year?: string } }>(`${config.archiveUrl}/metadata/${encodeURIComponent(d.identifier)}`).then((m) => ({ d, m }))),
    );
    return items.flatMap((it) => {
      if (it.status !== 'fulfilled') return [];
      const { d, m } = it.value;
      const file = pickArchiveFile(m.files ?? []);
      if (!file) return [];
      const height = Number(file.height) || 0;
      const year = m.metadata?.year ?? d.year;
      const quality = height >= 1500 ? '4K' : height >= 1000 ? '1080p' : height >= 700 ? '720p' : height ? 'SD' : undefined;
      const url = `${config.archiveUrl}/download/${encodeURIComponent(d.identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`;
      return [makeDirectResult({
        title: `${m.metadata?.title ?? d.title ?? d.identifier}${year ? ` (${String(year).slice(0, 4)})` : ''}${height ? ` ${height}p` : ''}`,
        url,
        fileName: file.name.split('/').pop(),
        sizeBytes: Number(file.size) || undefined,
        indexer: 'archive',
        tracker: 'Internet Archive',
        imdbId: q.imdbId,
        quality,
      })];
    });
  },
};

const ADAPTERS: Record<IndexerId, IndexerAdapter> = { torrentio, torznab, yts, eztv, apibay, knaben, torrentscsv, nyaa, animetosho, mediafusion, addons, archive, torrentsdb, bitsearch, torrentclaw, torrentdownload, torrentgalaxy, therarbg, kickass, limetorrents, glotorrents };

// ─── Merge / sort ───────────────────────────────────────────────────────────

/** Merge duplicates (same info-hash from several sources), keeping the richest record. */
/**
 * An anime numbered straight through (One Piece, Bleach) is never released with season numbers or
 * a different year in the name: such a release is another show of the same name (One Piece's
 * 2023 live-action series), which the sources file under the anime too.
 */
export function anotherShow(r: TorrentResult, q: SearchQuery): boolean {
  if (!q.kitsu) return false;
  if (q.kitsu.straight) {
    if (r.year != null && q.year != null && Math.abs(r.year - q.year) > 1) return true;
    if (r.season != null && r.season >= 2) return true;
  }
  // Anime name their season in words ("Sousou no Frieren 2nd Season - 05"): another season is another episode.
  if (!q.kitsu.straight && q.season != null) {
    const said = r.title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|\bseason\s+(\d{1,2})\b(?!\s*(?:-|~|to)\s*\d)/i);
    if (said && Number(said[1] ?? said[2]) !== q.season) return true;
  }
  // Anime names carry the episode: "Title - 1180", or a range "001-574". One that doesn't include
  // the episode asked for is a different episode (text searches find neighbours by number).
  const ep = q.kitsu.episode;
  // (Season ranges — "S01-04", "Seasons 1-4" — aren't episodes.)
  const name = r.title.replace(/\[[0-9A-F]{8}\]|\b(?:480|576|720|1080|2160)p\b|\bx26[45]\b|\b(?:19|20)\d\d\b|\bseasons?\s*\d+\s*(?:-|~|to)\s*\d+|\bS\d+\s*-\s*S?\d+/gi, ' ');
  const ranges = [...name.matchAll(/(?<![\d.A-Za-z])(\d{1,4})\s*(?:-|~|to)\s*(\d{1,4})(?![\d.])/gi)].map((m) => [Number(m[1]), Number(m[2])]).filter(([a, b]) => b > a);
  if (ranges.length) return !ranges.some(([a, b]) => ep >= a && ep <= b);
  const single = name.match(/\s-\s(\d{1,4})(?:v\d)?(?=[\s.\[(]|$)/);
  return single ? Number(single[1]) !== ep : false;
}

/** Adult releases are never shown (text searches match them on a shared word). */
export function adultRelease(title: string): boolean {
  return /\b(?:xxx|porn|nubiles|brazzers|onlyfans|bangbros|realitykings|naughtyamerica)\b/i.test(title) && !/xander\s+cage/i.test(title);
}

export function mergeResults(results: TorrentResult[]): TorrentResult[] {
  const byHash = new Map<string, TorrentResult>();
  for (const r of results) {
    const key = r.infoHash || r.id; // direct links have no info-hash
    const prev = byHash.get(key);
    if (!prev) { byHash.set(key, r); continue; }
    const trackers = new Set([prev.tracker, r.tracker].flatMap((t) => (t ? t.split(', ') : [])));
    byHash.set(key, {
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
    const once = () =>
      fetch(url, {
        ...init,
        headers: { ...serverOnlyHeaders({ 'User-Agent': UA }), Accept: 'application/json, application/xml;q=0.9, */*;q=0.8', ...init?.headers },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    let res = await once();
    // Rate limited (common for shared cloud IPs): wait briefly and try once more.
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(2500, Math.max(500, Number(res.headers.get('retry-after')) * 1000 || 1200));
      await new Promise((r) => setTimeout(r, wait));
      res = await once();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  const ctx: Ctx = {
    config,
    // Only keyless JSON indexers (Torrentio, YTS, EZTV, apibay) use fetchJson, so they may fall back to
    // public relays. Torznab uses fetchText: its URL carries an API key and must never be relayed.
    fetchJson: async (url, init) => {
      const direct = async () => (await fetchWithTimeout(url, init)).json();
      return isBrowser && config.publicRelays && !init?.method ? fetchJsonWithRelays(url, direct, { timeoutMs: config.timeoutMs }) : direct();
    },
    fetchText: async (url, init) => (await fetchWithTimeout(url, init)).text(),
  };

  const active = config.enabled.map((id) => ADAPTERS[id]).filter((a) => a.supports(q, config));
  const settled = await Promise.allSettled(active.map((a) => a.search(q, ctx)));

  const errors: IndexerError[] = [];
  const all: TorrentResult[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') all.push(...s.value);
    else errors.push({ indexer: active[i].id, message: describeError(s.reason) });
  });

  const results = sortBySeeders(mergeResults(all).filter((r) => matchesEpisode(r, q) && !anotherShow(r, q) && !adultRelease(r.title)));
  return { query: q, results, errors, tookMs: Date.now() - started };
}
