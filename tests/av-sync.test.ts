import { describe, expect, it } from 'vitest';
import { audioFrameMs, MkvDemuxer, type MkvFrame, type MkvTrack } from '@/lib/mkv/ebml';
import { MkvRemuxer, selectTracks } from '@/lib/mkv/remux';
import { Resampler } from '@/lib/mkv/transcode';

// ─── A tiny hand-built MKV: one audio track, blocks of 3 laced frames ─────────

const idBytes = (id: number) => { const b: number[] = []; for (let v = id; v; v = Math.floor(v / 256)) b.unshift(v & 0xff); return b; };
const size = (n: number) => [0x10 | ((n >> 24) & 0x0f), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; // 4-byte vint
const el = (id: number, ...payload: number[][]) => { const body = payload.flat(); return [...idBytes(id), ...size(body.length), ...body]; };
const uint = (v: number) => [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const str = (s: string) => [...new TextEncoder().encode(s)];
const float = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b]; };

function lacedMkv(codecId: string, opts: { defaultDurationNs?: number; frame?: number[] } = {}) {
  const frame = opts.frame ?? Array(40).fill(0x55);
  const track = el(0xae,
    el(0xd7, [1]), el(0x83, [2]), el(0x86, str(codecId)),
    ...(opts.defaultDurationNs ? [el(0x23e383, uint(opts.defaultDurationNs))] : []),
    el(0xe1, el(0xb5, float(48000)), el(0x9f, [2])));
  // SimpleBlock: track 1, relative time t, keyframe + Xiph lacing, 3 frames.
  const block = (t: number) => el(0xa3, [0x81, (t >> 8) & 0xff, t & 0xff, 0x82, 2, frame.length, frame.length, ...frame, ...frame, ...frame]);
  const segment = [
    ...el(0x1549a966, el(0x2ad7b1, uint(1_000_000))),
    ...el(0x1654ae6b, track),
    ...el(0x1f43b675, el(0xe7, [0]), block(0), block(96), block(192)),
  ];
  return new Uint8Array([...el(0x1a45dfa3, el(0x4282, str('matroska'))), ...el(0x18538067, segment)]);
}

function frames(bytes: Uint8Array) {
  const out: MkvFrame[] = [];
  const d = new MkvDemuxer({ onFrame: (f) => out.push(f) });
  d.push(bytes);
  return out;
}

describe('audio stays with the picture', () => {
  it('spreads laced AC-3 frames by their codec duration (32 ms each)', () => {
    const f = frames(lacedMkv('A_AC3'));
    expect(f.map((x) => +x.pts.toFixed(2))).toEqual([0, 32, 64, 96, 128, 160, 192, 224, 256]);
  });

  it('uses the track DefaultDuration when present', () => {
    const f = frames(lacedMkv('A_AAC', { defaultDurationNs: 21_333_333 }));
    expect(f.slice(0, 3).map((x) => +x.pts.toFixed(2))).toEqual([0, 21.33, 42.67]);
  });

  it('reads E-AC-3 and DTS frame lengths from their headers', () => {
    const t = (codecId: string) => ({ codecId, sampleRate: 48000 }) as MkvTrack;
    // E-AC-3: fscod 0, numblkscod 3 (6 blocks) → 1536 samples.
    expect(audioFrameMs(t('A_EAC3'), Uint8Array.of(0x0b, 0x77, 0, 0, 0b00110000))).toBeCloseTo(32);
    // E-AC-3 with 1 block (numblkscod 0) → 256 samples.
    expect(audioFrameMs(t('A_EAC3'), Uint8Array.of(0x0b, 0x77, 0, 0, 0b00000000))).toBeCloseTo(5.333, 2);
    // DTS core: NBLKS = 15 → 512 samples.
    expect(audioFrameMs(t('A_DTS'), Uint8Array.of(0x7f, 0xfe, 0x80, 0x01, 0x00, 15 << 2, 0))).toBeCloseTo(10.667, 2);
    expect(audioFrameMs(t('A_AAC'), new Uint8Array(4))).toBeCloseTo(21.333, 2);
  });

  it('remuxer never squeezes frames that share a time', () => {
    const track: MkvTrack = { number: 2, type: 'audio', codecId: 'A_AC3', language: 'eng', isDefault: true, forced: false, channels: 2, sampleRate: 48000 };
    const header = { timecodeScale: 1e6, segmentStart: 0, tracks: [track] };
    const sel = selectTracks(header);
    const mux = new MkvRemuxer({ ...sel, video: undefined });
    // A valid AC-3 sync frame header so the sample entry can be built.
    const ac3 = Uint8Array.of(0x0b, 0x77, 0, 0, 0x14, 0x40, 0x43, 0, ...Array(100).fill(0));
    const segs: { start: number; end: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const pts = Math.floor(i / 4) * 128; // 4 frames per timestamp, as with lacing and no durations
      const r = mux.push({ track: 2, pts, keyframe: true, data: ac3 });
      if (r) segs.push(...r.segments);
    }
    const last = segs[segs.length - 1];
    // 36+ frames × 32 ms ≈ 1.15 s of audio: it must keep that length, not collapse to a few ms.
    expect(last.end - segs[0].start).toBeGreaterThan(1);
  });

  it('resamples 44.1 kHz to 48 kHz without drift over a film', () => {
    const rs = new Resampler();
    let out = 0;
    const frames = Math.round((60 * 60 * 44100) / 1536); // about an hour of 1536-sample frames
    const l = new Float32Array(1536);
    for (let i = 0; i < frames; i++) out += rs.run(l, l, 44100)[0].length;
    const expected = (frames * 1536 * 48000) / 44100;
    expect(Math.abs(out - expected)).toBeLessThanOrEqual(2); // < 0.1 ms over an hour
  });
});
