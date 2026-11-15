import crypto from 'node:crypto';
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { bencode } from '@/lib/bt/bencode';
import { TorrentSession } from '@/lib/bt/session';
import type { Connect } from '@/lib/bt/wire';
import { DEFAULT_SETTINGS, usesRelayStreaming } from '@/lib/store';

const PIECE = 1 << 18;
const data = crypto.randomBytes(4 * PIECE);
const sha1 = (b: Uint8Array) => crypto.createHash('sha1').update(b).digest();
const pieces = Buffer.concat(Array.from({ length: 4 }, (_, i) => sha1(data.subarray(i * PIECE, (i + 1) * PIECE))));
const rawInfo = bencode({ name: 'movie.mp4', 'piece length': PIECE, pieces, length: data.length });
const infoHash = sha1(rawInfo).toString('hex');
const servers: net.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** Records connection attempts; the sockets never open (so slots stay taken). */
function hangingConnect() {
  const tried: string[] = [];
  const connect: Connect = (host, port) => {
    tried.push(`${host}:${port}`);
    return { readable: new ReadableStream(), writable: new WritableStream(), opened: new Promise(() => undefined), close: () => undefined };
  };
  return { tried, connect };
}
const compact = (n: number, base = 10) => new Uint8Array(Array.from({ length: n }, (_, i) => [base, 0, i >> 8, i & 255, 0x1a, 0xe1]).flat());

describe('relay streaming: which peers are tried first', () => {
  it('tries peers that served this torrent before, ahead of tracker addresses', async () => {
    const { tried, connect } = hangingConnect();
    const fetchFn = (async () => new Response(bencode({ interval: 1800, peers: compact(20) }) as any)) as unknown as typeof fetch;
    const s = new TorrentSession({ infoHash, trackers: ['http://t/announce'], connect, fetchFn, infoBytes: rawInfo, knownPeers: [{ host: '9.9.9.9', port: 51413 }] });
    s.touch();
    await new Promise((r) => setTimeout(r, 20));
    expect(tried[0]).toBe('9.9.9.9:51413');
    s.destroy();
  });

  it('ranks addresses vouched for by another peer (PEX) or several trackers above single listings', () => {
    const s = new TorrentSession({ infoHash, trackers: [], connect: hangingConnect().connect, infoBytes: rawInfo }) as any;
    s.addCandidates([{ host: '1.1.1.1', port: 1 }, { host: '2.2.2.2', port: 1 }]);
    s.addCandidates([{ host: '2.2.2.2', port: 1 }, { host: '3.3.3.3', port: 1 }]);
    s.addCandidates([{ host: '4.4.4.4', port: 1 }], 2);
    const order = [s.takeCandidate(), s.takeCandidate()].map((c: { host: string }) => c.host);
    expect(order).toEqual(['4.4.4.4', '2.2.2.2']);
  });

  it('once a tracker gave plenty of addresses, slow trackers stop taking connection slots from peers', async () => {
    const { tried, connect } = hangingConnect();
    const announces: string[] = [];
    const fetchFn = (async (url: string) => {
      announces.push(String(url));
      if (String(url).startsWith('http://fast/')) return new Response(bencode({ interval: 1800, peers: compact(60) }) as any);
      return new Promise(() => undefined); // a tracker that never answers
    }) as unknown as typeof fetch;
    const trackers = ['http://fast/announce', 'http://slow1/announce', 'http://slow2/announce', 'http://slow3/announce', 'http://slow4/announce'];
    const s = new TorrentSession({ infoHash, trackers, connect, fetchFn, infoBytes: rawInfo });
    s.touch();
    await new Promise((r) => setTimeout(r, 30));
    expect(announces).toHaveLength(3); // the first wave only: no new tracker while 60 addresses wait
    expect(tried).toHaveLength(3); // the free slots went to peers
    s.destroy();
  });
});

function seeder() {
  return new Promise<number>((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0); let shook = false;
      sock.on('error', () => undefined);
      const send = (id: number, payload: Uint8Array = new Uint8Array()) => { const h = Buffer.alloc(5); h.writeUInt32BE(payload.length + 1); h[4] = id; sock.write(Buffer.concat([h, payload])); };
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!shook) {
          if (buf.length < 68) return;
          buf = buf.subarray(68); shook = true;
          const hs = Buffer.alloc(68); hs.write('\x13BitTorrent protocol', 'latin1'); Buffer.from(infoHash, 'hex').copy(hs, 28); hs.write('-TS0001-abcdefghijkl', 48);
          sock.write(hs); send(5, Buffer.from([0xf0])); send(1);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0); if (buf.length < 4 + len) break;
          const msg = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
          if (!len || msg[0] !== 6) continue;
          const index = msg.readUInt32BE(1), begin = msg.readUInt32BE(5), length = msg.readUInt32BE(9);
          const head = Buffer.alloc(8); head.writeUInt32BE(index); head.writeUInt32BE(begin, 4);
          send(7, Buffer.concat([head, data.subarray(index * PIECE + begin, index * PIECE + begin + length)]));
        }
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}
const realConnect: Connect = (host, p) => {
  const sock = net.connect(p, host);
  const opened = new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  opened.catch(() => undefined); sock.on('error', () => undefined);
  return { readable: Readable.toWeb(sock) as any, writable: Writable.toWeb(sock) as any, opened, close: () => sock.destroy() };
};

describe('relay streaming: remembering good peers', () => {
  it('reports the peers that delivered data, so the next session starts with them', async () => {
    const port = await seeder();
    const fetchFn = (async () => new Response(bencode({ interval: 1800, peers: new Uint8Array([127, 0, 0, 1, port >> 8, port & 255]) }) as any)) as unknown as typeof fetch;
    let saved: { host: string; port: number }[] = [];
    const s = new TorrentSession({ infoHash, trackers: ['http://t/announce'], connect: realConnect, fetchFn, infoBytes: rawInfo, onGoodPeers: (p) => { saved = p; } });
    s.touch();
    let got = 0;
    for await (const c of s.createStream(s.info!.files[0], 0, data.length - 1) as any) got += c.length;
    expect(got).toBe(data.length);
    s.destroy(); // going idle saves them
    expect(saved).toEqual([{ host: '127.0.0.1', port }]);
  });
});

describe('relay streaming: warming up from the title page', () => {
  const caps = { stream: true, debrid: { realdebrid: false, torbox: false, debridlink: false } } as never;
  it('only when the torrent would play through the relay', () => {
    expect(usesRelayStreaming({ ...DEFAULT_SETTINGS, engine: 'auto' }, caps)).toBe(true);
    expect(usesRelayStreaming({ ...DEFAULT_SETTINGS, engine: 'auto', debridKeys: { ...DEFAULT_SETTINGS.debridKeys, realdebrid: 'k' } }, caps)).toBe(false);
    expect(usesRelayStreaming({ ...DEFAULT_SETTINGS, engine: 'cloud' }, caps)).toBe(true);
    expect(usesRelayStreaming({ ...DEFAULT_SETTINGS, engine: 'auto' }, { ...(caps as object), stream: false } as never)).toBe(false);
  });
});
