/**
 * Turn compressed audio frames (from an MKV or MP4) into a small standalone audio file
 * that a speech recogniser can decode, without decoding anything here:
 *  - AAC → ADTS stream (.aac)
 *  - AC-3 / E-AC-3 / DTS / MP3 / MP2 / TrueHD → frames back to back (self-synchronising)
 *  - FLAC → "fLaC" + metadata + frames
 *  - Opus / Vorbis → Ogg pages
 *  - PCM (little-endian) → WAV
 */

export type AudioCodec = 'aac' | 'ac3' | 'eac3' | 'dts' | 'mp3' | 'mp2' | 'truehd' | 'flac' | 'opus' | 'vorbis' | 'pcm';

export interface AudioTrackInfo {
  codec: AudioCodec;
  /** AAC AudioSpecificConfig / OpusHead / Vorbis Xiph-laced headers / FLAC "fLaC"+metadata. */
  config?: Uint8Array;
  sampleRate: number;
  channels: number;
  bitDepth?: number;
}

export interface AudioFrame {
  t: number; // seconds
  data: Uint8Array;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Profile / sample-rate index / channel configuration for ADTS headers. */
export function adtsParams(asc: Uint8Array | undefined, sampleRate: number, channels: number) {
  let aot = 2;
  let sfi = SAMPLE_RATES.indexOf(sampleRate);
  let ch = channels;
  if (asc && asc.length >= 2) {
    let bit = 0;
    const read = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
      return v;
    };
    aot = read(5);
    if (aot === 31) aot = 32 + read(6);
    sfi = read(4);
    if (sfi === 15) {
      const rate = read(24);
      sfi = SAMPLE_RATES.reduce((best, r, i) => (Math.abs(r - rate) < Math.abs(SAMPLE_RATES[best] - rate) ? i : best), 0);
    }
    ch = read(4);
  }
  if (sfi < 0) sfi = SAMPLE_RATES.reduce((best, r, i) => (Math.abs(r - sampleRate) < Math.abs(SAMPLE_RATES[best] - sampleRate) ? i : best), 0);
  // ADTS can only signal AAC Main/LC/SSR/LTP; HE-AAC (SBR/PS) is LC with implicit signalling.
  const profile = aot >= 1 && aot <= 4 ? aot - 1 : 1;
  if (ch === 0 || ch > 7) ch = Math.min(channels || 2, 7);
  return { profile, sfi, ch };
}

export function adts(frames: Uint8Array[], p: { profile: number; sfi: number; ch: number }): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of frames) {
    const len = f.length + 7;
    parts.push(Uint8Array.of(
      0xff, 0xf1,
      (p.profile << 6) | (p.sfi << 2) | (p.ch >> 2),
      ((p.ch & 3) << 6) | (len >> 11),
      (len >> 3) & 0xff,
      ((len & 7) << 5) | 0x1f,
      0xfc,
    ), f);
  }
  return concat(parts);
}

// ─── Ogg ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(b: Uint8Array) {
  let crc = 0;
  for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ b[i]]) >>> 0;
  return crc >>> 0;
}

/** One Ogg page holding whole packets (each under ~64 KB). */
export function oggPage(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const header = new Uint8Array(27 + lacing.length);
  const dv = new DataView(header.buffer);
  header.set([0x4f, 0x67, 0x67, 0x53]); // OggS
  header[5] = flags;
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  header[26] = lacing.length;
  header.set(lacing, 27);
  const page = concat([header, ...packets]);
  new DataView(page.buffer).setUint32(22, oggCrc(page), true);
  return page;
}

function oggStream(headers: Uint8Array[][], frames: AudioFrame[], rate: number, granuleOffset = 0): Uint8Array {
  const serial = 0x5354524d;
  let seq = 0;
  const pages = headers.map((pk, i) => oggPage(pk, 0, serial, seq++, i === 0 ? 2 : 0));
  const t0 = frames[0]?.t ?? 0;
  for (let i = 0; i < frames.length; i += 16) {
    const group = frames.slice(i, i + 16);
    const next = frames[i + 16]?.t ?? group[group.length - 1].t + 0.02;
    const last = i + 16 >= frames.length;
    pages.push(oggPage(group.map((f) => f.data), Math.round((next - t0) * rate) + granuleOffset, serial, seq++, last ? 4 : 0));
  }
  return concat(pages);
}

/** Matroska's Vorbis CodecPrivate: Xiph-laced identification, comment and setup headers. */
export function xiphHeaders(cp: Uint8Array): Uint8Array[] {
  const count = cp[0] + 1;
  let o = 1;
  const sizes: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    let n = 0;
    while (cp[o] === 255) { n += 255; o++; }
    n += cp[o++];
    sizes.push(n);
  }
  const out: Uint8Array[] = [];
  for (const n of sizes) { out.push(cp.subarray(o, o + n)); o += n; }
  out.push(cp.subarray(o));
  return out;
}

// ─── WAV ────────────────────────────────────────────────────────────────────

function wav(pcm: Uint8Array, rate: number, channels: number, bits: number): Uint8Array {
  const h = new Uint8Array(44);
  const dv = new DataView(h.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, (rate * channels * bits) / 8, true); dv.setUint16(32, (channels * bits) / 8, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, pcm.length, true);
  return concat([h, pcm]);
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** Build a decodable audio file from frames. Returns the bytes and a MIME type. */
export function buildAudioFile(track: AudioTrackInfo, frames: AudioFrame[]): { bytes: Uint8Array; mime: string } {
  const data = frames.map((f) => f.data);
  switch (track.codec) {
    case 'aac':
      return { bytes: adts(data, adtsParams(track.config, track.sampleRate, track.channels)), mime: 'audio/aac' };
    case 'ac3': return { bytes: concat(data), mime: 'audio/ac3' };
    case 'eac3': return { bytes: concat(data), mime: 'audio/eac3' };
    case 'dts': return { bytes: concat(data), mime: 'audio/vnd.dts' };
    case 'mp3': return { bytes: concat(data), mime: 'audio/mpeg' };
    case 'mp2': return { bytes: concat(data), mime: 'audio/mpeg' };
    case 'truehd': return { bytes: concat(data), mime: 'audio/vnd.dolby.mlp' };
    case 'flac': {
      const head = track.config && track.config.length > 4 ? track.config : undefined;
      if (!head) throw new Error('FLAC track without its header');
      return { bytes: concat([head, ...data]), mime: 'audio/flac' };
    }
    case 'opus': {
      const head = track.config && new TextDecoder().decode(track.config.subarray(0, 8)) === 'OpusHead' ? track.config
        : Uint8Array.of(0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, track.channels || 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0);
      const vendor = new TextEncoder().encode('streamdeck');
      const tags = concat([new TextEncoder().encode('OpusTags'), Uint8Array.of(vendor.length, 0, 0, 0), vendor, Uint8Array.of(0, 0, 0, 0)]);
      const preSkip = head[10] | (head[11] << 8);
      return { bytes: oggStream([[head], [tags]], frames, 48000, preSkip), mime: 'audio/ogg' };
    }
    case 'vorbis': {
      if (!track.config) throw new Error('Vorbis track without its headers');
      const [id, comment, setup] = xiphHeaders(track.config);
      return { bytes: oggStream([[id], [comment, setup]], frames, track.sampleRate), mime: 'audio/ogg' };
    }
    case 'pcm':
      return { bytes: wav(concat(data), track.sampleRate, track.channels, track.bitDepth ?? 16), mime: 'audio/wav' };
  }
}
