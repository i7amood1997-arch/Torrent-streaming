/**
 * Map Matroska tracks to MP4 sample entries and MSE codec strings.
 * No re-encoding: only containers change, so quality is untouched.
 */
import type { MkvTrack } from './ebml';
import { box, concat, fullbox, u16, u24, u32, u8, type SampleEntry } from './fmp4';

export interface TrackPlan {
  kind: 'video' | 'audio';
  /** MSE type, e.g. `video/mp4; codecs="avc1.640028"`. */
  mime: string;
  codec: string;
  timescale: number;
  /** Default samples per audio frame (at `timescale`), or default video frame duration in ticks. */
  defaultDuration: number;
  /**
   * Build the sample entry. Dolby (AC-3/E-AC-3) needs the first frame to read its
   * stream parameters, so entries are created lazily.
   */
  entry(firstFrame: Uint8Array): SampleEntry;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

// ─── Video ──────────────────────────────────────────────────────────────────

function avcCodec(avcC: Uint8Array) {
  return `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

export function hevcCodec(hvcC: Uint8Array): string {
  const space = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 0x1f;
  let compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  // The compatibility flags are written bit-reversed.
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = hvcC[12];
  return [
    'hvc1',
    `${space ? String.fromCharCode(64 + space) : ''}${profile}`,
    (rev >>> 0).toString(16).toUpperCase(),
    `${tier ? 'H' : 'L'}${level}`,
    ...constraints.map((c) => c.toString(16).toUpperCase()),
  ].join('.');
}

function av1Codec(av1C: Uint8Array): string {
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 0x1f;
  const tier = av1C[2] >> 7;
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = high ? (twelve ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
}

function videoPlan(t: MkvTrack, format: string, codec: string, config: Uint8Array[]): TrackPlan {
  const width = t.width ?? 0;
  const height = t.height ?? 0;
  let pasp: [number, number] | undefined;
  if (t.displayWidth && t.displayHeight && width && height && t.displayWidth * height !== t.displayHeight * width) {
    const h = t.displayWidth * height;
    const v = t.displayHeight * width;
    const g = gcd(h, v);
    pasp = [h / g, v / g];
  }
  const timescale = 90_000;
  return {
    kind: 'video',
    mime: `video/mp4; codecs="${codec}"`,
    codec,
    timescale,
    defaultDuration: t.defaultDurationNs ? Math.round((t.defaultDurationNs / 1e9) * timescale) : 3750, // 24 fps
    entry: () => ({ kind: 'video', format, width, height, config, pasp }),
  };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// ─── Audio ──────────────────────────────────────────────────────────────────

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig for codec IDs that don't carry one (A_AAC/MPEG4/LC, …). */
function buildAsc(t: MkvTrack): Uint8Array {
  const sbr = /SBR/.test(t.codecId);
  const rate = t.sampleRate ?? 48000;
  const idx = Math.max(0, AAC_RATES.indexOf(rate));
  const ch = t.channels ?? 2;
  const aot = /MAIN/.test(t.codecId) ? 1 : /SSR/.test(t.codecId) ? 3 : /LTP/.test(t.codecId) ? 4 : 2;
  const asc = [(aot << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)];
  if (sbr) {
    const ext = Math.max(0, AAC_RATES.indexOf(t.outputSampleRate ?? rate * 2));
    asc.push(0x56, 0xe5, 0x80 | (ext << 3)); // sync extension: SBR present
  }
  return Uint8Array.from(asc);
}

function descriptor(tag: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u8(tag, 0x80, 0x80, 0x80, body.length), body]);
}

function esds(objectType: number, dsi?: Uint8Array): Uint8Array {
  const dcd = descriptor(
    0x04,
    u8(objectType, 0x15), u8(0, 0, 0), u32(0), u32(0),
    ...(dsi ? [descriptor(0x05, dsi)] : []),
  );
  return fullbox('esds', 0, 0, descriptor(0x03, u16(1), u8(0), dcd, descriptor(0x06, u8(2))));
}

/** Simple MSB-first bit reader. */
class Bits {
  private p = 0;
  constructor(private b: Uint8Array) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.p >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v >>> 0;
  }
  skip(n: number) { this.p += n; }
}

/** dac3 from an AC-3 syncframe header. */
export function dac3(frame: Uint8Array): Uint8Array {
  const r = new Bits(frame);
  if (r.read(16) !== 0x0b77) throw new Error('AC-3: no syncword');
  r.skip(16); // crc1
  const fscod = r.read(2);
  const frmsizecod = r.read(6);
  const bsid = r.read(5);
  const bsmod = r.read(3);
  const acmod = r.read(3);
  if ((acmod & 1) && acmod !== 1) r.skip(2); // cmixlev
  if (acmod & 4) r.skip(2); // surmixlev
  if (acmod === 2) r.skip(2); // dsurmod
  const lfeon = r.read(1);
  const v = (fscod << 22) | (bsid << 17) | (bsmod << 14) | (acmod << 11) | (lfeon << 10) | ((frmsizecod >> 1) << 5);
  return box('dac3', u24(v));
}


/** dec3 from the first E-AC-3 frame (independent substream 0). */
export function dec3(frame: Uint8Array): Uint8Array {
  const r = new Bits(frame);
  if (r.read(16) !== 0x0b77) throw new Error('E-AC-3: no syncword');
  r.skip(2); // strmtyp
  r.skip(3); // substreamid
  const frmsiz = r.read(11);
  const fscod = r.read(2);
  let numblks = 6;
  let sampleRate = [48000, 44100, 32000][fscod] ?? 48000;
  if (fscod === 3) { const fscod2 = r.read(2); sampleRate = [24000, 22050, 16000][fscod2] ?? 24000; }
  else numblks = [1, 2, 3, 6][r.read(2)];
  const acmod = r.read(3);
  const lfeon = r.read(1);
  const bsid = r.read(5);
  const frameBytes = (frmsiz + 1) * 2;
  const dataRate = Math.round((frameBytes * 8 * sampleRate) / (numblks * 256) / 1000); // kbit/s
  // data_rate(13) num_ind_sub(3)=0 | fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3) lfeon(1) reserved(3) num_dep_sub(4) reserved(1)
  return box(
    'dec3',
    u16((Math.min(dataRate, 8191) << 3) | 0),
    u8((fscod === 3 ? 0 : fscod) << 6 | (bsid << 1), (acmod << 1) | lfeon, 0),
  );
}

/** dOps from Matroska's OpusHead CodecPrivate (little-endian → big-endian). */
function dOps(head: Uint8Array | undefined, channels: number): Uint8Array {
  if (!head || head.length < 19 || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') {
    return box('dOps', u8(0, channels), u16(312), u32(48000), u16(0), u8(0));
  }
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const family = head[18];
  return box(
    'dOps',
    u8(0, head[9]),
    u16(dv.getUint16(10, true)),
    u32(dv.getUint32(12, true)),
    u16(dv.getInt16(16, true) & 0xffff),
    u8(family),
    ...(family ? [head.subarray(19)] : []),
  );
}

function audioPlan(t: MkvTrack, codec: string, timescale: number, defaultDuration: number, entry: (f: Uint8Array) => SampleEntry): TrackPlan {
  return { kind: 'audio', mime: `audio/mp4; codecs="${codec}"`, codec, timescale, defaultDuration, entry };
}

/** Plan for a Matroska track, or a reason it can't be repackaged. */
export function planTrack(t: MkvTrack): TrackPlan | { unsupported: string } {
  const id = t.codecId;
  const cp = t.codecPrivate;
  if (t.type === 'video') {
    if (id === 'V_MPEG4/ISO/AVC' && cp?.length && cp.length > 4) return videoPlan(t, 'avc1', avcCodec(cp), [box('avcC', cp)]);
    if (id === 'V_MPEGH/ISO/HEVC' && cp?.length && cp.length > 22) return videoPlan(t, 'hvc1', hevcCodec(cp), [box('hvcC', cp)]);
    if (id === 'V_AV1' && cp?.length && cp.length >= 4) return videoPlan(t, 'av01', av1Codec(cp), [box('av1C', cp)]);
    if (id === 'V_VP9') {
      const vpcC = fullbox('vpcC', 1, 0, u8(0, 31, (8 << 4) | (1 << 1), 1, 1, 1), u16(0));
      return videoPlan(t, 'vp09', 'vp09.00.31.08', [vpcC]);
    }
    return { unsupported: `video codec ${id.replace(/^V_/, '')}` };
  }
  if (t.type === 'audio') {
    const ch = t.channels ?? 2;
    const rate = Math.round(t.sampleRate ?? 48000);
    if (id.startsWith('A_AAC')) {
      const asc = cp?.length ? cp : buildAsc(t);
      let aot = asc[0] >> 3;
      if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
      return audioPlan(t, `mp4a.40.${aot}`, rate, 1024, () => ({ kind: 'audio', format: 'mp4a', channels: ch, sampleRate: rate, config: [esds(0x40, asc)] }));
    }
    if (id === 'A_AC3') return audioPlan(t, 'ac-3', rate, 1536, (f) => ({ kind: 'audio', format: 'ac-3', channels: ch, sampleRate: rate, config: [dac3(f)] }));
    if (id === 'A_EAC3') return audioPlan(t, 'ec-3', rate, 1536, (f) => ({ kind: 'audio', format: 'ec-3', channels: ch, sampleRate: rate, config: [dec3(f)] }));
    if (id === 'A_OPUS') return audioPlan(t, 'opus', 48000, 960, () => ({ kind: 'audio', format: 'Opus', channels: ch, sampleRate: 48000, config: [dOps(cp, ch)] }));
    if (id === 'A_MPEG/L3') return audioPlan(t, 'mp4a.6B', rate, 1152, () => ({ kind: 'audio', format: 'mp4a', channels: ch, sampleRate: rate, config: [esds(0x6b)] }));
    const name = ({ A_DTS: 'DTS', A_TRUEHD: 'Dolby TrueHD', A_FLAC: 'FLAC', A_VORBIS: 'Vorbis' } as Record<string, string>)[id] ?? id.replace(/^A_/, '');
    return { unsupported: `audio codec ${name}` };
  }
  return { unsupported: 'not audio/video' };
}
