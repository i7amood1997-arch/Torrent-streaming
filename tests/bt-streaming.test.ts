import crypto from 'node:crypto';
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { bencode } from '@/lib/bt/bencode';
import { TorrentSession } from '@/lib/bt/session';
import type { Connect } from '@/lib/bt/wire';

const PIECE = 1 << 20;
const data = crypto.randomBytes(6 * PIECE + 777);
const sha1 = (b: Uint8Array) => crypto.createHash('sha1').update(b).digest();
const pieces = Buffer.concat(Array.from({ length: Math.ceil(data.length / PIECE) }, (_, i) => sha1(data.subarray(i * PIECE, (i + 1) * PIECE))));
const rawInfo = bencode({ name: 'movie.mkv', 'piece length': PIECE, pieces, length: data.length });
const infoHash = sha1(rawInfo);
const servers: net.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** A seeder; `stuck` never answers block requests (but keeps the connection open). */
function seeder(opts: { stuck?: boolean; delayMs?: number } = {}) {
  return new Promise<number>((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let shook = false;
      sock.on('error', () => undefined);
      const send = (id: number, payload: Uint8Array = new Uint8Array()) => { const h = Buffer.alloc(5); h.writeUInt32BE(payload.length + 1); h[4] = id; sock.write(Buffer.concat([h, payload])); };
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!shook) {
          if (buf.length < 68) return;
          buf = buf.subarray(68);
          shook = true;
          const hs = Buffer.alloc(68); hs.write('\x13BitTorrent protocol', 'latin1'); hs[25] = 0x10; infoHash.copy(hs, 28); hs.write('-TS0001-abcdefghijkl', 48);
          sock.write(hs);
          send(5, Buffer.from([0xfe])); // pieces 0-6
          send(1);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const msg = buf.subarray(4, 4 + len);
          buf = buf.subarray(4 + len);
          if (!len || msg[0] !== 6 || opts.stuck) continue;
          const index = msg.readUInt32BE(1), begin = msg.readUInt32BE(5), length = msg.readUInt32BE(9);
          const head = Buffer.alloc(8); head.writeUInt32BE(index); head.writeUInt32BE(begin, 4);
          const out = Buffer.concat([head, data.subarray(index * PIECE + begin, index * PIECE + begin + length)]);
          setTimeout(() => send(7, out), opts.delayMs ?? 0);
        }
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

const connect: Connect = (host, p) => {
  const s = net.connect(p, host);
  const opened = new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
  opened.catch(() => undefined);
  s.on('error', () => undefined);
  return { readable: Readable.toWeb(s) as any, writable: Writable.toWeb(s) as any, opened, close: () => s.destroy() };
};

function makeSession(ports: number[], opts: { cache?: boolean; info?: boolean } = {}) {
  const compact = new Uint8Array(ports.flatMap((p) => [127, 0, 0, 1, p >> 8, p & 255]));
  const fetches: string[] = [];
  const fetchFn = (async (url: string) => {
    fetches.push(String(url));
    if (String(url).includes('itorrents')) return opts.cache ? new Response(bencode({ announce: 'x', info: { name: 'movie.mkv', 'piece length': PIECE, pieces, length: data.length } }) as any) : new Response('', { status: 404 });
    return new Response(bencode({ interval: 1800, peers: compact }) as any);
  }) as unknown as typeof fetch;
  const session = new TorrentSession({ infoHash: infoHash.toString('hex'), trackers: ['http://t/announce'], connect, fetchFn, infoBytes: opts.info ? rawInfo : undefined });
  return { session, fetches };
}

async function readAll(s: TorrentSession, start: number, end: number) {
  const chunks: Uint8Array[] = [];
  for await (const c of s.createStream(s.info!.files[0], start, end) as any) chunks.push(c);
  return Buffer.concat(chunks);
}

describe('relay streaming engine', () => {
  it('keeps playing when a peer sits on requests (asks another peer too)', async () => {
    // The stuck seeder is listed first, so it gets asked first.
    const { session } = makeSession([await seeder({ stuck: true }), await seeder({ delayMs: 5 })], { info: true });
    try {
      session.touch();
      const t = Date.now();
      const got = await readAll(session, 0, 3 * PIECE);
      expect(got.equals(data.subarray(0, 3 * PIECE + 1))).toBe(true);
      expect(Date.now() - t).toBeLessThan(8000); // without endgame each stuck block waits for the 2.5–8 s timeouts
    } finally { session.destroy(); }
  }, 20000);

  it('gets the file list from a .torrent cache when no peer answers', async () => {
    const { session } = makeSession([], { cache: true });
    try {
      session.touch();
      const info = await session.waitForInfo(4000);
      expect(info?.files[0].path).toBe('movie.mkv');
      expect(info?.length).toBe(data.length);
    } finally { session.destroy(); }
  });

  it('ignores a cached .torrent for a different torrent', async () => {
    const other = crypto.randomBytes(20).toString('hex');
    const fetchFn = (async () => new Response(bencode({ info: { name: 'x', 'piece length': PIECE, pieces, length: data.length } }) as any)) as unknown as typeof fetch;
    const session = new TorrentSession({ infoHash: other, trackers: [], connect, fetchFn });
    try {
      session.touch();
      expect(await session.waitForInfo(1500)).toBeUndefined();
    } finally { session.destroy(); }
  });

  it('prefetches the start and end of the file before the player asks', async () => {
    const { session } = makeSession([await seeder()], { info: true });
    try {
      session.touch();
      session.prefetch(session.info!.files[0]);
      await new Promise((r) => setTimeout(r, 1500));
      expect(session.stats().downloaded).toBeGreaterThan(PIECE); // fetched with no reader attached
      const t = Date.now();
      const tail = await readAll(session, data.length - 100, data.length - 1);
      expect(tail.equals(data.subarray(data.length - 100))).toBe(true);
      expect(Date.now() - t).toBeLessThan(300); // already there
    } finally { session.destroy(); }
  });
});
