/**
 * Magnet / info-hash helpers. Accepts:
 *  - full magnet URIs (hex or base32 btih)
 *  - bare 40-char hex info hashes
 *  - bare 32-char base32 info hashes
 */

export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  // WebRTC trackers — required for in-browser WebTorrent peers
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
];

export interface ParsedMagnet {
  infoHash: string; // lowercase hex
  name?: string;
  trackers: string[];
  magnet: string; // normalised magnet URI
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32ToHex(b32: string): string {
  let bits = '';
  for (const c of b32.toUpperCase()) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error('Invalid base32 character');
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

function normaliseHash(h: string): string | null {
  const s = h.trim();
  if (/^[a-f0-9]{40}$/i.test(s)) return s.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(s)) return base32ToHex(s);
  return null;
}

export function buildMagnet(infoHash: string, name?: string, trackers: string[] = DEFAULT_TRACKERS): string {
  const parts = [`xt=urn:btih:${infoHash.toLowerCase()}`];
  if (name) parts.push(`dn=${encodeURIComponent(name)}`);
  for (const tr of trackers) parts.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${parts.join('&')}`;
}

export function parseMagnet(input: string): ParsedMagnet | null {
  const raw = input.trim();
  if (!raw) return null;

  const bare = normaliseHash(raw);
  if (bare) return { infoHash: bare, trackers: DEFAULT_TRACKERS, magnet: buildMagnet(bare) };

  if (!/^magnet:\?/i.test(raw)) return null;
  const params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
  let infoHash: string | null = null;
  for (const xt of params.getAll('xt')) {
    const m = xt.match(/^urn:btih:(.+)$/i);
    if (m) { infoHash = normaliseHash(m[1]); if (infoHash) break; }
  }
  if (!infoHash) return null;
  const name = params.get('dn') ?? undefined;
  const given = params.getAll('tr');
  const trackers = Array.from(new Set([...given, ...DEFAULT_TRACKERS]));
  return { infoHash, name, trackers, magnet: buildMagnet(infoHash, name, trackers) };
}

export function isMagnetLike(input: string): boolean {
  return parseMagnet(input) !== null;
}
