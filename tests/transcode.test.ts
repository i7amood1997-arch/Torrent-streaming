import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decoder } from '@audio/decode-eac3';
import { downmix, opusHead, opusTrack, transcodeCodec } from '@/lib/mkv/transcode';
import { selectTracks } from '@/lib/mkv/remux';
import type { MkvHeader, MkvTrack } from '@/lib/mkv/ebml';

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

describe('Dolby / DTS audio conversion', () => {
  it('decodes E-AC-3 5.1 and downmixes it to audible stereo', async () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'tone-5.1.eac3')));
    const dec = await decoder();
    const out = dec.decode(bytes);
    dec.free();
    expect(out.sampleRate).toBe(48000);
    expect(out.channelData.length).toBe(6);
    const [l, r] = downmix(out.channelData);
    expect(l.length).toBeGreaterThan(20000);
    const source = Math.max(...out.channelData.map(rms));
    expect(source).toBeGreaterThan(0.05); // the decoder produced the tone
    expect(rms(l)).toBeGreaterThan(source * 0.5); // and it survives the downmix
    expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(rms(r)).toBeCloseTo(rms(l), 2);
  });

  it('keeps dialogue (centre) in both ears and drops LFE', () => {
    const n = 4;
    const z = () => new Float32Array(n);
    const centre = new Float32Array(n).fill(0.5);
    const lfe = new Float32Array(n).fill(0.9);
    const [l, r] = downmix([z(), z(), centre, lfe, z(), z()]);
    expect(l[0]).toBeCloseTo(0.3);
    expect(r[0]).toBeCloseTo(0.3);
  });

  it('picks convertible audio when nothing plays as-is', () => {
    const video: MkvTrack = { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: Uint8Array.of(1, 0x64, 0, 0x28, 0xff), language: 'eng', isDefault: true, forced: false, width: 1920, height: 1080 };
    const audio: MkvTrack = { number: 2, type: 'audio', codecId: 'A_EAC3', language: 'eng', isDefault: true, forced: false, channels: 6, sampleRate: 48000 };
    const header: MkvHeader = { timecodeScale: 1e6, tracks: [video, audio], segmentStart: 0 };
    const noDolby = (mime: string) => !/ec-3|ac-3/.test(mime);
    expect(selectTracks(header, { isSupported: noDolby }).audio).toBeUndefined();
    const sel = selectTracks(header, { isSupported: noDolby, transcode: true });
    expect(sel.audio?.transcodeFrom).toBe(audio);
    expect(sel.audio?.plan.mime).toBe('audio/mp4; codecs="opus"');
    expect(sel.audio?.track.number).toBe(2);
    // Where Dolby plays natively (Safari), nothing is converted.
    expect(selectTracks(header, { isSupported: () => true, transcode: true }).audio?.transcodeFrom).toBeUndefined();
  });

  it('knows which codecs it can convert and builds a valid OpusHead', () => {
    const t = (codecId: string) => ({ number: 1, type: 'audio', codecId, language: 'und', isDefault: true, forced: false }) as MkvTrack;
    expect(transcodeCodec(t('A_AC3'))).toBe('eac3');
    expect(transcodeCodec(t('A_EAC3'))).toBe('eac3');
    expect(transcodeCodec(t('A_DTS'))).toBe('dts');
    expect(transcodeCodec(t('A_TRUEHD'))).toBeUndefined();
    const head = opusHead();
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
    expect(head[9]).toBe(2);
    expect(opusTrack(t('A_EAC3')).codecId).toBe('A_OPUS');
  });
});
