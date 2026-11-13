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
