/**
 * HTTP(S) tracker announce (BEP 3 / BEP 23 compact peers).
 * UDP trackers and DHT are unavailable in Cloudflare Workers, so peers come
 * from HTTP trackers plus peer exchange (PEX) with connected peers.
 */
import { bdecode, bdict, bnum, bstr } from './bencode';

export interface PeerAddr {
  host: string;
  port: number;
}

/** Public trackers that serve HTTP(S) announces. Extend with the BT_TRACKERS variable (comma-separated). */
export const DEFAULT_HTTP_TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'http://open.stealth.si:80/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.bt4g.com:2095/announce',
  'http://open.tracker.cl:1337/announce',
  'http://tracker.files.fm:6969/announce',
  'http://tracker.dler.org:6969/announce',
  'https://tracker.lilithraws.org:443/announce',
  'http://bt.endpot.com:80/announce',
  'http://tracker.renfei.net:8080/announce',
];

const pct = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += '%' + b[i].toString(16).padStart(2, '0');
  return s;
};

export function parseCompactPeers(b: Uint8Array): PeerAddr[] {
  const out: PeerAddr[] = [];
  for (let i = 0; i + 6 <= b.length; i += 6) {
    const port = (b[i + 4] << 8) | b[i + 5];
    if (port) out.push({ host: `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`, port });
  }
  return out;
}

/**
 * Trackers to try for a magnet: its http(s) trackers, the defaults, and an
 * http:// guess for each udp:// tracker (many serve both on the same port).
 */
export function trackerList(magnetTrackers: string[], extra: string[] = []): string[] {
  const out: string[] = [];
  const add = (u: string) => { if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
  magnetTrackers.forEach(add);
  extra.forEach(add);
  DEFAULT_HTTP_TRACKERS.forEach(add);
  for (const t of magnetTrackers) {
    const m = t.match(/^udp:\/\/([^/]+)(\/.*)?$/i);
    if (m) add(`http://${m[1]}${m[2] && m[2] !== '/' ? m[2] : '/announce'}`);
  }
  return out;
}

export async function announce(
  url: string,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  left: number,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 7000,
): Promise<PeerAddr[]> {
  const q = `info_hash=${pct(infoHash)}&peer_id=${pct(peerId)}&port=6881&uploaded=0&downloaded=0&left=${left}&compact=1&numwant=200&event=started`;
  const res = await fetchFn(url + (url.includes('?') ? '&' : '?') + q, {
    headers: { 'User-Agent': 'Streamdeck/0.1', Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const d = bdict(bdecode(body).value);
  if (!d) throw new Error('bad tracker response');
  const failure = bstr(d['failure reason']);
  if (failure) throw new Error(failure);
  const peers = d.peers;
  if (peers instanceof Uint8Array) return parseCompactPeers(peers);
  if (Array.isArray(peers)) {
    return peers.flatMap((p) => {
      const pd = bdict(p);
      const host = bstr(pd?.ip);
      const port = bnum(pd?.port);
      return host && port && /^\d+\.\d+\.\d+\.\d+$/.test(host) ? [{ host, port }] : [];
    });
  }
  return [];
}
