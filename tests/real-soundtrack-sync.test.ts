/**
 * Subtitle sync against a real film soundtrack (Tears of Steel, CC BY 3.0) with its official,
 * known-correct subtitles, shifted the ways real releases differ. Plain loudness was fooled by the
 * film's music and effects; the speech measure (speechiness) has to get every case right.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { speechiness, type SpeechSample } from '@/lib/autosync';
import { fitTrack, fits, planWindows } from '@/lib/presync';
import { parseSubtitles } from '@/lib/subtitle-parser';
import type { SubtitleCue } from '@/lib/types';

const dir = path.join(__dirname, 'fixtures');
const levels = readFileSync(path.join(dir, 'tos-speechband-10ms.u8'));
const power = Float64Array.from(levels, (b) => 10 ** ((b / 2 - 120) / 10));
const cues = parseSubtitles(readFileSync(path.join(dir, 'tos-en.srt'), 'utf8'));
const DURATION = power.length / 100;

/** What the app's up-front sync measures: one-minute stretches planned from the subtitle. */
function stretches(subtitle: SubtitleCue[], measure: (p: Float64Array) => number[]): SpeechSample[][] {
  return planWindows(subtitle, DURATION, 4, 60).map((s) => measure(power.subarray(s * 100, (s + 60) * 100)).map((e, i) => ({ t: s + i / 10, e })));
}
const plainLoudness = (p: Float64Array) => Array.from({ length: Math.floor(p.length / 10) }, (_, j) => 10 * Math.log10(p.subarray(j * 10, j * 10 + 10).reduce((a, b) => a + b, 0) / 10 + 1e-12));

const cases = [
  { name: 'already right', map: (t: number) => t, offset: 0, scale: 1 },
  { name: '34 s late (a different opening)', map: (t: number) => t + 34, offset: -34, scale: 1 },
  { name: '12 s early', map: (t: number) => t - 12, offset: 12, scale: 1 },
  { name: 'PAL speed (25 vs 23.976 fps) and 2 s', map: (t: number) => (t * 23.976) / 25 + 2, offset: (-2 * 25) / 23.976, scale: 25 / 23.976 },
];

describe('subtitle sync on a real soundtrack', () => {
  for (const c of cases) {
    it(`finds the right timing: ${c.name}`, () => {
      const shifted = cues.map((q) => ({ ...q, start: c.map(q.start), end: c.map(q.end) }));
      const fit = fitTrack(stretches(shifted, speechiness), shifted);
      expect(fits(fit)).toBe(true);
      expect(Math.abs(fit!.offset - c.offset)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(fit!.scale - c.scale)).toBeLessThan(1e-3);
    });
  }

  it('plain loudness (the old measure) is fooled by the music here', () => {
    const fit = fitTrack(stretches(cues, plainLoudness), cues);
    expect(fits(fit) && Math.abs(fit!.offset) <= 0.3).toBe(false);
  });
});
