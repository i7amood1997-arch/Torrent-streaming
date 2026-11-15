/**
 * One BitTorrent peer connection (BEP 3 wire protocol + BEP 10 extensions:
 * ut_metadata for magnet links, ut_pex for peer discovery). Download-only.
 *
 * Runtime-agnostic: works on any socket exposing web streams — Cloudflare's
 * `connect()` in the Worker, or node:net wrapped in web streams in tests.
 */
import { bdecode, bdict, bencode, bnum } from './bencode';
import { parseCompactPeers, type PeerAddr } from './tracker';

export interface BtSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): unknown;
}
export type Connect = (host: string, port: number) => BtSocket;

export const BLOCK = 16384;
const PSTR = new TextEncoder().encode('\x13BitTorrent protocol');
/** Extension message ids we advertise (peers address us with these). */
const EXT_PEX = 1;
const EXT_METADATA = 2;
const MAX_MESSAGE = BLOCK + 1024; // we never request more than one block; bitfields are checked separately
const MAX_BITFIELD = 1 << 20;

export interface PeerHandler {
  handshake(p: Peer): void;
  extHandshake(p: Peer): void;
  unchoke(p: Peer): void;
  choke(p: Peer): void;
  /** `data` is only valid during the call — copy it. */
  block(p: Peer, index: number, begin: number, data: Uint8Array): void;
  metadataPiece(p: Peer, piece: number, data: Uint8Array): void;
  metadataReject(p: Peer): void;
  pex(p: Peer, peers: PeerAddr[]): void;
  closed(p: Peer, reason: string): void;
}

export class Peer {
  readonly key: string;
  choked = true;
  handshook = false;
  closed = false;
  /** Peer's ut_metadata message id (0 = unsupported) and advertised metadata size. */
  utMetadata = 0;
  metadataSize = 0;
  /** Outstanding block requests, keyed `piece * 65536 + block`. */
  inflight = new Set<number>();
  downloaded = 0;
  stale = 0;
  readonly createdAt = Date.now();
  lastData = Date.now();
  lastKeepAlive = Date.now();
  handshakeAt = 0;
  /** Smoothed download rate in bytes/s (updated by the session every second). */
  rate = 0;
  lastDownloaded = 0;
  private bitfield?: Uint8Array;
  private chunks: Uint8Array[] = [];
  private off = 0;
  private avail = 0;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(
    readonly host: string,
    readonly port: number,
    private sock: BtSocket,
    private infoHash: Uint8Array,
    private peerId: Uint8Array,
    private handler: PeerHandler,
  ) {
    this.key = `${host}:${port}`;
  }

  /** Connect, handshake, then pump messages until the connection ends. Never throws. */
  async run(connectTimeoutMs = 5000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.sock.opened,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('connect timeout')), connectTimeoutMs); }),
      ]);
      clearTimeout(timer);
      if (this.closed) return;

      this.writer = this.sock.writable.getWriter();
      const hs = new Uint8Array(68);
      hs.set(PSTR, 0);
      hs[25] = 0x10; // reserved[5]: extension protocol (BEP 10)
      hs.set(this.infoHash, 28);
      hs.set(this.peerId, 48);
      this.write(hs);
      this.sendExt(0, bencode({ m: { ut_metadata: EXT_METADATA, ut_pex: EXT_PEX }, v: 'Streamdeck 0.1', reqq: 250 }));

      timer = setTimeout(() => { if (!this.handshook) this.close('handshake timeout'); }, 8000);
      const reader = (this.reader = this.sock.readable.getReader());
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) {
          this.chunks.push(value);
          this.avail += value.length;
          while (this.parse()) { /* drain complete messages */ }
        }
      }
      this.close('closed by peer');
    } catch (e) {
      this.close(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  has(piece: number): boolean {
    const b = this.bitfield;
    return !!b && piece >> 3 < b.length && (b[piece >> 3] & (0x80 >> (piece & 7))) !== 0;
  }

  interested() { this.write(new Uint8Array([0, 0, 0, 1, 2])); }
  keepAlive() { this.write(new Uint8Array(4)); }

  /** Send several block requests in one write. Each item: [piece, begin, length]. */
  request(reqs: [number, number, number][]) {
    const buf = new Uint8Array(17 * reqs.length);
    const dv = new DataView(buf.buffer);
    reqs.forEach(([index, begin, length], i) => {
      const o = i * 17;
      dv.setUint32(o, 13);
      buf[o + 4] = 6;
      dv.setUint32(o + 5, index);
      dv.setUint32(o + 9, begin);
      dv.setUint32(o + 13, length);
    });
    this.write(buf);
  }

  /** Withdraw a block request (another peer delivered it first). */
  cancel(index: number, begin: number, length: number) {
    const buf = new Uint8Array(17);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 13);
    buf[4] = 8;
    dv.setUint32(5, index);
    dv.setUint32(9, begin);
    dv.setUint32(13, length);
    this.write(buf);
  }

  requestMetadata(piece: number) {
    if (this.utMetadata) this.sendExt(this.utMetadata, bencode({ msg_type: 0, piece }));
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.avail = 0;
    try { this.reader?.cancel().catch(() => undefined); } catch { /* ignore */ }
    try { this.writer?.abort().catch(() => undefined); } catch { /* ignore */ }
    try { Promise.resolve(this.sock.close()).catch(() => undefined); } catch { /* ignore */ }
    this.handler.closed(this, reason);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private write(buf: Uint8Array) {
    if (this.closed || !this.writer) return;
    this.writer.write(buf).catch((e) => this.close(`write failed: ${e?.message ?? e}`));
  }

  private sendExt(id: number, payload: Uint8Array) {
    const buf = new Uint8Array(6 + payload.length);
    new DataView(buf.buffer).setUint32(0, 2 + payload.length);
    buf[4] = 20;
    buf[5] = id;
    buf.set(payload, 6);
    this.write(buf);
  }

  /** View of the next `n` unread bytes (merging chunks if needed), or null if not yet received. */
  private peek(n: number): Uint8Array | null {
    if (this.avail < n) return null;
    const first = this.chunks[0];
    if (first.length - this.off >= n) return first.subarray(this.off, this.off + n);
    const merged = new Uint8Array(this.avail);
    let o = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = i === 0 ? this.chunks[0].subarray(this.off) : this.chunks[i];
      merged.set(c, o);
      o += c.length;
    }
    this.chunks = [merged];
    this.off = 0;
    return merged.subarray(0, n);
  }

  private consume(n: number) {
    this.off += n;
    this.avail -= n;
    while (this.chunks.length && this.off >= this.chunks[0].length) {
      this.off -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  /** Parse one message if fully buffered. Returns false when more bytes are needed. */
  private parse(): boolean {
    if (this.closed) return false;
    if (!this.handshook) {
      const h = this.peek(68);
      if (!h) return false;
      for (let i = 0; i < 20; i++) if (h[i] !== PSTR[i]) throw new Error('not a BitTorrent peer');
      for (let i = 0; i < 20; i++) if (h[28 + i] !== this.infoHash[i]) throw new Error('info hash mismatch');
      this.consume(68);
      this.handshook = true;
      this.handler.handshake(this);
      return true;
    }
    const head = this.peek(4);
    if (!head) return false;
    const len = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
    if (len === 0) { this.consume(4); return true; } // keep-alive
    if (len > MAX_BITFIELD) throw new Error('oversized message');
    const msg = this.peek(4 + len);
    if (!msg) {
      // Only bitfields and extension messages may exceed one block; reject others early.
      if (len > MAX_MESSAGE && this.avail >= 5) {
        const id = this.peek(5)![4];
        if (id !== 5 && id !== 20) throw new Error('oversized message');
      }
      return false;
    }
    this.onMessage(msg[4], msg.subarray(5, 4 + len));
    this.consume(4 + len);
    return true;
  }

  private onMessage(id: number, p: Uint8Array) {
    switch (id) {
      case 0: this.choked = true; this.handler.choke(this); break;
      case 1: this.choked = false; this.handler.unchoke(this); break;
      case 4: { // have
        if (p.length < 4) break;
        const index = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
        if (index > MAX_BITFIELD * 8) break;
        const need = (index >> 3) + 1;
        if (!this.bitfield || this.bitfield.length < need) {
          const grown = new Uint8Array(Math.max(need, (this.bitfield?.length ?? 0) * 2));
          if (this.bitfield) grown.set(this.bitfield);
          this.bitfield = grown;
        }
        this.bitfield[index >> 3] |= 0x80 >> (index & 7);
        break;
      }
      case 5: this.bitfield = p.slice(); break;
      case 7: { // piece
        if (p.length < 8) break;
        const dv = new DataView(p.buffer, p.byteOffset, 8);
        this.lastData = Date.now();
        this.downloaded += p.length - 8;
        this.handler.block(this, dv.getUint32(0), dv.getUint32(4), p.subarray(8));
        break;
      }
      case 20: this.onExtended(p); break;
      default: break; // interested/not interested/request/cancel/port: irrelevant for a leecher
    }
  }

  private onExtended(p: Uint8Array) {
    if (!p.length) return;
    const ext = p[0];
    const { value, end } = bdecode(p, 1);
    const d = bdict(value);
    if (!d) return;
    if (ext === 0) {
      this.utMetadata = bnum(bdict(d.m)?.ut_metadata) ?? 0;
      this.metadataSize = bnum(d.metadata_size) ?? 0;
      this.handler.extHandshake(this);
    } else if (ext === EXT_METADATA) {
      const type = bnum(d.msg_type);
      if (type === 1) this.handler.metadataPiece(this, bnum(d.piece) ?? -1, p.subarray(end));
      else if (type === 2) this.handler.metadataReject(this);
    } else if (ext === EXT_PEX) {
      if (d.added instanceof Uint8Array) this.handler.pex(this, parseCompactPeers(d.added));
    }
  }
}
