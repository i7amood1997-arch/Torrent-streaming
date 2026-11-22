/** Pure client-side filtering/sorting for the Direct Torrent Search UI. */
import { QUALITY_ORDER } from './release-parser';
import type { QualityTier, TorrentResult } from './types';

export type SortKey = 'seeders' | 'size' | 'quality' | 'date';

export interface ResultFilters {
  qualities: QualityTier[]; // empty = all
  minSeeders: number;
  text: string; // matches title / release group / tracker
  hdrOnly: boolean;
  hideCam: boolean;
  maxSizeGb?: number;
  sort: SortKey;
}

export const DEFAULT_FILTERS: ResultFilters = { qualities: [], minSeeders: 0, text: '', hdrOnly: false, hideCam: true, sort: 'seeders' };

export function applyFilters(results: TorrentResult[], f: ResultFilters): TorrentResult[] {
  const needle = f.text.trim().toLowerCase();
  const maxBytes = f.maxSizeGb ? f.maxSizeGb * 1024 ** 3 : undefined;
  const filtered = results.filter(
    (r) =>
      (!f.qualities.length || f.qualities.includes(r.quality)) &&
      (!!r.url || r.seeders >= f.minSeeders) && // direct links have no seeders
      (!f.hdrOnly || r.hdr.length > 0) &&
      (!f.hideCam || r.source !== 'CAM') &&
      (!maxBytes || !r.sizeBytes || r.sizeBytes <= maxBytes) &&
      (!needle || `${r.title} ${r.fileName ?? ''} ${r.releaseGroup ?? ''} ${r.tracker ?? ''}`.toLowerCase().includes(needle)),
  );
  const cmp: Record<SortKey, (a: TorrentResult, b: TorrentResult) => number> = {
    seeders: (a, b) => b.seeders - a.seeders,
    size: (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
    quality: (a, b) => QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality) || b.seeders - a.seeders,
    date: (a, b) => Date.parse(b.publishedAt ?? '0') - Date.parse(a.publishedAt ?? '0'),
  };
  return filtered.sort(cmp[f.sort]);
}

export function countByQuality(results: TorrentResult[]): Record<QualityTier, number> {
  const out = { '4K': 0, '1080p': 0, '720p': 0, SD: 0, Unknown: 0 } as Record<QualityTier, number>;
  for (const r of results) out[r.quality]++;
  return out;
}

/**
 * The stream a "Play" button should start: good quality that will actually play smoothly.
 * 1080p first (4K only with a Debrid account, which has the bandwidth), healthy seeders,
 * MP4 preferred on devices that can't open MKV directly; direct links beat torrents.
 */
export interface PickOptions {
  debrid?: boolean;
  preferMp4?: boolean;
  audioOk?: (audio: string[] | undefined) => boolean;
  /** Debrid cache check by result id: 'instant' starts at once, 'not' has to be fetched first. */
  cache?: Record<string, 'instant' | 'not' | 'unknown'>;
  /** The quality played last for this series: its next episode leans the same way. */
  preferQuality?: string;
}

export function pickBest(results: TorrentResult[], opts: PickOptions = {}): TorrentResult | undefined {
  return rankResults(results, opts)[0];
}

/** Results in the order Play would choose them (filters applied). */
export function rankResults(results: TorrentResult[], opts: PickOptions = {}): TorrentResult[] {
  const tier: Record<string, number> = { '4K': opts.debrid ? 3.2 : 1.2, '1080p': 3, '720p': 2, SD: 0.8, Unknown: 0.5 };
  const score = (r: TorrentResult) => {
    const c = (r.container ?? r.fileName?.split('.').pop() ?? '').toLowerCase();
    return (
      (tier[r.quality] ?? 0.5) +
      // Direct links start instantly and don't depend on seeders: they win ties.
      (r.url ? 2.3 : Math.min(2, Math.log10(r.seeders + 1) * 0.7) - (r.seeders < 3 ? 2 : 0)) +
      (opts.preferMp4 && ['mp4', 'm4v', 'mov'].includes(c) ? 0.6 : 0) -
      (opts.audioOk && !opts.audioOk(r.audio) ? (opts.debrid ? 0.4 : 1.5) : 0) - // silent here (Debrid's HLS copy can fix it)
      (r.remux ? 0.8 : 0) - // huge files
      ((r.sizeBytes ?? 0) > 25e9 ? 0.6 : 0) +
      // Ready on the debrid service: starts at once (a level of quality is worth less than that).
      (opts.cache?.[r.id] === 'instant' ? 2.5 : opts.cache?.[r.id] === 'not' ? -1.5 : 0) +
      (opts.preferQuality && r.quality === opts.preferQuality ? 1.1 : 0)
    );
  };
  return applyFilters(results, DEFAULT_FILTERS).map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s).map((x) => x.r);
}
