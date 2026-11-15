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
import { bdecode, bdict, bencode, parseInfo, type BIn, type TorrentFile, type TorrentInfo } from './bencode';
import { announce, type PeerAddr } from './tracker';
import { BLOCK, Peer, type Connect, type PeerHandler } from './wire';

const MAX_PEERS = 40; // established + connecting
const MAX_CONNECTING = 5; // Cloudflare allows ~6 connections in their opening phase at once
const MAX_TRACKERS_INFLIGHT = 3;
const PIPELINE_MIN = 16; // outstanding block requests per peer (16 KB each)…
const PIPELINE_START = 32;
const PIPELINE_MAX = 192; // …scaled to each peer's measured speed (~1.5 s of data in flight)
const READAHEAD = 32 << 20; // bytes fetched ahead of each reader
const ACTIVE_MAX = 32 << 20; // bytes of partially downloaded pieces
const CACHE_MAX = 24 << 20; // bytes of verified pieces kept beyond what readers still need
const REQUEST_BUDGET = 40; // connections/fetches allowed per incoming request (Workers free: 50)
const STALE_MS = 8_000;
const HEAD_STALE_MS = 2_500; // the piece a reader is waiting on is re-requested quickly
const CHOKED_GIVE_UP_MS = 20_000; // peers that never let us download are replaced
const REANNOUNCE_MS = 45_000;
const PEER_IDLE_MS = 25_000;
const READER_STALL_MS = 60_000;
const IDLE_SLEEP_MS = 120_000;
const MAX_METADATA = 8 << 20;
const ENDGAME_AFTER_MS = 700; // a block the reader waits on, outstanding this long, is also asked of other peers
const ENDGAME_COPIES = 2; // extra peers asked for the same block
const PROGRESSIVE_MIN_PIECE = 1 << 20; // pieces this big are played block by block as they arrive
const PROGRESSIVE_MIN_RUN = 64 << 10;
const WARM_MS = 25_000; // start-of-file / end-of-file prefetch, until the player takes over
const WARM_HEAD = 8 << 20;
const WARM_TAIL = 2 << 20;
/** Public .torrent caches: the file list without waiting for peers (verified against the info-hash). */
const TORRENT_CACHES = [(hash: string) => `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`];

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
  /** Extra peers asked for a block the reader is waiting on (endgame). */
  dups: Map<number, Set<Peer>>;
  /** Who delivered each block (to drop peers that sent bad data). */
  src: (string | undefined)[];
  /** Some of it was played before verification. */
  served: boolean;
}

interface Reader {
  pos: number; // absolute torrent offset of the next byte to deliver
  end: number; // inclusive
  lastProgress: number;
  /** Prefetch reader (start/end of the file before the player asks); removed after `until`. */
  warm?: { until: number; tail: boolean };
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
  private lastPrune = 0;
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
  private notifyQueued = false;
  private banned = new Set<string>();
  private strikes = new Map<string, number>();
  private cacheFetchStarted = false;

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
    if (!this.info && !this.cacheFetchStarted) this.fetchCachedTorrent();
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

  /**
   * Start fetching what a player asks for first: the beginning of the file and its last few MB
   * (MP4 index / MKV cues), so playback starts sooner. Undone after a short while or when the
   * player starts reading elsewhere.
   */
  prefetch(file: TorrentFile) {
    if (!this.info || !file.length) return;
    const until = Date.now() + WARM_MS;
    for (const r of [...this.readers]) if (r.warm) this.readers.delete(r);
    this.readers.add({ pos: file.offset, end: file.offset + Math.min(file.length, WARM_HEAD) - 1, lastProgress: Date.now(), warm: { until, tail: false } });
    if (file.length > WARM_HEAD + WARM_TAIL) {
      this.readers.add({ pos: file.offset + file.length - WARM_TAIL, end: file.offset + file.length - 1, lastProgress: Date.now(), warm: { until, tail: true } });
    }
    this.lastActive = Date.now();
    this.schedule();
  }

  /** Stream bytes [start, end] (inclusive) of a file. Download is driven by how fast the consumer reads. */
  createStream(file: TorrentFile, start: number, end: number): ReadableStream<Uint8Array> {
    const info = this.info;
    if (!info) throw new Error('metadata not ready');
    const r: Reader = { pos: file.offset + start, end: file.offset + end, lastProgress: Date.now() };
    // The player is reading: start-of-file prefetch is only kept if it's where the player is.
    for (const w of [...this.readers]) if (w.warm && !w.warm.tail && Math.abs(w.pos - r.pos) > WARM_HEAD) this.readers.delete(w);
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
            // Big pieces: play the blocks already here instead of waiting for the whole piece.
            const ap = this.active.get(idx);
            if (ap && ap.buf.length >= PROGRESSIVE_MIN_PIECE) {
              const off = r.pos - idx * pl;
              let b = Math.floor(off / BLOCK);
              while (b < ap.nBlocks && ap.state[b] === 2) b++;
              const ready = Math.min(b * BLOCK, ap.buf.length) - off;
              const n = Math.min(ready, r.end - r.pos + 1, 1 << 20);
              if (n > 0 && (n >= PROGRESSIVE_MIN_RUN || off + n >= ap.buf.length || r.pos + n > r.end)) {
                ap.served = true;
                ctrl.enqueue(ap.buf.slice(off, off + n));
                r.pos += n;
                r.lastProgress = this.lastActive = Date.now();
                this.schedule();
                return;
              }
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
    for (const p of this.peers) {
      p.rate = p.rate * 0.6 + (p.downloaded - p.lastDownloaded) * 0.4;
      p.lastDownloaded = p.downloaded;
    }

    for (const r of [...this.readers]) if (r.warm && now > r.warm.until) this.readers.delete(r);
    if (!this.readers.size && now - this.lastActive > IDLE_SLEEP_MS) { this.sleep(); return; }

    // Metadata exchange stuck on one peer → try another.
    if (this.metaPeer && now - this.metaStarted > 12_000) { const p = this.metaPeer; this.metaPeer = undefined; p.close('metadata timeout'); }

    // Release block requests that were never answered.
    const heads = this.headPieces();
    for (const ap of this.active.values()) {
      if (ap.verifying) continue;
      const limit = heads.has(ap.index) ? HEAD_STALE_MS : STALE_MS;
      for (let b = 0; b < ap.nBlocks; b++) {
        if (ap.state[b] === 1 && now - ap.reqAt[b] > limit) {
          const owner = ap.owner[b];
          if (owner) { owner.inflight.delete(ap.index * 65536 + b); owner.stale++; }
          const dup = ap.dups.get(b);
          const next = dup && [...dup].find((q) => !q.closed);
          if (next) { dup!.delete(next); ap.owner[b] = next; ap.reqAt[b] = now; continue; }
          ap.state[b] = 0;
          ap.owner[b] = undefined;
        }
      }
    }

    const wanting = this.info && this.wanted().length > 0;
    const spare = this.candidates.length > 0;
    for (const p of [...this.peers]) {
      if (!p.handshook) continue;
      if (p.stale >= 24) { p.close('too slow'); continue; }
      if (wanting && spare && p.choked && now - p.handshakeAt > CHOKED_GIVE_UP_MS) { p.close('kept us choked'); continue; }
      if (wanting && spare && now - Math.max(p.lastData, p.createdAt) > PEER_IDLE_MS) { p.close('idle'); continue; }
      if (now - p.lastKeepAlive > 60_000) { p.lastKeepAlive = now; p.keepAlive(); }
    }

    // Near the peer limit: every 10 s replace the slowest peer, so the set keeps improving.
    if (wanting && spare && this.peers.size >= MAX_PEERS - 2 && now - this.lastPrune > 10_000) {
      this.lastPrune = now;
      const settled = [...this.peers].filter((p) => p.handshook && now - p.handshakeAt > 30_000);
      const best = Math.max(0, ...settled.map((p) => p.rate));
      const slowest = settled.sort((a, b) => a.rate - b.rate)[0];
      if (slowest && slowest.rate < Math.max(8 * 1024, best * 0.1)) slowest.close('slowest peer replaced');
    }

    // Keep the candidate list topped up from the trackers.
    const established = [...this.peers].filter((p) => p.handshook).length;
    if (this.candidates.length < 30 && established < MAX_PEERS / 2 && !this.trackerQueue.length && !this.trackersInFlight && now - this.lastAnnounce > REANNOUNCE_MS) {
      if (!this.candidates.length && established < 3) this.seen = new Set([...this.peers].map((p) => p.key)); // retry old addresses too
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
    // `peers` includes connections still being opened; only a few may be opening at once.
    while (this.budget > 0 && this.candidates.length && this.peers.size < MAX_PEERS && this.connecting + this.trackersInFlight < MAX_CONNECTING) {
      this.connectPeer(this.candidates.pop()!);
    }
    while (this.budget > 0 && this.trackerQueue.length && this.trackersInFlight < MAX_TRACKERS_INFLIGHT && this.candidates.length < 200) {
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
      if (this.seen.has(key) || this.banned.has(key) || a.port < 1 || a.port > 65535) continue;
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
    p.handshakeAt = Date.now();
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
        this.metaPeer = undefined;
        this.metaBuf = undefined;
        this.acceptInfo(raw);
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
        // Everyone else asked for this block can stop.
        for (const q of [ap.owner[b], ...(ap.dups.get(b) ?? [])]) {
          if (!q || q === p) continue;
          if (q.inflight.delete(index * 65536 + b)) q.cancel(index, begin, data.length);
        }
        ap.dups.delete(b);
        ap.buf.set(data, begin);
        ap.state[b] = 2;
        ap.owner[b] = undefined;
        ap.src[b] = p.key;
        if (++ap.done === ap.nBlocks) this.verify(ap);
        else if (ap.buf.length >= PROGRESSIVE_MIN_PIECE) this.notifySoon();
      }
    }
    // Refill this peer's pipeline in batches rather than per block.
    if (p.inflight.size <= this.pipeline(p) / 2) this.schedule();
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  private pieceLen(index: number): number {
    const info = this.info!;
    return index === info.numPieces - 1 ? info.length - index * info.pieceLength : info.pieceLength;
  }

  /** Requests to keep in flight for a peer: about 1.5 s of its measured speed. */
  private pipeline(p: Peer): number {
    if (!p.rate) return PIPELINE_START;
    return Math.max(PIPELINE_MIN, Math.min(PIPELINE_MAX, Math.ceil((p.rate * 1.5) / BLOCK)));
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
    // Fastest peers first: they get the blocks the reader needs soonest.
    for (const p of [...this.peers].sort((a, b) => b.rate - a.rate)) {
      if (!p.handshook || p.choked || p.closed) continue;
      let free = this.pipeline(p) - p.inflight.size;
      if (free <= 0) continue;
      const reqs: [number, number, number][] = [];
      outer: for (const idx of wanted) {
        if (!p.has(idx)) continue;
        let ap = this.active.get(idx);
        if (!ap) {
          const len = this.pieceLen(idx);
          if (this.activeBytes + len > ACTIVE_MAX && !heads.has(idx)) continue;
          const nBlocks = Math.ceil(len / BLOCK);
          ap = { index: idx, buf: new Uint8Array(len), nBlocks, state: new Uint8Array(nBlocks), owner: new Array(nBlocks), reqAt: new Array(nBlocks).fill(0), done: 0, verifying: false, dups: new Map(), src: new Array(nBlocks), served: false };
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
    this.endgame(heads, now);
  }

  /**
   * The piece a reader is waiting on: blocks still outstanding after ENDGAME_AFTER_MS are also
   * requested from the fastest other peers that have it; the first copy wins, the rest are
   * cancelled. One slow peer can no longer freeze playback.
   */
  private endgame(heads: Set<number>, now: number) {
    for (const idx of heads) {
      const ap = this.active.get(idx);
      if (!ap || ap.verifying) continue;
      const late: number[] = [];
      for (let b = 0; b < ap.nBlocks; b++) if (ap.state[b] === 1 && now - ap.reqAt[b] > ENDGAME_AFTER_MS) late.push(b);
      if (!late.length) continue;
      const helpers = [...this.peers]
        .filter((p) => p.handshook && !p.choked && !p.closed && p.has(idx) && p.inflight.size < this.pipeline(p) + 16)
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 4);
      if (!helpers.length) continue;
      const reqs = new Map<Peer, [number, number, number][]>();
      for (const b of late) {
        const asked = ap.dups.get(b) ?? new Set<Peer>();
        for (const p of helpers) {
          if (asked.size >= ENDGAME_COPIES) break;
          if (p === ap.owner[b] || asked.has(p)) continue;
          asked.add(p);
          p.inflight.add(idx * 65536 + b);
          const begin = b * BLOCK;
          const list = reqs.get(p) ?? [];
          list.push([idx, begin, Math.min(BLOCK, ap.buf.length - begin)]);
          reqs.set(p, list);
        }
        if (asked.size) ap.dups.set(b, asked);
      }
      for (const [p, list] of reqs) p.request(list);
    }
  }

  /** Give back the blocks a peer was asked for (choked or disconnected). */
  private release(p: Peer) {
    for (const key of p.inflight) {
      const ap = this.active.get(Math.floor(key / 65536));
      const b = key % 65536;
      if (!ap) continue;
      const dup = ap.dups.get(b);
      dup?.delete(p);
      if (ap.state[b] === 1 && ap.owner[b] === p) {
        // Another peer was also asked: it takes over instead of starting again.
        const next = dup && [...dup].find((q) => !q.closed);
        if (next) { dup!.delete(next); ap.owner[b] = next; }
        else { ap.state[b] = 0; ap.owner[b] = undefined; }
      }
      if (dup && !dup.size) ap.dups.delete(b);
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
        // Bad data: a peer involved in two bad pieces is dropped for good (one glitch can happen).
        for (const k of new Set(ap.src.filter((x): x is string => !!x))) {
          const n = (this.strikes.get(k) ?? 0) + 1;
          this.strikes.set(k, n);
          if (n < 2) continue;
          this.banned.add(k);
          for (const q of [...this.peers]) if (q.key === k) q.close('sent corrupt data');
        }
        ap.state.fill(0);
        ap.owner.fill(undefined);
        ap.src.fill(undefined);
        ap.dups.clear();
        ap.served = false;
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

  /** Wake readers soon (coalesced: blocks can arrive hundreds of times a second). */
  private notifySoon() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    setTimeout(() => { this.notifyQueued = false; this.notify(); }, 40);
  }

  /** Get the file list from a public .torrent cache while peers are still being found. */
  private fetchCachedTorrent() {
    this.cacheFetchStarted = true;
    for (const url of TORRENT_CACHES) {
      if (this.budget <= 0) return;
      this.budget--;
      this.fetchFn(url(this.infoHashHex), { signal: AbortSignal.timeout(6000) })
        .then(async (res) => {
          if (!res.ok || this.info) return;
          const top = bdict(bdecode(new Uint8Array(await res.arrayBuffer())).value);
          const info = top?.info;
          if (!info) return;
          const raw = bencode(info as BIn);
          if (!equalBytes(await sha1(raw), this.infoHash) || this.info) return;
          this.acceptInfo(raw);
        })
        .catch(() => undefined);
    }
  }

  private acceptInfo(raw: Uint8Array) {
    try { this.info = parseInfo(raw); } catch (e) { this.lastPeerError = `metadata: ${(e as Error).message}`; return false; }
    if (this.metaPeer) { this.metaPeer = undefined; this.metaBuf = undefined; }
    this.opts.onInfo?.(raw);
    for (const q of this.peers) if (q.handshook) q.interested();
    this.notify();
    this.schedule();
    return true;
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
