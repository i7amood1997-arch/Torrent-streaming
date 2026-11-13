import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agrees, alignSubtitles, confident, type SpeechSample } from '@/lib/autosync';
import { openSubtitlesHash } from '@/lib/subtitle-hash';
import type { SubtitleCue } from '@/lib/types';

describe('OpenSubtitles hash', () => {
  it('matches an independent implementation', () => {
    const buf = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'hash-sample.bin')));
    expect(openSubtitlesHash(buf.subarray(0, 65536), buf.subarray(buf.length - 65536), buf.length)).toBe('39777639c2c50859');
  });
});

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

/** Dialogue lines over `minutes`, as subtitle cues in the subtitle's own time base. */
function dialogue(minutes: number, seed = 1): SubtitleCue[] {
  const r = rng(seed);
  const cues: SubtitleCue[] = [];
  let t = 2;
  while (t < minutes * 60) {
    const len = 1 + r() * 4;
    cues.push({ start: t, end: t + len, text: 'line' });
    t += len + 0.3 + r() * (r() < 0.2 ? 15 : 3);
  }
  return cues;
}

/** What the audio tap would record if speech happens at cue * scale + offset (plus noise). */
function speech(cues: SubtitleCue[], offset: number, scale: number, seconds: number, seed = 7): SpeechSample[] {
  const r = rng(seed);
  const out: SpeechSample[] = [];
  for (let t = 0; t < seconds; t += 0.1) {
    const talking = cues.some((c) => t >= c.start * scale + offset && t < c.end * scale + offset);
    const music = r() < 0.12; // loud non-speech moments
    const e = (talking || music ? -32 : -58) + (r() - 0.5) * 16;
    out.push({ t, e });
  }
  return out;
}

describe('automatic subtitle sync', () => {
  const cues = dialogue(6);

  it('finds a constant delay', () => {
    const a = alignSubtitles(speech(cues, 2.3, 1, 180), cues)!;
    expect(a.scale).toBe(1);
    expect(Math.abs(a.offset - 2.3)).toBeLessThanOrEqual(0.08);
    expect(confident(a)).toBe(true);
  });

  it('finds a frame-rate mismatch (25 vs 23.976 fps) plus a delay', () => {
    const scale = 25 / 23.976;
    const a = alignSubtitles(speech(cues, -1.4, scale, 240), cues)!;
    expect(a.scale).toBeCloseTo(scale, 6);
    expect(Math.abs(a.offset + 1.4)).toBeLessThanOrEqual(0.15);
    expect(confident(a)).toBe(true);
  });

  it('respects the current offset as the search centre', () => {
    const a = alignSubtitles(speech(cues, 30.5, 1, 200), cues, { center: 30, range: 5 })!;
    expect(Math.abs(a.offset - 30.5)).toBeLessThanOrEqual(0.08);
  });

  it('is not confident about subtitles from a different film', () => {
    const other = dialogue(6, 99);
    expect(confident(alignSubtitles(speech(cues, 0, 1, 200), other))).toBe(false);
  });

  it('needs at least a minute of audio', () => {
    expect(alignSubtitles(speech(cues, 1, 1, 40), cues)).toBeUndefined();
  });

  it('agreement check', () => {
    const base = { offset: 1, scale: 1, z: 9, ratio: 2, seconds: 120 };
    expect(agrees(base, { ...base, offset: 1.15 })).toBe(true);
    expect(agrees(base, { ...base, offset: 1.5 })).toBe(false);
    expect(agrees(base, { ...base, scale: 25 / 23.976 })).toBe(false);
  });
});

import { alignToReference, anchorOffset, fitTrack, fits, planWindows } from '@/lib/presync';

describe('up-front sync', () => {
  const film = dialogue(90, 3);
  /** Audio stretches as the offline analyser would return them. */
  const stretches = (cues: SubtitleCue[], starts: number[], len: number, map: (t: number) => number) =>
    starts.map((s) => speech(cues.map((c) => ({ ...c, start: map(c.start), end: map(c.end) })), 0, 1, 90 * 60 * 1.1).filter((x) => x.t >= s && x.t < s + len));

  it('plans stretches across the dialogue', () => {
    const w = planWindows(film, 5400, 4, 60);
    expect(w.length).toBe(4);
    expect(w[0]).toBeLessThan(1500);
    expect(w[3]).toBeGreaterThan(3500);
  });

  it('fits shift and speed from four one-minute stretches', () => {
    const scale = 25 / 23.976;
    const starts = planWindows(film, 5400, 4, 60).map((s) => s * scale);
    const f = fitTrack(stretches(film, starts, 60, (t) => t * scale + 3.7), film)!;
    expect(f.scale).toBeCloseTo(scale, 6);
    expect(Math.abs(f.offset - 3.7)).toBeLessThanOrEqual(0.15);
    expect(fits(f)).toBe(true);
  });

  it('notices a subtitle made for a different cut', () => {
    const starts = planWindows(film, 5400, 4, 60);
    // 6 s of extra footage in the middle: the second half is shifted.
    const f = fitTrack(stretches(film, starts, 60, (t) => (t < 2700 ? t + 1 : t + 7)), film);
    expect(fits(f)).toBe(false);
  });

  it('lines a subtitle up with a reference in another language', () => {
    const ref = dialogue(20, 5);
    // Same dialogue rhythm, slightly different line lengths, 4.2 s early.
    const other = ref.map((c, i) => ({ start: c.start - 4.2 + (i % 3) * 0.1, end: c.end - 4.2 - (i % 2) * 0.2, text: 'x' }));
    const a = alignToReference(ref, other)!;
    expect(confident(a)).toBe(true);
    expect(Math.abs(a.offset - 4.2)).toBeLessThanOrEqual(0.2);
  });

  it('finds the shift from recognised words', () => {
    const vocab = Array.from({ length: 120 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}${i}`.replace(/\d/g, (d) => 'ghijklmnop'[+d]));
    const r = rng(11);
    const cues: SubtitleCue[] = Array.from({ length: 60 }, (_, i) => ({ start: i * 4, end: i * 4 + 3, text: Array.from({ length: 5 }, () => vocab[Math.floor(r() * vocab.length)]).join(' ') }));
    const words = cues.slice(10, 25).flatMap((c) => c.text.split(' ').map((w, k) => ({ word: w, start: c.start + 0.3 + k * 0.6 - 2.5 })));
    const a = anchorOffset(words, cues)!;
    expect(Math.abs(a.offset + 2.5)).toBeLessThanOrEqual(0.3);
    expect(a.ratio).toBeGreaterThan(1.5);
  });
});
