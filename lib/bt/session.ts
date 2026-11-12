/**
 * Streaming torrent session: sequential, range-driven download of one torrent,
 * built for Cloudflare Workers / Durable Objects:
 *
 *  - outbound TCP only (no UDP: HTTP trackers + PEX instead of DHT)
 *  - at most 6 simultaneous outbound connections → few, carefully chosen peers
 *  - a per-request subrequest budget → `touch()` must be called on every
 *    incoming request (the app pings while playing) to refill it
 *  - 128 MB memory → bounded piece cache and in-flight buffers; nothing on disk
 *
 * Readers (HTTP range requests) each have a position; the scheduler requests
 * blocks in order just ahead of the readers and verifies every piece (SHA-1).
 */
import { parseInfo, type TorrentFile, type TorrentInfo } from './bencode';
import { announce, type PeerAddr } from './tracker';
import { BLOCK, Peer, type Connect, type PeerHandler } from './wire';

const MAX_SOCKETS = 6; // Cloudflare: simultaneous outgoing connections
const MAX_PEERS = 5; // leave one slot for tracker announces
const PIPELINE = 48; // outstanding block requests per peer (~768 KB)
const READAHEAD = 16 << 20; // bytes fetched ahead of each reader
const ACTIVE_MAX = 32 << 20; // bytes of partially downloaded pieces
const CACHE_MAX = 32 << 20; // bytes of verified pieces kept for readers
const REQUEST_BUDGET = 40; // connections/fetches allowed per incoming request (Workers free: 50)
const STALE_MS = 10_000;
const PEER_IDLE_MS = 25_000;
const READER_STALL_MS = 60_000;
const IDLE_SLEEP_MS = 120_000;
const MAX_METADATA = 8 << 20;

export interface SessionOptions {
  infoHash: string; // 40 hex chars
  trackers: string[]; // http(s) announce URLs
  connect: Connect;
  fetchFn?: typeof fetch;
  /** Previously fetched raw info dictionary (skips the metadata exchange). */
  infoBytes?: Uint8Array;
  onInfo?: (raw: Uint8Array) => void;
}

export interface SessionStats {
  infoReady: boolean;
  peers: number;
  unchoked: number;
  connecting: number;
  candidates: number;
  readers: number;
  downSpeed: number; // bytes/s
  downloaded: number;
  trackersOk: number;
  trackersFailed: number;
  trackersPending: number;
  peersTried: number;
  lastTrackerError?: string;
  lastPeerError?: string;
}

interface ActivePiece {
  index: number;
  buf: Uint8Array;
  nBlocks: number;
  /** 0 = free, 1 = requested, 2 = received */
  state: Uint8Array;
  owner: (Peer | undefined)[];
  reqAt: number[];
  done: number;
  verifying: boolean;
}

interface Reader {
  pos: number; // absolute torrent offset of the next byte to deliver
  end: number; // inclusive
  lastProgress: number;
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));

async function sha1(buf: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', buf as unknown as ArrayBuffer));
}

function equalBytes(a: Uint8Array, b: Uint8Array, bOff = 0): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[bOff + i]) return false;
  return true;
}

function makePeerId(): Uint8Array {
  const id = new TextEncoder().encode('-SD0100-000000000000');
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rnd = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) id[8 + i] = chars.charCodeAt(rnd[i] % chars.length);
  return id;
}

export class TorrentSession implements PeerHandler {
  info?: TorrentInfo;
  readonly infoHashHex: string;
  private infoHash: Uint8Array;
  private peerId = makePeerId();
  private fetchFn: typeof fetch;

  private peers = new Set<Peer>();
  private connecting = 0;
  private candidates: PeerAddr[] = [];
  private seen = new Set<string>();
  private peersTried = 0;

  private trackerQueue: string[] = [];
  private trackersInFlight = 0;
  private trackersOk = 0;
  private trackersFailed = 0;
  private lastAnnounce = 0;
  private lastTrackerError?: string;
  private lastPeerError?: string;

  private metaPeer?: Peer;
  private metaBuf?: Uint8Array;
  private metaGot = new Set<number>();
  private metaStarted = 0;
  private metaTried = new Set<string>();

  private active = new Map<number, ActivePiece>();
  private activeBytes = 0;
  private cache = new Map<number, Uint8Array>();
  private cacheBytes = 0;
  private readers = new Set<Reader>();
  private waiters: (() => void)[] = [];

  private budget = REQUEST_BUDGET;
  private timer?: ReturnType<typeof setInterval>;
  private lastActive = Date.now();
  private downloaded = 0;
  private speedBytes = 0;
  private downSpeed = 0;
  private destroyed = false;

  constructor(private opts: SessionOptions) {
    if (!/^[a-f0-9]{40}$/.test(opts.infoHash)) throw new Error('invalid info hash');
    this.infoHashHex = opts.infoHash;
    this.infoHash = hexToBytes(opts.infoHash);
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    if (opts.infoBytes) {
      try { this.info = parseInfo(opts.infoBytes); } catch { /* refetch from peers */ }
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Call on every incoming request: refills the connection budget and (re)starts the session. */
  touch() {
    this.budget = REQUEST_BUDGET;
    this.lastActive = Date.now();
    if (this.destroyed) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.queueAnnounce();
    }
    this.pump();
  }

  addTrackers(urls: string[]) {
    for (const u of urls) if (!this.opts.trackers.includes(u)) { this.opts.trackers.push(u); this.trackerQueue.push(u); }
  }

  async waitForInfo(timeoutMs: number): Promise<TorrentInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (!this.info && !this.destroyed && Date.now() < deadline) await this.wait(Math.min(1000, deadline - Date.now()));
    return this.info;
  }

  stats(): SessionStats {
    let unchoked = 0;
    for (const p of this.peers) if (p.handshook && !p.choked) unchoked++;
    return {
      infoReady: !!this.info,
      peers: [...this.peers].filter((p) => p.handshook).length,
      unchoked,
      connecting: this.connecting,
      candidates: this.candidates.length,
      readers: this.readers.size,
      downSpeed: Math.round(this.downSpeed),
      downloaded: this.downloaded,
      trackersOk: this.trackersOk,
      trackersFailed: this.trackersFailed,
      trackersPending: this.trackerQueue.length + this.trackersInFlight,
      peersTried: this.peersTried,
      lastTrackerError: this.lastTrackerError,
      lastPeerError: this.lastPeerError,
    };
  }

  /** Stream bytes [start, end] (inclusive) of a file. Download is driven by how fast the consumer reads. */
  createStream(file: TorrentFile, start: number, end: number): ReadableStream<Uint8Array> {
    const info = this.info;
    if (!info) throw new Error('metadata not ready');
    const r: Reader = { pos: file.offset + start, end: file.offset + end, lastProgress: Date.now() };
    this.readers.add(r);
    this.lastActive = Date.now();
    this.schedule();
    const pl = info.pieceLength;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (ctrl) => {
          for (;;) {
            if (r.pos > r.end) { this.readers.delete(r); ctrl.close(); return; }
            const idx = Math.floor(r.pos / pl);
            const piece = this.cache.get(idx);
            if (piece) {
              const off = r.pos - idx * pl;
              const n = Math.min(piece.length - off, r.end - r.pos + 1, 1 << 20);
              ctrl.enqueue(piece.slice(off, off + n)); // copy: the cache may evict/reuse independently of the consumer
              r.pos += n;
              r.lastProgress = this.lastActive = Date.now();
              this.schedule();
              return;
            }
            if (this.destroyed) throw new Error('stream closed');
            if (Date.now() - r.lastProgress > READER_STALL_MS) {
              this.readers.delete(r);
              throw new Error('no data from peers (stalled)');
            }
            await this.wait(2000);
          }
        },
        cancel: () => { this.readers.delete(r); },
      },
      { highWaterMark: 2 },
    );
  }

  destroy() {
    this.destroyed = true;
    this.sleep();
    this.notify();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private sleep() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const p of [...this.peers]) p.close('session idle');
    this.active.clear();
    this.activeBytes = 0;
    this.cache.clear();
    this.cacheBytes = 0;
    this.candidates = [];
    this.seen.clear();
    this.metaTried.clear();
  }

  private tick() {
    const now = Date.now();
    this.downSpeed = this.downSpeed * 0.6 + this.speedBytes * 0.4;
    this.speedBytes = 0;

    if (!this.readers.size && now - this.lastActive > IDLE_SLEEP_MS) { this.sleep(); return; }

    // Metadata exchange stuck on one peer → try another.
    if (this.metaPeer && now - this.metaStarted > 12_000) { const p = this.metaPeer; this.metaPeer = undefined; p.close('metadata timeout'); }

    // Release block requests that were never answered.
    const heads = this.headPieces();
    for (const ap of this.active.values()) {
      if (ap.verifying) continue;
      const limit = heads.has(ap.index) ? STALE_MS / 2 : STALE_MS;
      for (let b = 0; b < ap.nBlocks; b++) {
        if (ap.state[b] === 1 && now - ap.reqAt[b] > limit) {
          const owner = ap.owner[b];
          ap.state[b] = 0;
          ap.owner[b] = undefined;
          if (owner) { owner.inflight.delete(ap.index * 65536 + b); owner.stale++; }
        }
      }
    }

    const wanting = this.info && this.wanted().length > 0;
    for (const p of [...this.peers]) {
      if (!p.handshook) continue;
      if (p.stale >= 24) { p.close('too slow'); continue; }
      if (wanting && now - Math.max(p.lastData, p.createdAt) > PEER_IDLE_MS && this.candidates.length) { p.close('idle'); continue; }
      if (now - p.lastKeepAlive > 60_000) { p.lastKeepAlive = now; p.keepAlive(); }
    }

    // Running low on peers → ask the trackers again (at most every 30 s).
    if (!this.candidates.length && this.peers.size < 3 && !this.trackerQueue.length && !this.trackersInFlight && now - this.lastAnnounce > 30_000) {
      this.seen = new Set([...this.peers].map((p) => p.key));
      this.queueAnnounce();
    }
    this.pump();
    this.schedule();
    this.notify(); // lets readers re-check stall timeouts
  }

  private queueAnnounce() {
    this.lastAnnounce = Date.now();
    this.trackerQueue = [...this.opts.trackers];
  }

  /** Open connections while slots and budget allow: peers first, then tracker announces. */
  private pump() {
    if (this.destroyed || !this.timer) return;
    // `peers` includes connections still being opened.
    const sockets = () => this.peers.size + this.trackersInFlight;
    while (this.budget > 0 && this.candidates.length && this.peers.size < MAX_PEERS && sockets() < MAX_SOCKETS) {
      this.connectPeer(this.candidates.pop()!);
    }
    while (this.budget > 0 && this.trackerQueue.length && sockets() < MAX_SOCKETS && this.candidates.length < 100) {
      // With enough peers already, announce one tracker at a time.
      if (this.peers.size >= 2 && this.trackersInFlight >= 1) break;
      this.announceTo(this.trackerQueue.shift()!);
    }
  }

  private announceTo(url: string) {
    this.budget--;
    this.trackersInFlight++;
    const left = this.info ? this.info.length : 1 << 30;
    announce(url, this.infoHash, this.peerId, left, this.fetchFn)
      .then((peers) => { this.trackersOk++; this.addCandidates(peers); })
      .catch((e) => { this.trackersFailed++; this.lastTrackerError = `${safeHost(url)}: ${e?.message ?? e}`; })
      .finally(() => { this.trackersInFlight--; this.pump(); });
  }

  private addCandidates(list: PeerAddr[]) {
    for (const a of list) {
      const key = `${a.host}:${a.port}`;
      if (this.seen.has(key) || a.port < 1 || a.port > 65535) continue;
      this.seen.add(key);
      // Random insertion so one tracker's ordering doesn't dominate.
      const i = Math.floor(Math.random() * (this.candidates.length + 1));
      this.candidates.splice(i, 0, a);
    }
    if (this.candidates.length > 500) this.candidates.length = 500;
    this.pump();
  }

  private connectPeer(a: PeerAddr) {
    this.budget--;
    this.peersTried++;
    let sock;
    try { sock = this.opts.connect(a.host, a.port); } catch (e) { this.lastPeerError = `${(e as Error).message}`; return; }
    const peer = new Peer(a.host, a.port, sock, this.infoHash, this.peerId, this);
    this.peers.add(peer);
    this.connecting++;
    (peer as any)._connecting = true;
    peer.run();
  }

  // ── PeerHandler ───────────────────────────────────────────────────────────

  handshake(p: Peer) {
    if ((p as any)._connecting) { (p as any)._connecting = false; this.connecting--; }
    if (this.info) p.interested();
    this.pump();
  }

  extHandshake(p: Peer) {
    if (!this.info) this.tryMetadata();
  }

  unchoke(p: Peer) { this.schedule(); }

  choke(p: Peer) {
    this.release(p);
    this.schedule();
  }

  pex(_p: Peer, peers: PeerAddr[]) { this.addCandidates(peers.slice(0, 100)); }

  closed(p: Peer, reason: string) {
    if ((p as any)._connecting) { (p as any)._connecting = false; this.connecting--; }
    if (!p.handshook || p.downloaded === 0) this.lastPeerError = `${p.key}: ${reason}`;
    this.peers.delete(p);
    this.release(p);
    if (this.metaPeer === p) { this.metaPeer = undefined; this.tryMetadata(); }
    this.pump();
    this.schedule();
  }

  metadataPiece(p: Peer, piece: number, data: Uint8Array) {
    if (p !== this.metaPeer || !this.metaBuf || this.info) return;
    const n = Math.ceil(this.metaBuf.length / BLOCK);
    if (piece < 0 || piece >= n || this.metaGot.has(piece)) return;
    const expected = piece === n - 1 ? this.metaBuf.length - piece * BLOCK : BLOCK;
    if (data.length !== expected) { p.close('bad metadata piece'); return; }
    this.metaBuf.set(data, piece * BLOCK);
    this.metaGot.add(piece);
    if (this.metaGot.size === n) {
      const raw = this.metaBuf;
      sha1(raw).then((h) => {
        if (this.info) return;
        if (!equalBytes(h, this.infoHash)) { this.metaPeer = undefined; p.close('metadata hash mismatch'); return; }
        try { this.info = parseInfo(raw); } catch (e) { this.lastPeerError = `metadata: ${(e as Error).message}`; this.metaPeer = undefined; return; }
        this.metaPeer = undefined;
        this.metaBuf = undefined;
        this.opts.onInfo?.(raw);
        for (const q of this.peers) if (q.handshook) q.interested();
        this.notify();
        this.schedule();
      });
    }
  }

  metadataReject(p: Peer) {
    if (p === this.metaPeer) { this.metaPeer = undefined; this.tryMetadata(); }
  }

  private tryMetadata() {
    if (this.info || this.metaPeer) return;
    for (const p of this.peers) {
      if (!p.handshook || !p.utMetadata || !p.metadataSize || p.metadataSize > MAX_METADATA || this.metaTried.has(p.key)) continue;
      this.metaTried.add(p.key);
      this.metaPeer = p;
      this.metaStarted = Date.now();
      this.metaBuf = new Uint8Array(p.metadataSize);
      this.metaGot.clear();
      const n = Math.ceil(p.metadataSize / BLOCK);
      for (let i = 0; i < n; i++) p.requestMetadata(i);
      return;
    }
  }

  block(p: Peer, index: number, begin: number, data: Uint8Array) {
    this.downloaded += data.length;
    this.speedBytes += data.length;
    const b = begin / BLOCK;
    p.inflight.delete(index * 65536 + b);
    const ap = this.active.get(index);
    if (ap && !ap.verifying && Number.isInteger(b) && b < ap.nBlocks && ap.state[b] !== 2) {
      const expected = b === ap.nBlocks - 1 ? ap.buf.length - begin : BLOCK;
      if (data.length === expected) {
        const prev = ap.owner[b];
        if (prev && prev !== p) prev.inflight.delete(index * 65536 + b);
        ap.buf.set(data, begin);
        ap.state[b] = 2;
        ap.owner[b] = undefined;
        if (++ap.done === ap.nBlocks) this.verify(ap);
      }
    }
    // Refill this peer's pipeline in batches rather than per block.
    if (p.inflight.size <= PIPELINE / 2) this.schedule();
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  private pieceLen(index: number): number {
    const info = this.info!;
    return index === info.numPieces - 1 ? info.length - index * info.pieceLength : info.pieceLength;
  }

  /** First piece each reader is waiting for. */
  private headPieces(): Set<number> {
    const out = new Set<number>();
    if (this.info) for (const r of this.readers) out.add(Math.floor(r.pos / this.info.pieceLength));
    return out;
  }

  /** Pieces to fetch, nearest to a reader first. */
  private wanted(): number[] {
    const info = this.info;
    if (!info) return [];
    const rank = new Map<number, number>();
    for (const r of this.readers) {
      const first = Math.floor(r.pos / info.pieceLength);
      const last = Math.min(Math.floor(Math.min(r.pos + READAHEAD, r.end) / info.pieceLength), info.numPieces - 1);
      for (let i = first; i <= last; i++) {
        if (this.cache.has(i)) continue;
        const d = i - first;
        const cur = rank.get(i);
        if (cur === undefined || d < cur) rank.set(i, d);
      }
    }
    return [...rank.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map((e) => e[0]);
  }

  private schedule() {
    if (!this.info || this.destroyed || !this.readers.size) return;
    const wanted = this.wanted();
    if (!wanted.length) return;
    const heads = this.headPieces();
    const now = Date.now();
    for (const p of this.peers) {
      if (!p.handshook || p.choked || p.closed) continue;
      let free = PIPELINE - p.inflight.size;
      if (free <= 0) continue;
      const reqs: [number, number, number][] = [];
      outer: for (const idx of wanted) {
        if (!p.has(idx)) continue;
        let ap = this.active.get(idx);
        if (!ap) {
          const len = this.pieceLen(idx);
          if (this.activeBytes + len > ACTIVE_MAX && !heads.has(idx)) continue;
          const nBlocks = Math.ceil(len / BLOCK);
          ap = { index: idx, buf: new Uint8Array(len), nBlocks, state: new Uint8Array(nBlocks), owner: new Array(nBlocks), reqAt: new Array(nBlocks).fill(0), done: 0, verifying: false };
          this.active.set(idx, ap);
          this.activeBytes += len;
        }
        if (ap.verifying) continue;
        for (let b = 0; b < ap.nBlocks; b++) {
          if (ap.state[b] !== 0) continue;
          ap.state[b] = 1;
          ap.owner[b] = p;
          ap.reqAt[b] = now;
          p.inflight.add(idx * 65536 + b);
          const begin = b * BLOCK;
          reqs.push([idx, begin, Math.min(BLOCK, ap.buf.length - begin)]);
          if (--free === 0) break outer;
        }
      }
      if (reqs.length) p.request(reqs);
    }
  }

  /** Give back the blocks a peer was asked for (choked or disconnected). */
  private release(p: Peer) {
    for (const key of p.inflight) {
      const ap = this.active.get(Math.floor(key / 65536));
      const b = key % 65536;
      if (ap && ap.state[b] === 1 && ap.owner[b] === p) { ap.state[b] = 0; ap.owner[b] = undefined; }
    }
    p.inflight.clear();
  }

  private verify(ap: ActivePiece) {
    ap.verifying = true;
    sha1(ap.buf).then((h) => {
      if (this.active.get(ap.index) !== ap) return; // session slept meanwhile
      if (equalBytes(h, this.info!.pieces, ap.index * 20)) {
        this.active.delete(ap.index);
        this.activeBytes -= ap.buf.length;
        this.cache.set(ap.index, ap.buf);
        this.cacheBytes += ap.buf.length;
        this.evict();
        this.notify();
      } else {
        ap.state.fill(0);
        ap.owner.fill(undefined);
        ap.done = 0;
        ap.verifying = false;
      }
      this.schedule();
    });
  }

  /** Drop verified pieces no reader needs any more (oldest first). */
  private evict() {
    if (this.cacheBytes <= CACHE_MAX) return;
    const pl = this.info!.pieceLength;
    const isNeeded = (i: number) => {
      for (const r of this.readers) {
        const first = Math.floor(r.pos / pl);
        if (i >= first && i <= Math.floor((r.pos + READAHEAD) / pl)) return true;
      }
      return false;
    };
    for (const [i, buf] of this.cache) {
      if (this.cacheBytes <= CACHE_MAX) break;
      if (isNeeded(i)) continue;
      this.cache.delete(i);
      this.cacheBytes -= buf.length;
    }
  }

  // ── tiny condition variable ───────────────────────────────────────────────

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(fin, ms);
      this.waiters.push(fin);
    });
  }

  private notify() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return 'tracker'; }
}
