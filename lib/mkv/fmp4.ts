/**
 * Fragmented MP4 (ISO BMFF) writer for Media Source Extensions: one init
 * segment per track (ftyp + moov) and moof+mdat media fragments.
 */

const te = new TextEncoder();

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const u8 = (...v: number[]) => Uint8Array.from(v.map((x) => x & 0xff));
export const u16 = (v: number) => u8(v >> 8, v);
export const u24 = (v: number) => u8(v >> 16, v >> 8, v);
export const u32 = (v: number) => u8(v >>> 24, v >> 16, v >> 8, v);
export const u64 = (v: number) => concat([u32(Math.floor(v / 2 ** 32)), u32(v >>> 0)]);
const zeros = (n: number) => new Uint8Array(n);

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.length + 8), te.encode(type), body]);
}

export const fullbox = (type: string, version: number, flags: number, ...payload: Uint8Array[]) =>
  box(type, u8(version), u24(flags), ...payload);

const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export interface SampleEntryVideo {
  kind: 'video';
  /** 'avc1' | 'hvc1' | 'av01' | 'vp09' */
  format: string;
  width: number;
  height: number;
  /** Codec configuration boxes (avcC, hvcC, …), already boxed. */
  config: Uint8Array[];
  /** Pixel aspect ratio for anamorphic video. */
  pasp?: [number, number];
}

export interface SampleEntryAudio {
  kind: 'audio';
  /** 'mp4a' | 'ac-3' | 'ec-3' | 'Opus' */
  format: string;
  channels: number;
  sampleRate: number;
  config: Uint8Array[];
}

export type SampleEntry = SampleEntryVideo | SampleEntryAudio;

function sampleEntry(e: SampleEntry): Uint8Array {
  if (e.kind === 'video') {
    const compressor = zeros(32);
    return box(
      e.format,
      zeros(6), u16(1), // reserved, data_reference_index
      u16(0), u16(0), zeros(12), // pre_defined, reserved, pre_defined
      u16(e.width), u16(e.height),
      u32(0x00480000), u32(0x00480000), // 72 dpi
      u32(0), u16(1), compressor, u16(0x0018), u16(0xffff),
      ...e.config,
      ...(e.pasp ? [box('pasp', u32(e.pasp[0]), u32(e.pasp[1]))] : []),
    );
  }
  return box(
    e.format,
    zeros(6), u16(1),
    zeros(8), // version, revision, vendor
    u16(e.channels), u16(16), u16(0), u16(0),
    u32(Math.min(e.sampleRate, 65535) * 65536),
    ...e.config,
  );
}

/** ftyp + moov for a single track (track id 1). */
export function initSegment(entry: SampleEntry, timescale: number): Uint8Array {
  const video = entry.kind === 'video';
  const ftyp = box('ftyp', te.encode('isom'), u32(0x200), te.encode('isomiso6mp41'));
  const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
  const tkhd = fullbox(
    'tkhd', 0, 3,
    u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8),
    u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), MATRIX,
    u32((video ? entry.width : 0) * 65536), u32((video ? entry.height : 0) * 65536),
  );
  const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullbox('hdlr', 0, 0, u32(0), te.encode(video ? 'vide' : 'soun'), zeros(12), te.encode(video ? 'VideoHandler\0' : 'SoundHandler\0'));
  const xmhd = video ? fullbox('vmhd', 0, 1, zeros(8)) : fullbox('smhd', 0, 0, u32(0));
  const dinf = box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
  const stbl = box(
    'stbl',
    fullbox('stsd', 0, 0, u32(1), sampleEntry(entry)),
    fullbox('stts', 0, 0, u32(0)),
    fullbox('stsc', 0, 0, u32(0)),
    fullbox('stsz', 0, 0, u32(0), u32(0)),
    fullbox('stco', 0, 0, u32(0)),
  );
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, stbl)));
  const mvex = box('mvex', fullbox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

export interface FragSample {
  duration: number;
  size: number;
  /** Composition time offset (pts - dts), may be negative. */
  cto: number;
  sync: boolean;
}

/** moof + mdat. */
export function fragment(seq: number, baseDecodeTime: number, samples: FragSample[], data: Uint8Array[]): Uint8Array {
  const entries = samples.map((s) =>
    concat([u32(s.duration), u32(s.size), u32(s.sync ? 0x02000000 : 0x01010000), u32(s.cto | 0)]),
  );
  const build = (dataOffset: number) =>
    box(
      'moof',
      fullbox('mfhd', 0, 0, u32(seq)),
      box(
        'traf',
        fullbox('tfhd', 0, 0x020000, u32(1)), // default-base-is-moof
        fullbox('tfdt', 1, 0, u64(baseDecodeTime)),
        fullbox('trun', 1, 0x000f01, u32(samples.length), u32(dataOffset), ...entries),
      ),
    );
  const moofSize = build(0).length;
  const moof = build(moofSize + 8);
  return concat([moof, box('mdat', ...data)]);
}
