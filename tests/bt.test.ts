import net from 'node:net';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bdecode, bencode, parseInfo } from '@/lib/bt/bencode';
import { mimeFor, parseRange } from '@/lib/bt/http';
import { TorrentSession } from '@/lib/bt/session';
import { parseCompactPeers, trackerList } from '@/lib/bt/tracker';
import type { Connect } from '@/lib/bt/wire';

const sha1 = (b: Uint8Array) => crypto.createHash('sha1').update(b).digest();

describe('bencode', () => {
  it('round-trips nested values with sorted keys', () => {
    const enc = bencode({ b: [1, 'two', new Uint8Array([3])], a: { z: -5 } });
    expect(new TextDecoder().decode(enc)).toBe('d1:ad1:zi-5ee1:bli1e3:two1:\x03ee');
    const { value, end } = bdecode(enc);
    expect(end).toBe(enc.length);
    expect((value as any).a.z).toBe(-5);
  });
  it('reports where a value ends (payload after a dict) and rejects junk', () => {
    const buf = new TextEncoder().encode('d8:msg_typei1e5:piecei0eeDATA');
    expect(new TextDecoder().decode(buf.subarray(bdecode(buf).end))).toBe('DATA');
    expect(() => bdecode(new TextEncoder().encode('5:ab'))).toThrow();
    expect(() => bdecode(new TextEncoder().encode('x'))).toThrow();
  });
  it('parses multi-file info with offsets', () => {
    const info = parseInfo(bencode({ name: 'Pack', 'piece length': 16384, pieces: new Uint8Array(40), files: [{ length: 10, path: ['a.nfo'] }, { length: 30000, path: ['sub', 'movie.mp4'] }] }));
    expect(info.numPieces).toBe(2);
    expect(info.files[1]).toMatchObject({ index: 1, path: 'sub/movie.mp4', name: 'movie.mp4', offset: 10, length: 30000 });
    expect(info.length).toBe(30010);
  });
});

describe('tracker helpers', () => {
  it('parses compact peers', () => {
    expect(parseCompactPeers(new Uint8Array([10, 0, 0, 1, 0x1a, 0xe1, 1, 2, 3, 4, 0, 0]))).toEqual([{ host: '10.0.0.1', port: 6881 }]);
  });
  it('keeps http trackers, adds defaults, and guesses http for udp', () => {
    const list = trackerList(['udp://tracker.example.org:1337/announce', 'https://t.example/announce', 'wss://ws.example']);
    expect(list[0]).toBe('https://t.example/announce');
    expect(list).toContain('http://tracker.example.org:1337/announce');
    expect(list.some((u) => u.startsWith('wss:') || u.startsWith('udp:'))).toBe(false);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('range parsing', () => {
  it('handles the forms browsers send', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 });
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
    expect(mimeFor('Movie.2024.MP4')).toBe('video/mp4');
  });
});

/**
 * Minimal seeder speaking the real wire protocol (handshake, BEP 10 extended
 * handshake, ut_metadata, bitfield, unchoke, piece). Interop with a real client
 * (WebTorrent 3 + bittorrent-tracker) was verified separately; this guards regressions.
 */
describe('TorrentSession against a wire-protocol seeder', () => {
  const PIECE = 32768;
  const data = crypto.randomBytes(PIECE * 9 + 1234);
  const nfo = Buffer.from('nfo');
  const all = Buffer.concat([nfo, data]);
  const pieces = Buffer.concat(Array.from({ length: Math.ceil(all.length / PIECE) }, (_, i) => sha1(all.subarray(i * PIECE, (i + 1) * PIECE))));
  const rawInfo = bencode({ name: 'Pack', 'piece length': PIECE, pieces, files: [{ length: nfo.length, path: ['x.nfo'] }, { length: data.length, path: ['movie.mp4'] }] });
  const infoHash = sha1(rawInfo);
  let server: net.Server;
  let port = 0;
  let corruptFirst = true;

  beforeAll(async () => {
    server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let shook = false;
      const send = (id: number, payload: Uint8Array = new Uint8Array()) => {
        const h = Buffer.alloc(5); h.writeUInt32BE(payload.length + 1); h[4] = id;
        sock.write(Buffer.concat([h, payload]));
      };
      sock.on('error', () => undefined);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!shook) {
          if (buf.length < 68) return;
          buf = buf.subarray(68);
          shook = true;
          const hs = Buffer.alloc(68); hs.write('\x13BitTorrent protocol', 'latin1'); hs[25] = 0x10; infoHash.copy(hs, 28); hs.write('-TS0001-abcdefghijkl', 48);
          sock.write(hs);
          send(20, Buffer.concat([Buffer.from([0]), bencode({ m: { ut_metadata: 3 }, metadata_size: rawInfo.length })]));
          send(5, new Uint8Array([0xff, 0xff])); // has all 10 pieces
          send(1); // unchoke
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const msg = buf.subarray(4, 4 + len);
          buf = buf.subarray(4 + len);
          if (!len) continue;
          if (msg[0] === 20 && msg[1] === 3) { // ut_metadata request
            const piece = (bdecode(msg, 2).value as any).piece as number;
            send(20, Buffer.concat([Buffer.from([2]), bencode({ msg_type: 1, piece, total_size: rawInfo.length }), rawInfo.subarray(piece * 16384, (piece + 1) * 16384)]));
          } else if (msg[0] === 6) { // request
            const index = msg.readUInt32BE(1), begin = msg.readUInt32BE(5), length = msg.readUInt32BE(9);
            const block = Buffer.from(all.subarray(index * PIECE + begin, index * PIECE + begin + length));
            if (corruptFirst && index === 0 && begin === 0) { corruptFirst = false; block[5] ^= 0xff; } // must be caught by SHA-1 and refetched
            const head = Buffer.alloc(8); head.writeUInt32BE(index, 0); head.writeUInt32BE(begin, 4);
            send(7, Buffer.concat([head, block]));
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => server.close());

  it('fetches metadata from a magnet, streams ranges, and recovers from a corrupt piece', async () => {
    const connect: Connect = (host, p) => {
      const s = net.connect(p, host);
      const opened = new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
      opened.catch(() => undefined);
      s.on('error', () => undefined);
      return { readable: Readable.toWeb(s) as any, writable: Writable.toWeb(s) as any, opened, close: () => s.destroy() };
    };
    const compact = new Uint8Array([127, 0, 0, 1, port >> 8, port & 255]);
    const fetchFn = (async () => new Response(bencode({ interval: 1800, peers: compact }) as any)) as unknown as typeof fetch;
    const session = new TorrentSession({ infoHash: infoHash.toString('hex'), trackers: ['http://tracker.test/announce'], connect, fetchFn });
    try {
      session.touch();
      const info = await session.waitForInfo(5000);
      expect(info?.files.map((f) => f.path)).toEqual(['x.nfo', 'movie.mp4']);
      const file = info!.files[1];
      const read = async (start: number, end: number) => {
        const chunks: Uint8Array[] = [];
        for await (const c of session.createStream(file, start, end) as any) chunks.push(c);
        return Buffer.concat(chunks);
      };
      expect((await read(0, 1)).equals(data.subarray(0, 2))).toBe(true);
      expect((await read(40000, 200000)).equals(data.subarray(40000, 200001))).toBe(true);
      const [a, b] = await Promise.all([read(0, data.length - 1), read(data.length - 500, data.length - 1)]);
      expect(a.equals(data)).toBe(true);
      expect(b.equals(data.subarray(data.length - 500))).toBe(true);
      expect(corruptFirst).toBe(false);
      expect(session.stats().readers).toBe(0);
    } finally {
      session.destroy();
    }
  }, 20000);
});
