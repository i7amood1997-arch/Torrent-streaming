/**
 * Incremental Matroska (MKV/WebM) demuxer.
 *
 * Bytes are pushed as they arrive from the network; the demuxer emits the
 * header (tracks, duration), cue points (for seeking) and frames as soon as
 * each element is complete. Large elements we don't need (attachments such as
 * fonts in anime releases, tags, chapters) are skipped without buffering.
 *
 * Only what streaming playback needs is parsed. Timestamps are in milliseconds.
 */
import { unzlibSync } from 'fflate';

export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageIETF: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  DefaultDuration: 0x23e383,
  CodecDelay: 0x56aa,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

/** Level-1 elements: an unknown-size Cluster ends when one of these starts. */
const TOP_LEVEL = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Cluster, ID.Tags, ID.Chapters, ID.Attachments]);
const MAX_WHOLE_ELEMENT = 64 << 20;
const UNKNOWN = -1;

export interface MkvTrack {
  number: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codecId: string;
  codecPrivate?: Uint8Array;
  language: string; // ISO 639-2 ("eng") or IETF ("en")
  name?: string;
  isDefault: boolean;
  forced: boolean;
  defaultDurationNs?: number;
  /** Decoder priming the container asks players to skip (AAC/Opus); subtracted from timestamps. */
  codecDelayNs?: number;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  sampleRate?: number;
  outputSampleRate?: number;
  channels?: number;
  bitDepth?: number;
  /** Header stripping (algo 3) or zlib (algo 0). */
  compression?: { algo: number; settings?: Uint8Array };
  encrypted?: boolean;
}

export interface MkvHeader {
  timecodeScale: number; // ns per timecode tick
  durationMs?: number;
  tracks: MkvTrack[];
  /** Absolute byte offset where the Segment's data starts (positions in SeekHead/Cues are relative to it). */
  segmentStart: number;
  /** Absolute byte offset of the Cues element, if the SeekHead lists it. */
  cuesPosition?: number;
}

export interface MkvFrame {
  track: number;
  pts: number; // ms
  keyframe: boolean;
  data: Uint8Array;
  durationMs?: number;
}

export interface CuePoint {
  timeMs: number;
  track: number;
  pos: number; // absolute byte offset of the Cluster
}

export interface DemuxHandlers {
  onHeader?(h: MkvHeader): void;
  onFrame?(f: MkvFrame): void;
  onCues?(cues: CuePoint[]): void;
}

// ─── EBML primitives ────────────────────────────────────────────────────────

/** Variable-length integer. `keepMarker` for element IDs. Returns null if more bytes are needed. */
export function readVint(b: Uint8Array, off: number, keepMarker: boolean): { value: number; len: number } | null {
  if (off >= b.length) return null;
  const first = b[off];
  if (first === 0) throw new Error('mkv: invalid vint');
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('mkv: invalid vint');
  if (off + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[off + i];
    if (b[off + i] !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) return { value: UNKNOWN, len };
  return { value, len };
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < b.length; i++) v = v * 256 + b[i];
  return v;
}

function readFloat(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length === 4) return dv.getFloat32(0);
  if (b.length === 8) return dv.getFloat64(0);
  return 0;
}

const td = new TextDecoder();
const readString = (b: Uint8Array) => td.decode(b).replace(/\0+$/, '');

/** Iterate the children of a fully buffered master element. */
function* children(b: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  let off = 0;
  while (off < b.length) {
    const id = readVint(b, off, true);
    if (!id) return;
    const size = readVint(b, off + id.len, false);
    if (!size) return;
    const start = off + id.len + size.len;
    const end = size.value === UNKNOWN ? b.length : Math.min(b.length, start + size.value);
    yield { id: id.value, data: b.subarray(start, end) };
    off = end;
  }
}

// ─── Demuxer ────────────────────────────────────────────────────────────────

export class MkvDemuxer {
  header?: MkvHeader;
  private buf: Uint8Array = new Uint8Array(0);
  private bufPos = 0; // absolute offset of buf[0]
  private off = 0;
  private stack: { id: number; end: number }[] = [];
  private skip = 0;
  private resync = false;
  private clusterTime = 0;
  private timecodeScale = 1_000_000;
  private durationMs?: number;
  private segmentStart = 0;
  private cuesPosition?: number;
  private tracks?: Map<number, MkvTrack>;
  private headerEmitted = false;

  constructor(private h: DemuxHandlers = {}) {}

  /** Absolute byte offset of the next byte the demuxer expects. */
  get position() {
    return this.bufPos + this.buf.length;
  }

  /**
   * Restart parsing at an absolute byte offset inside the Segment (after a seek).
   * With `resync`, scan forward for the next Cluster first (offset is only an estimate).
   * A fresh demuxer that never saw the file start must be told where the Segment's data begins.
   */
  seekTo(absPos: number, resync = false, segmentStart?: number) {
    if (segmentStart !== undefined) this.segmentStart = segmentStart;
    this.buf = new Uint8Array(0);
    this.bufPos = absPos;
    this.off = 0;
    this.skip = 0;
    this.stack = [{ id: ID.Segment, end: Infinity }];
    this.resync = resync;
    this.clusterTime = 0;
  }

  push(chunk: Uint8Array) {
    if (!chunk.length) return;
    const rest = this.buf.subarray(this.off);
    if (!rest.length) {
      this.buf = chunk;
    } else {
      const merged = new Uint8Array(rest.length + chunk.length);
      merged.set(rest);
      merged.set(chunk, rest.length);
      this.buf = merged;
    }
    this.bufPos += this.off;
    this.off = 0;
    this.run();
  }

  private run() {
    const b = this.buf;
    for (;;) {
      const pos = this.bufPos + this.off;
      while (this.stack.length && this.stack[this.stack.length - 1].end <= pos) this.stack.pop();

      if (this.skip > 0) {
        const n = Math.min(this.skip, b.length - this.off);
        this.off += n;
        this.skip -= n;
        if (this.skip > 0) return;
        continue;
      }

      if (this.resync) {
        let i = this.off;
        for (; i + 4 <= b.length; i++) if (b[i] === 0x1f && b[i + 1] === 0x43 && b[i + 2] === 0xb6 && b[i + 3] === 0x75) break;
        if (i + 4 > b.length) { this.off = Math.max(this.off, b.length - 3); return; }
        this.off = i;
        this.resync = false;
        continue;
      }

      const id = readVint(b, this.off, true);
      if (!id) return;
      const size = readVint(b, this.off + id.len, false);
      if (!size) return;
      const headerLen = id.len + size.len;
      const dataStart = pos + headerLen;

      // An unknown-size Cluster ends where the next top-level element begins.
      const top = this.stack[this.stack.length - 1];
      if (top && top.id === ID.Cluster && top.end === Infinity && TOP_LEVEL.has(id.value)) this.stack.pop();

      const unknown = size.value === UNKNOWN;
      const end = unknown ? Infinity : dataStart + size.value;

      switch (id.value) {
        case ID.Segment:
          this.segmentStart = dataStart;
          this.stack.push({ id: ID.Segment, end });
          this.off += headerLen;
          continue;
        case ID.Cluster:
          this.emitHeader();
          this.clusterTime = 0;
          this.stack.push({ id: ID.Cluster, end });
          this.off += headerLen;
          continue;
        case ID.Timecode:
        case ID.SimpleBlock:
        case ID.BlockGroup:
        case ID.Info:
        case ID.Tracks:
        case ID.SeekHead:
        case ID.Cues: {
          if (unknown || size.value > MAX_WHOLE_ELEMENT) { this.off += headerLen; this.skip = unknown ? 0 : size.value; continue; }
          if (b.length - this.off < headerLen + size.value) return; // wait for the whole element
          const data = b.subarray(this.off + headerLen, this.off + headerLen + size.value);
          this.off += headerLen + size.value;
          this.element(id.value, data);
          continue;
        }
        default:
          // EBML header, Void, CRC-32, Tags, Chapters, Attachments, Cluster extras…: skip.
          this.off += headerLen;
          if (unknown) {
            if (id.value === ID.EBML) throw new Error('mkv: unknown-size EBML header');
            continue; // treat as a transparent master
          }
          this.skip = size.value;
          continue;
      }
    }
  }

  private element(id: number, data: Uint8Array) {
    switch (id) {
      case ID.Timecode: this.clusterTime = readUint(data); break;
      case ID.SimpleBlock: this.block(data, undefined, undefined); break;
      case ID.BlockGroup: {
        let block: Uint8Array | undefined;
        let duration: number | undefined;
        let hasRef = false;
        for (const c of children(data)) {
          if (c.id === ID.Block) block = c.data;
          else if (c.id === ID.BlockDuration) duration = readUint(c.data);
          else if (c.id === ID.ReferenceBlock) hasRef = true;
        }
        if (block) this.block(block, !hasRef, duration);
        break;
      }
      case ID.Info:
        for (const c of children(data)) {
          if (c.id === ID.TimecodeScale) this.timecodeScale = readUint(c.data) || 1_000_000;
          else if (c.id === ID.Duration) this.durationMs = readFloat(c.data);
        }
        if (this.durationMs !== undefined) this.durationMs = (this.durationMs * this.timecodeScale) / 1e6;
        if (this.header) this.header.durationMs = this.durationMs;
        break;
      case ID.Tracks:
        this.tracks = new Map();
        for (const c of children(data)) if (c.id === ID.TrackEntry) { const t = parseTrack(c.data); if (t) this.tracks.set(t.number, t); }
        break;
      case ID.SeekHead:
        for (const c of children(data)) {
          if (c.id !== ID.Seek) continue;
          let target = 0;
          let position = -1;
          for (const s of children(c.data)) {
            if (s.id === ID.SeekID) target = readUint(s.data);
            else if (s.id === ID.SeekPosition) position = readUint(s.data);
          }
          if (target === ID.Cues && position >= 0) this.cuesPosition = this.segmentStart + position;
        }
        if (this.header && this.cuesPosition !== undefined) this.header.cuesPosition = this.cuesPosition;
        break;
      case ID.Cues:
        this.h.onCues?.(parseCues(data, this.segmentStart, this.timecodeScale));
        break;
    }
  }

  private emitHeader() {
    if (this.headerEmitted || !this.tracks) return;
    this.headerEmitted = true;
    this.header = {
      timecodeScale: this.timecodeScale,
      durationMs: this.durationMs,
      tracks: [...this.tracks.values()],
      segmentStart: this.segmentStart,
      cuesPosition: this.cuesPosition,
    };
    this.h.onHeader?.(this.header);
  }

  private block(data: Uint8Array, keyframeFromGroup: boolean | undefined, durationTicks: number | undefined) {
    if (!this.tracks) return;
    const tn = readVint(data, 0, false);
    if (!tn || data.length < tn.len + 3) return;
    const track = this.tracks.get(tn.value);
    if (!track || track.encrypted) return;
    const rel = (data[tn.len] << 24 >> 16) | data[tn.len + 1]; // signed int16
    const flags = data[tn.len + 2];
    const keyframe = keyframeFromGroup ?? (flags & 0x80) !== 0;
    const scale = this.timecodeScale / 1e6;
    const pts = (this.clusterTime + rel) * scale - (track.codecDelayNs ?? 0) / 1e6;
    const durationMs = durationTicks !== undefined ? durationTicks * scale : undefined;

    const frames = unlace(data, tn.len + 3, (flags >> 1) & 3);
    const per = durationMs !== undefined && frames.length > 1 ? durationMs / frames.length : undefined;
    frames.forEach((f, i) => {
      let payload = f;
      const comp = track.compression;
      if (comp) {
        if (comp.algo === 3 && comp.settings) {
          payload = new Uint8Array(comp.settings.length + f.length);
          payload.set(comp.settings);
          payload.set(f, comp.settings.length);
        } else if (comp.algo === 0) {
          try { payload = unzlibSync(f); } catch { return; }
        } else return; // bzlib / lzo: not supported
      }
      this.h.onFrame?.({
        track: track.number,
        // Laced frames carry no own timestamps; spread them by duration when known (audio is fixed in the remuxer).
        pts: pts + (per ?? 0) * i,
        keyframe,
        data: payload,
        durationMs: per ?? (frames.length === 1 ? durationMs : undefined),
      });
    });
  }
}

/** Split a block payload into frames (no lacing, Xiph, fixed-size or EBML lacing). */
export function unlace(data: Uint8Array, off: number, lacing: number): Uint8Array[] {
  if (lacing === 0) return [data.subarray(off)];
  const count = data[off] + 1;
  let p = off + 1;
  const sizes: number[] = [];
  if (lacing === 1) { // Xiph
    for (let i = 0; i < count - 1; i++) {
      let s = 0;
      for (;;) { const v = data[p++]; s += v; if (v !== 255) break; }
      sizes.push(s);
    }
  } else if (lacing === 3) { // EBML
    const first = readVint(data, p, false);
    if (!first) return [];
    p += first.len;
    sizes.push(first.value);
    for (let i = 1; i < count - 1; i++) {
      const d = readVint(data, p, false);
      if (!d) return [];
      p += d.len;
      const bias = 2 ** (7 * d.len - 1) - 1;
      sizes.push(sizes[i - 1] + (d.value - bias));
    }
  } else { // fixed
    const each = Math.floor((data.length - p) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  sizes.push(data.length - p - used);
  const out: Uint8Array[] = [];
  for (const s of sizes) {
    if (s < 0 || p + s > data.length) return out;
    out.push(data.subarray(p, p + s));
    p += s;
  }
  return out;
}

function parseTrack(data: Uint8Array): MkvTrack | undefined {
  const t: MkvTrack = { number: 0, type: 'other', codecId: '', language: 'eng', isDefault: true, forced: false };
  for (const c of children(data)) {
    switch (c.id) {
      case ID.TrackNumber: t.number = readUint(c.data); break;
      case ID.TrackType: { const v = readUint(c.data); t.type = v === 1 ? 'video' : v === 2 ? 'audio' : v === 0x11 ? 'subtitle' : 'other'; break; }
      case ID.CodecID: t.codecId = readString(c.data); break;
      case ID.CodecPrivate: t.codecPrivate = c.data.slice(); break;
      case ID.Language: t.language = readString(c.data) || 'eng'; break;
      case ID.LanguageIETF: t.language = readString(c.data) || t.language; break;
      case ID.Name: t.name = readString(c.data); break;
      case ID.FlagDefault: t.isDefault = readUint(c.data) !== 0; break;
      case ID.FlagForced: t.forced = readUint(c.data) !== 0; break;
      case ID.DefaultDuration: t.defaultDurationNs = readUint(c.data); break;
      case ID.CodecDelay: t.codecDelayNs = readUint(c.data); break;
      case ID.Video:
        for (const v of children(c.data)) {
          if (v.id === ID.PixelWidth) t.width = readUint(v.data);
          else if (v.id === ID.PixelHeight) t.height = readUint(v.data);
          else if (v.id === ID.DisplayWidth) t.displayWidth = readUint(v.data);
          else if (v.id === ID.DisplayHeight) t.displayHeight = readUint(v.data);
        }
        break;
      case ID.Audio:
        for (const a of children(c.data)) {
          if (a.id === ID.SamplingFrequency) t.sampleRate = readFloat(a.data);
          else if (a.id === ID.OutputSamplingFrequency) t.outputSampleRate = readFloat(a.data);
          else if (a.id === ID.Channels) t.channels = readUint(a.data);
          else if (a.id === ID.BitDepth) t.bitDepth = readUint(a.data);
        }
        break;
      case ID.ContentEncodings:
        for (const enc of children(c.data)) {
          if (enc.id !== ID.ContentEncoding) continue;
          let type = 0;
          let algo = 0;
          let settings: Uint8Array | undefined;
          let hasCompression = false;
          for (const e of children(enc.data)) {
            if (e.id === ID.ContentEncodingType) type = readUint(e.data);
            else if (e.id === ID.ContentCompression) {
              hasCompression = true;
              for (const cc of children(e.data)) {
                if (cc.id === ID.ContentCompAlgo) algo = readUint(cc.data);
                else if (cc.id === ID.ContentCompSettings) settings = cc.data.slice();
              }
            }
          }
          if (type === 1) t.encrypted = true;
          else if (hasCompression) t.compression = { algo, settings };
        }
        break;
    }
  }
  return t.number ? t : undefined;
}

function parseCues(data: Uint8Array, segmentStart: number, timecodeScale: number): CuePoint[] {
  const out: CuePoint[] = [];
  const scale = timecodeScale / 1e6;
  for (const cp of children(data)) {
    if (cp.id !== ID.CuePoint) continue;
    let time = 0;
    for (const c of children(cp.data)) {
      if (c.id === ID.CueTime) time = readUint(c.data);
      else if (c.id === ID.CueTrackPositions) {
        let track = 0;
        let pos = -1;
        for (const p of children(c.data)) {
          if (p.id === ID.CueTrack) track = readUint(p.data);
          else if (p.id === ID.CueClusterPosition) pos = readUint(p.data);
        }
        if (pos >= 0) out.push({ timeMs: time * scale, track, pos: segmentStart + pos });
      }
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}
