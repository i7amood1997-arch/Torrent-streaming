import type { ParsedRelease, QualityTier } from './types';

/**
 * Parses scene/P2P release names, e.g.
 *   "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-FGT"
 * into structured metadata used for quality pills and the stats row.
 *
 * The parser is intentionally regex-based and dependency-free so it can run
 * on both the server (indexer normalisation) and the client (local filters).
 */

const norm = (s: string) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

export function parseQuality(title: string): { quality: QualityTier; resolution?: string } {
  const t = title.toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(t)) return { quality: '4K', resolution: /2160p/.test(t) ? '2160p' : '4K' };
  if (/\b1080[pi]\b/.test(t)) return { quality: '1080p', resolution: '1080p' };
  if (/\b720p\b/.test(t)) return { quality: '720p', resolution: '720p' };
  const sd = t.match(/\b(576p|480p|360p|dvdrip|dvdscr|sdtv|xvid|cam|hdcam|telesync|ts)\b/);
  if (sd) return { quality: 'SD', resolution: sd[1] };
  return { quality: 'Unknown' };
}

export function parseRelease(rawTitle: string): ParsedRelease {
  const title = norm(rawTitle);
  const t = ` ${title.toLowerCase()} `;
  const { quality, resolution } = parseQuality(title);

  const hdr: string[] = [];
  if (/\b(dv|dovi|dolby ?vision)\b/.test(t)) hdr.push('DV');
  if (/\bhdr10(\+|plus)/.test(t)) hdr.push('HDR10+');
  else if (/\bhdr10\b/.test(t)) hdr.push('HDR10');
  else if (/\bhdr\b/.test(t)) hdr.push('HDR');
  if (/\bhlg\b/.test(t)) hdr.push('HLG');

  const remux = /\bremux\b/.test(t);

  let source: string | undefined;
  const sources: [RegExp, string][] = [
    [/\b(blu ?ray|bdremux|bd ?rip|brrip|bdrip)\b/, 'BluRay'],
    [/\bweb[ -]?dl\b/, 'WEB-DL'],
    [/\bweb[ -]?rip\b/, 'WEBRip'],
    [/\bweb\b/, 'WEB'],
    [/\bhd[ -]?rip\b/, 'HDRip'],
    [/\bhdtv\b/, 'HDTV'],
    [/\bdvd ?rip\b/, 'DVDRip'],
    [/\b(hdcam|cam|telesync|hdts)\b/, 'CAM'],
  ];
  for (const [re, name] of sources) if (re.test(t)) { source = name; break; }
  if (remux && source === 'BluRay') source = 'BluRay REMUX';

  let videoCodec: string | undefined;
  if (/\b(x265|h ?265|hevc)\b/.test(t)) videoCodec = 'HEVC';
  else if (/\b(x264|h ?264|avc)\b/.test(t)) videoCodec = 'H.264';
  else if (/\bav1\b/.test(t)) videoCodec = 'AV1';
  else if (/\bxvid\b/.test(t)) videoCodec = 'XviD';

  const audio: string[] = [];
  // `(?![a-z])` instead of `\b` so tokens glued to channel counts (DDP5.1, AAC2.0, DD5.1) still match.
  const audioMap: [RegExp, string][] = [
    [/\btrue ?hd(?![a-z])/, 'TrueHD'],
    [/\batmos\b/, 'Atmos'],
    [/\bdts[ -]?(hd|x|ma)(?![a-z])/, 'DTS-HD'],
    [/\bdts(?![a-z])/, 'DTS'],
    [/\b(ddp|dd\+|e ?ac ?3|eac3)(?![a-z])/, 'DDP'],
    [/\b(ac3|dd)(?![a-z+])/, 'AC3'],
    [/\baac(?![a-z])/, 'AAC'],
    [/\bflac(?![a-z])/, 'FLAC'],
    [/\bopus\b/, 'Opus'],
    [/\bmp3\b/, 'MP3'],
  ];
  for (const [re, name] of audioMap) {
    if (re.test(t) && !(name === 'DTS' && audio.includes('DTS-HD'))) audio.push(name);
  }
  // Channel layout: "5.1", "7.1", "DDP5 1", "AAC2.0" (dots were normalised to spaces)
  const ch = t.match(/(?:\b|[a-z])([257])[ .]([01])\b/);
  const channels = ch ? `${ch[1]}.${ch[2]}` : undefined;

  // Release group: trailing "-GROUP" (ignore file extension / bracketed site tags)
  let releaseGroup: string | undefined;
  const g = rawTitle
    .replace(/\.(mkv|mp4|avi|m4v|webm)$/i, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .match(/-([A-Za-z0-9][A-Za-z0-9_]{1,24})$/);
  if (g && !/^(dl|rip|hd|x264|x265|hevc)$/i.test(g[1])) releaseGroup = g[1];

  let season: number | undefined;
  let episode: number | undefined;
  const se = t.match(/\bs(\d{1,2}) ?e(\d{1,3})\b/) || t.match(/\b(\d{1,2})x(\d{2,3})\b/);
  if (se) { season = +se[1]; episode = +se[2]; }
  else {
    const s = t.match(/\b(?:s|season )(\d{1,2})\b/);
    if (s) season = +s[1];
  }

  const y = t.match(/\b(19[2-9]\d|20[0-4]\d)\b/);
  const year = y ? +y[1] : undefined;

  return { quality, resolution, hdr, remux, source, videoCodec, audio, channels, releaseGroup, season, episode, year };
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** "1.4 GB", "700MB", "2,3 GiB" -> bytes */
export function parseSize(input: string | undefined | null): number | undefined {
  if (!input) return undefined;
  const m = String(input).replace(',', '.').match(/([\d.]+)\s*([kmgt]?i?b)\b/i);
  if (!m) return undefined;
  const unit = m[2].toLowerCase().replace('i', '');
  const mult = UNITS[unit];
  return mult ? Math.round(parseFloat(m[1]) * mult) : undefined;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i < 2 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

export const QUALITY_ORDER: QualityTier[] = ['4K', '1080p', '720p', 'SD', 'Unknown'];

export function qualityLabel(q: QualityTier): string {
  switch (q) {
    case '4K': return '4K UHD';
    case '1080p': return '1080p FHD';
    case '720p': return '720p HD';
    case 'SD': return 'SD';
    default: return 'Unknown';
  }
}
