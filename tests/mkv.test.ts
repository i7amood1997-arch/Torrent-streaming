/**
 * MKV → fMP4 converter. Fixtures were made with ffmpeg (x264/x265 with B-frames,
 * AAC/AC-3/E-AC-3, an ASS subtitle track). Decoding of the converted output was
 * additionally verified with ffmpeg/ffprobe and in Chromium (MSE) during development.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dac3, hevcCodec, planTrack } from '@/lib/mkv/codecs';
import { MkvDemuxer, unlace, type CuePoint, type MkvFrame, type MkvHeader } from '@/lib/mkv/ebml';
import { MkvRemuxer, selectTracks, subtitleText, TIMELINE_OFFSET_MS, type SubtitleCue } from '@/lib/mkv/remux';

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));

function demux(bytes: Uint8Array, chunk = 997) {
  let header: MkvHeader | undefined;
  let cues: CuePoint[] = [];
  const frames: MkvFrame[] = [];
  const d = new MkvDemuxer({ onHeader: (h) => (header = h), onFrame: (f) => frames.push({ ...f, data: f.data.slice() }), onCues: (c) => (cues = c) });
  for (let o = 0; o < bytes.length; o += chunk) d.push(bytes.subarray(o, o + chunk));
  return { header: header!, frames, cues, demuxer: d };
}

/** Minimal ISO-BMFF walker: per fragment, tfdt + trun samples. */
function readFragments(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = (o: number) => String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
  const frags: { base: number; samples: { duration: number; size: number; flags: number; cto: number }[] }[] = [];
  const walk = (start: number, end: number) => {
    for (let o = start; o < end;) {
      const size = dv.getUint32(o);
      const t = type(o);
      if (t === 'moof' || t === 'traf') walk(o + 8, o + size);
      else if (t === 'tfdt') frags.push({ base: Number(dv.getBigUint64(o + 12)), samples: [] });
      else if (t === 'trun') {
        const n = dv.getUint32(o + 12);
        for (let i = 0; i < n; i++) {
          const p = o + 20 + i * 16;
          frags[frags.length - 1].samples.push({ duration: dv.getUint32(p), size: dv.getUint32(p + 4), flags: dv.getUint32(p + 8), cto: dv.getInt32(p + 12) });
        }
      }
      o += size;
    }
  };
  walk(0, buf.length);
  return frags;
}

function remuxAll(bytes: Uint8Array) {
  const cues: SubtitleCue[] = [];
  let remux: MkvRemuxer | undefined;
  const out: Record<'video' | 'audio', Uint8Array[]> = { video: [], audio: [] };
  const inits: Record<string, Uint8Array> = {};
  const d = new MkvDemuxer({
    onHeader: (h) => { remux = new MkvRemuxer(selectTracks(h), (c) => cues.push(c)); },
    onFrame: (f) => {
      const r = remux!.push(f);
      if (!r) return;
      if (r.init) inits[r.kind] = r.init;
      for (const s of r.segments) out[s.kind].push(s.data);
    },
  });
  for (let o = 0; o < bytes.length; o += 4096) d.push(bytes.subarray(o, o + 4096));
  for (const s of remux!.flush()) out[s.kind].push(s.data);
  const join = (a: Uint8Array[]) => { const n = a.reduce((x, y) => x + y.length, 0); const r = new Uint8Array(n); let o = 0; for (const p of a) { r.set(p, o); o += p.length; } return r; };
  return { remux: remux!, inits, video: join(out.video), audio: join(out.audio), cues };
}

describe('Matroska demuxer', () => {
  it('reads tracks, frames and cues from data arriving in small chunks', () => {
    const { header, frames, cues } = demux(fixture('h264-aac-ass.mkv'));
    expect(header.tracks.map((t) => [t.type, t.codecId])).toEqual([['video', 'V_MPEG4/ISO/AVC'], ['audio', 'A_AAC'], ['subtitle', 'S_TEXT/ASS']]);
    expect(header.tracks[1].language).toBe('jpn');
    expect(Math.round(header.durationMs!)).toBeGreaterThan(7900);
    const count = (n: number) => frames.filter((f) => f.track === n).length;
    expect([count(1), count(2), count(3)]).toEqual([192, 376, 2]); // ffprobe packet counts
    expect(frames.find((f) => f.track === 1)!.keyframe).toBe(true);
    expect(cues.length).toBeGreaterThan(0);
  });

  it('applies CodecDelay (AAC priming) like ffmpeg does', () => {
    const { header, frames } = demux(fixture('h264-aac-ass.mkv'));
    const aac = header.tracks.find((t) => t.type === 'audio')!;
    expect(aac.codecDelayNs).toBeGreaterThan(0);
    expect(frames.find((f) => f.track === aac.number)!.pts).toBeCloseTo(-aac.codecDelayNs! / 1e6, 3);
  });

  it('resumes at a cue point after seeking', () => {
    const bytes = fixture('h264-aac-ass.mkv');
    const { cues, header } = demux(bytes);
    const target = cues.filter((c) => c.track === 1).at(-1)!;
    const got: MkvFrame[] = [];
    const d = new MkvDemuxer({ onFrame: (f) => got.push(f) });
    d.push(bytes.subarray(0, target.pos)); // learns the header (and its clusters)
    got.length = 0;
    d.seekTo(target.pos, false, header.segmentStart);
    d.push(bytes.subarray(target.pos));
    const firstVideo = got.find((f) => f.track === 1)!;
    expect(firstVideo.keyframe).toBe(true);
    expect(Math.abs(firstVideo.pts - target.timeMs)).toBeLessThan(1);
  });

  it('resyncs to the next cluster from an arbitrary offset', () => {
    const bytes = fixture('h264-aac-ass.mkv');
    const { header } = demux(bytes);
    const got: MkvFrame[] = [];
    const d = new MkvDemuxer({ onFrame: (f) => got.push(f) });
    d.push(bytes.subarray(0, 2000));
    d.seekTo(Math.floor(bytes.length / 2), true, header.segmentStart);
    d.push(bytes.subarray(Math.floor(bytes.length / 2)));
    expect(got.length).toBeGreaterThan(50);
    expect(got[0].pts).toBeGreaterThan(2000);
  });

  it('splits Xiph, EBML and fixed lacing', () => {
    const frames = [new Uint8Array(300).fill(1), new Uint8Array(5).fill(2), new Uint8Array(7).fill(3)];
    const body = new Uint8Array([...frames[0], ...frames[1], ...frames[2]]);
    const xiph = new Uint8Array([2, 255, 45, 5, ...body]);
    expect(unlace(xiph, 0, 1).map((f) => f.length)).toEqual([300, 5, 7]);
    // EBML: first size 300 as a 2-byte vint (0x412C), then 5-300 = -295 as a signed 2-byte vint
    const delta = -295 + (2 ** 13 - 1);
    const ebml = new Uint8Array([2, 0x41, 0x2c, 0x40 | (delta >> 8), delta & 0xff, ...body]);
    expect(unlace(ebml, 0, 3).map((f) => f.length)).toEqual([300, 5, 7]);
    const fixed = new Uint8Array([2, ...new Uint8Array(30)]);
    expect(unlace(fixed, 0, 2).map((f) => f.length)).toEqual([10, 10, 10]);
  });
});

describe('codec mapping', () => {
  it('builds codec strings and Dolby config boxes', () => {
    const h264 = demux(fixture('h264-ac3.mkv'));
    const hevc = demux(fixture('hevc-eac3.mkv'));
    const plan = (h: MkvHeader, type: string) => planTrack(h.tracks.find((t) => t.type === type)!) as Exclude<ReturnType<typeof planTrack>, { unsupported: string }>;
    expect(plan(h264.header, 'video').codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
    expect(plan(h264.header, 'audio').codec).toBe('ac-3');
    expect(plan(hevc.header, 'video').codec).toBe(hevcCodec(hevc.header.tracks[0].codecPrivate!));
    expect(plan(hevc.header, 'video').codec).toMatch(/^hvc1\.1\.6\.L\d+\.90$/);
    expect(plan(hevc.header, 'audio').codec).toBe('ec-3');
    const ac3Frame = h264.frames.find((f) => f.track === 2)!.data;
    const box = dac3(ac3Frame);
    expect(new TextDecoder().decode(box.subarray(4, 8))).toBe('dac3');
    expect(box[8] >> 6).toBe(0); // fscod 0 = 48 kHz
  });

  it('refuses codecs browsers cannot play, with a readable reason', () => {
    expect(planTrack({ number: 2, type: 'audio', codecId: 'A_DTS', language: 'eng', isDefault: true, forced: false })).toEqual({ unsupported: 'audio codec DTS' });
    expect(planTrack({ number: 2, type: 'audio', codecId: 'A_TRUEHD', language: 'eng', isDefault: true, forced: false })).toEqual({ unsupported: 'audio codec Dolby TrueHD' });
  });

  it('prefers supported audio in the requested language', () => {
    const { header } = demux(fixture('h264-aac-ass.mkv'));
    const two = { ...header, tracks: [...header.tracks, { ...header.tracks[1], number: 9, language: 'eng', isDefault: false }] };
    expect(selectTracks(two, { audioLanguages: ['en'] }).audio!.track.number).toBe(9);
    expect(selectTracks(two, { audioLanguages: ['ja'] }).audio!.track.number).toBe(2);
    const noAac = selectTracks(header, { isSupported: (m) => !m.includes('mp4a') });
    expect(noAac.audio).toBeUndefined();
    expect(noAac.problems.join()).toMatch(/isn't supported/);
  });
});

describe('remuxer output', () => {
  for (const name of ['h264-aac-ass.mkv', 'hevc-eac3.mkv', 'h264-ac3.mkv']) {
    it(`${name}: every frame, monotonic decode times, decode before display`, () => {
      const bytes = fixture(name);
      const { frames } = demux(bytes);
      const { inits, video, audio } = remuxAll(bytes);
      expect(inits.video && inits.audio).toBeTruthy();
      for (const [kind, data, track] of [['video', video, 1], ['audio', audio, 2]] as const) {
        const frags = readFragments(data);
        const samples = frags.flatMap((f) => f.samples);
        expect(samples.length, kind).toBe(frames.filter((f) => f.track === track).length);
        let dts = -1;
        for (const f of frags) {
          expect(f.base).toBeGreaterThanOrEqual(dts); // fragments continue where the last ended
          let t = f.base;
          for (const s of f.samples) {
            expect(t).toBeGreaterThan(dts);
            expect(s.cto).toBeGreaterThanOrEqual(0);
            dts = t;
            t += s.duration;
          }
        }
      }
      // Presentation times equal the source's (shifted by the timeline offset).
      const ts = 90000;
      const pts = readFragments(video).flatMap((f) => { let t = f.base; return f.samples.map((s) => { const p = t + s.cto; t += s.duration; return p; }); }).sort((a, b) => a - b);
      const src = frames.filter((f) => f.track === 1).map((f) => Math.round(((f.pts + TIMELINE_OFFSET_MS) * ts) / 1000)).sort((a, b) => a - b);
      expect(pts).toEqual(src);
    });
  }

  it('extracts embedded subtitles onto the media timeline', () => {
    const { cues } = remuxAll(fixture('h264-aac-ass.mkv'));
    expect(cues.map((c) => c.text)).toEqual(['Hello, world!\nSecond line', 'Comma, inside, text']);
    expect(cues[0].start).toBeCloseTo(1 + TIMELINE_OFFSET_MS / 1000, 3);
    expect(cues[0].end).toBeCloseTo(3.5 + TIMELINE_OFFSET_MS / 1000, 3);
  });

  it('cleans ASS and SRT text', () => {
    const te = new TextEncoder();
    expect(subtitleText(te.encode('0,0,Default,,0,0,0,,{\\an8}Top\\Nline\\hhere'), 'S_TEXT/ASS')).toBe('Top\nline here');
    expect(subtitleText(te.encode('0,0,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10'), 'S_TEXT/ASS')).toBe('');
    expect(subtitleText(te.encode('<i>Plain</i> text'), 'S_TEXT/UTF8')).toBe('Plain text');
  });
});

describe('converter after a seek or a data error', () => {
  it('waits for a keyframe before sending video (no frozen picture with the sound playing on)', () => {
    const { header, frames } = demux(fixture('h264-aac-ass.mkv'));
    const remux = new MkvRemuxer(selectTracks(header), () => undefined);
    const video = frames.filter((f) => f.track === 1);
    const firstKey = video.findIndex((f, i) => i > 0 && f.keyframe);
    expect(firstKey).toBeGreaterThan(5);
    for (const f of video.slice(0, 3)) remux.push(f); // playing normally
    remux.reset(); // seek / resync lands mid-GOP
    const out: Uint8Array[] = [];
    for (const f of video.slice(3)) { const r = remux.push(f); for (const s of r?.segments ?? []) if (s.kind === 'video') out.push(s.data); }
    for (const s of remux.flush()) if (s.kind === 'video') out.push(s.data);
    const samples = out.flatMap((d) => readFragments(d).flatMap((fr) => fr.samples));
    expect(samples.length).toBe(video.length - firstKey);
    expect(samples[0].flags & 0x10000).toBe(0); // first sample is a sync sample (not "non-sync")
  });
});
