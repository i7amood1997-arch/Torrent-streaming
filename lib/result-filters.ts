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
