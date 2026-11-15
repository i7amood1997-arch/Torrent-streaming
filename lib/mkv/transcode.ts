'use client';
/**
 * Audio the browser can't decode (Dolby Digital / Dolby Digital Plus / DTS in Chrome,
 * Edge and Firefox) is turned into Opus in the page, so these files play with sound:
 *
 *   MKV audio frames → WASM decoder (FFmpeg's eac3 / libdca) → stereo PCM
 *     → WebCodecs AudioEncoder (Opus) → Opus frames into the fMP4 remuxer.
 *
 * Only the audio is re-encoded; the video keeps its original quality.
 */
import type { MkvFrame, MkvTrack } from './ebml';

export type TranscodeCodec = 'eac3' | 'dts';

/** Which decoder handles a Matroska audio track, if any. */
export function transcodeCodec(t: MkvTrack): TranscodeCodec | undefined {
  if (t.codecId === 'A_AC3' || t.codecId === 'A_EAC3' || t.codecId.startsWith('A_AC3/')) return 'eac3';
  if (t.codecId.startsWith('A_DTS')) return 'dts';
  return undefined;
}

/** True if this browser can run the transcoder (WebCodecs Opus encoder + Opus in MSE). */
export function transcodeSupported(isTypeSupported: (mime: string) => boolean): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { AudioEncoder?: unknown }).AudioEncoder === 'function' && isTypeSupported('audio/mp4; codecs="opus"');
}

/** Matroska-style OpusHead for the output track (2 channels, 48 kHz, 312 samples pre-skip). */
export function opusHead(channels = 2, sampleRate = 48000, preSkip = 312): Uint8Array {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  const dv = new DataView(h.buffer);
  h[8] = 1;
  h[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, sampleRate, true);
  dv.setInt16(16, 0, true);
  h[18] = 0;
  return h;
}

/** The output track the remuxer sees: the same track number, now Opus stereo. */
export function opusTrack(source: MkvTrack): MkvTrack {
  return { ...source, codecId: 'A_OPUS', codecPrivate: opusHead(), channels: 2, sampleRate: 48000, outputSampleRate: 48000, codecDelayNs: 0, compression: undefined };
}

/**
 * Stereo downmix. Decoders give channels in WAV order (FL, FR, FC, LFE, BL, BR, SL, SR).
 * Dialogue (centre) is kept clear; LFE is dropped; peaks are softly limited.
 */
export function downmix(ch: Float32Array[]): [Float32Array, Float32Array] {
  const n = ch[0]?.length ?? 0;
  if (ch.length === 1) return [ch[0], ch[0]];
  if (ch.length === 2) return [ch[0], ch[1]];
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const [fl, fr, fc] = ch;
  const backL = ch.length >= 6 ? ch[4] : ch.length === 4 ? ch[2] : undefined;
  const backR = ch.length >= 6 ? ch[5] : ch.length === 4 ? ch[3] : undefined;
  const sideL = ch.length >= 8 ? ch[6] : undefined;
  const sideR = ch.length >= 8 ? ch[7] : undefined;
  const centre = ch.length === 3 || ch.length >= 5 ? fc : undefined;
  const limit = (x: number) => (x > 0.9 ? 0.9 + Math.tanh((x - 0.9) * 10) / 10 : x < -0.9 ? -0.9 + Math.tanh((x + 0.9) * 10) / 10 : x);
  for (let i = 0; i < n; i++) {
    const c = centre ? centre[i] * 0.6 : 0;
    let l = fl[i] * 0.6 + c;
    let r = fr[i] * 0.6 + c;
    if (backL) { l += backL[i] * 0.4; r += backR![i] * 0.4; }
    if (sideL) { l += sideL[i] * 0.35; r += sideR![i] * 0.35; }
    L[i] = limit(l);
    R[i] = limit(r);
  }
  return [L, R];
}

interface Decoder { decode(data: Uint8Array): { channelData: Float32Array[]; sampleRate: number }; free(): void }

async function loadDecoder(codec: TranscodeCodec): Promise<Decoder> {
  // Loaded only when a file needs it (each is a single-file WASM module, a few hundred KB).
  if (codec === 'dts') return (await import('@audio/decode-dts')).decoder() as Promise<Decoder>;
  return (await import('@audio/decode-eac3')).decoder() as Promise<Decoder>;
}

/**
 * Streams frames through decode → downmix → Opus encode. Output frames arrive
 * asynchronously through `onFrame`; `reset()` (after a seek) drops anything in flight.
 */
export class AudioTranscoder {
  private decoder?: Decoder;
  private encoder?: AudioEncoder;
  private ready: Promise<void>;
  private queue: MkvFrame[] = [];
  private gen = 0;
  private rate = 48000;
  /** Sample-accurate output clock (µs); re-anchored to the file's timestamps after a jump. */
  private clock?: number;
  private resampler = new Resampler();
  private failed = false;

  constructor(
    private codec: TranscodeCodec,
    private trackNumber: number,
    private onFrame: (f: MkvFrame) => void,
    private onError: (message: string) => void,
  ) {
    this.ready = this.init();
  }

  private async init() {
    try {
      this.decoder = await loadDecoder(this.codec);
      this.makeEncoder();
      const q = this.queue;
      this.queue = [];
      for (const f of q) this.push(f);
    } catch (e) {
      this.fail(`Couldn’t start the audio converter (${(e as Error).message}).`);
    }
  }

  private makeEncoder() {
    const gen = this.gen;
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        if (gen !== this.gen) return; // from before a seek
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.onFrame({ track: this.trackNumber, pts: chunk.timestamp / 1000, keyframe: true, data, durationMs: chunk.duration ? chunk.duration / 1000 : 20 });
      },
      error: (e) => this.fail(`The audio converter stopped (${e.message}).`),
    });
    this.encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000 });
  }

  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    this.onError(message);
  }

  push(f: MkvFrame) {
    if (this.failed) return;
    if (!this.decoder || !this.encoder) { this.queue.push(f); return; }
    let out: { channelData: Float32Array[]; sampleRate: number };
    try {
      out = this.decoder.decode(f.data);
    } catch {
      return; // a damaged frame: skip it
    }
    const n = out.channelData[0]?.length ?? 0;
    if (!n) return;
    let [l, r] = downmix(out.channelData);
    if (out.sampleRate && out.sampleRate !== 48000) [l, r] = this.resampler.run(l, r, out.sampleRate);
    this.rate = 48000;
    const frames = l.length;
    if (!frames) return;
    // Timestamps from a running sample count, so they line up exactly however the file stores them
    // (laced frames, rounding); follow the file again if it jumps (gap, seek) by more than 150 ms.
    const fileTime = Math.round(f.pts * 1000);
    if (this.clock === undefined || Math.abs(this.clock - fileTime) > 150_000) this.clock = fileTime;
    const timestamp = this.clock;
    this.clock += (frames / 48000) * 1e6;
    const planar = new Float32Array(frames * 2);
    planar.set(l, 0);
    planar.set(r, frames);
    const data = new AudioData({ format: 'f32-planar', sampleRate: this.rate, numberOfFrames: frames, numberOfChannels: 2, timestamp: Math.round(timestamp), data: planar });
    try {
      this.encoder.encode(data);
    } catch (e) {
      this.fail(`The audio converter stopped (${(e as Error).message}).`);
    } finally {
      data.close();
    }
  }

  /** After a seek: forget pending audio and start a fresh stream. */
  reset() {
    this.gen++;
    this.queue = [];
    this.clock = undefined;
    this.resampler = new Resampler();
    if (this.failed || !this.encoder) return; // not started yet: init() makes the encoder
    try { this.encoder.close(); } catch { /* already closed */ }
    this.makeEncoder();
  }

  /** Encode what's left (end of file). */
  async flush() {
    await this.ready;
    try { await this.encoder?.flush(); } catch { /* closed */ }
  }

  destroy() {
    this.gen++;
    this.failed = true;
    try { this.encoder?.close(); } catch { /* closed */ }
    this.decoder?.free();
  }
}

/**
 * Linear resampling to 48 kHz that carries its position across frames, so no samples are
 * lost to rounding at frame edges (that would add up to seconds of drift over a film).
 */
export class Resampler {
  private pos = 0; // read position in the next input (may be -1..0: between the previous frame's last sample and this one)
  private lastL = 0;
  private lastR = 0;

  run(l: Float32Array, r: Float32Array, from: number): [Float32Array, Float32Array] {
    const step = from / 48000;
    const outL: number[] = [];
    const outR: number[] = [];
    for (; this.pos < l.length - 1; this.pos += step) {
      const k = Math.floor(this.pos);
      const t = this.pos - k;
      const l0 = k < 0 ? this.lastL : l[k];
      const r0 = k < 0 ? this.lastR : r[k];
      outL.push(l0 * (1 - t) + l[k + 1] * t);
      outR.push(r0 * (1 - t) + r[k + 1] * t);
    }
    this.pos -= l.length;
    this.lastL = l[l.length - 1];
    this.lastR = r[r.length - 1];
    return [Float32Array.from(outL), Float32Array.from(outR)];
  }
}
