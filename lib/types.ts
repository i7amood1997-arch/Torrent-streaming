/** Shared domain types used by both server routes and client components. */

export type QualityTier = '4K' | '1080p' | '720p' | 'SD' | 'Unknown';

export type MediaType = 'movie' | 'series';

export interface ParsedRelease {
  quality: QualityTier;
  /** Raw resolution token as found in the title, e.g. "2160p". */
  resolution?: string;
  hdr: string[]; // e.g. ["HDR10", "DV"]
  remux: boolean;
  source?: string; // BluRay, WEB-DL, WEBRip, HDTV...
  videoCodec?: string; // x264, x265, AV1
  audio: string[]; // AAC, AC3, DDP, DTS-HD, TrueHD, Atmos
  channels?: string; // 2.0, 5.1, 7.1
  releaseGroup?: string;
  /** File container when it can be told from the name (mp4, mkv, avi…). iPhone Safari only plays mp4/m4v/mov. */
  container?: string;
  season?: number;
  episode?: number;
  year?: number;
}

export interface TorrentResult extends ParsedRelease {
  /** Stable id = lowercase infoHash (+ fileIdx when a specific file is targeted). */
  id: string;
  title: string;
  infoHash: string;
  magnet: string;
  /** For multi-file packs: index of the file to play (Torrentio provides this). */
  fileIdx?: number;
  fileName?: string;
  sizeBytes?: number;
  seeders: number;
  leechers: number;
  /** Which of our indexer adapters produced it (torrentio, torznab, yts...). */
  indexer: string;
  /** The upstream tracker/site name when known (1337x, TGx, YTS...). */
  tracker?: string;
  publishedAt?: string;
  /** IMDB id when the indexer knows it (lets subtitles work for raw search results). */
  imdbId?: string;
  /** Direct (HTTP) link instead of a torrent: no seeders involved. infoHash/magnet are empty. */
  url?: string;
  /** Request headers the host requires (Stremio `proxyHeaders`); such links play through the relay. */
  headers?: Record<string, string>;
  /** The add-on says browsers can't play this link as-is (e.g. MKV, or needs headers). */
  notWebReady?: boolean;
}

export interface IndexerError {
  indexer: string;
  message: string;
}

export interface SearchResponse {
  query: SearchQuery;
  results: TorrentResult[];
  errors: IndexerError[];
  tookMs: number;
}

export interface SearchQuery {
  /** Raw free-text query (Direct Torrent Search). */
  q?: string;
  imdbId?: string;
  tmdbId?: number;
  type?: MediaType;
  season?: number;
  episode?: number;
  /** Title + year to help text-only indexers when searching by id. */
  title?: string;
  year?: number;
}

export type DebridProvider = 'realdebrid' | 'torbox' | 'debridlink';

export type StreamEngine = 'debrid' | 'webtorrent' | 'direct';

export interface ResolvedStream {
  status: 'ready' | 'queued' | 'error';
  url?: string;
  /** HLS rendition (Real-Debrid transcoding) — preferred on iOS for MKV/HEVC. */
  hlsUrl?: string;
  fileName?: string;
  mimeType?: string;
  /** 0–100 when the debrid service is still caching the torrent. */
  progress?: number;
  message?: string;
  provider?: DebridProvider;
}

export interface SubtitleCue {
  start: number; // seconds
  end: number; // seconds
  text: string; // may contain \n
}

export interface SubtitleTrackInfo {
  id: string;
  provider: 'opensubtitles' | 'subdl' | 'local' | 'embedded' | 'translated' | 'generated';
  lang: 'ar' | 'en' | string;
  label: string;
  releaseName?: string;
  downloads?: number;
  hearingImpaired?: boolean;
  /** Matched by file hash: timed for this exact video file. */
  hashMatch?: boolean;
  /** 0..1 similarity to the playing release name, used for auto-selection. */
  score?: number;
  /** Translated/generated tracks: the language the text came from. */
  sourceLang?: string;
  /** Opaque token passed back to /api/subtitles/file. */
  token: string;
}

export interface TmdbItem {
  id: number;
  type: MediaType;
  title: string;
  originalTitle?: string;
  overview: string;
  year?: number;
  posterPath?: string | null;
  backdropPath?: string | null;
  rating?: number;
  imdbId?: string;
  /** Where the item came from. With 'cinemeta', `id` is derived from the IMDB id, not a TMDB id. */
  source?: 'tmdb' | 'cinemeta';
}

export interface TmdbDetails extends TmdbItem {
  runtime?: number;
  genres: string[];
  seasons?: { seasonNumber: number; name: string; episodeCount: number }[];
}

export interface TmdbEpisode {
  episodeNumber: number;
  name: string;
  overview: string;
  stillPath?: string | null;
  airDate?: string;
}
