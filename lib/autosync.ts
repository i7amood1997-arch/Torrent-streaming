/**
 * Automatic subtitle synchronisation from the soundtrack.
 *
 * While the video plays, the energy in the speech band (300–3000 Hz) is sampled
 * from the audio. Subtitle cues mark when someone speaks; so the shift (and, for
 * releases with a different frame rate, the speed factor) that best lines up
 * "speech" with "a subtitle is on screen" is the sync correction. This is the
 * idea behind tools like ffsubsync/alass, done live in the page.
 *
 * Pure functions here (testable); the audio tap lives in lib/audio-tap.ts.
 */
import type { SubtitleCue } from './types';

export interface SpeechSample {
  t: number; // media time (s)
  e: number; // speech-band energy (dB)
}

export interface Alignment {
  /** Seconds to add to cue times after scaling: media = cue * scale + offset. */
  offset: number;
  scale: number;
  /** Peak strength in standard deviations above the mean score of other shifts. */
  z: number;
  /** Best score ÷ best score at least 1 s away (higher = less ambiguous). */
  ratio: number;
  /** Seconds of audio the estimate is based on. */
  seconds: number;
}

/** Frame-rate conversions seen in real releases (PAL speed-up, 23.976 vs 24). */
export const SYNC_SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

const HZ = 10; // analysis grid: 100 ms

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** Cue coverage on a 100 ms grid of cue time: cov[k] = 1 if a cue is shown at k/10 s. */
function coverage(cues: SubtitleCue[]): Uint8Array {
  const end = cues.reduce((m, c) => Math.max(m, c.end), 0);
  const cov = new Uint8Array(Math.ceil(end * HZ) + 2);
  for (const c of cues) {
    const a = Math.max(0, Math.round(c.start * HZ));
    const b = Math.min(cov.length - 1, Math.round(c.end * HZ));
    for (let k = a; k < b; k++) cov[k] = 1;
  }
  return cov;
}

/**
 * Find the shift/speed that best aligns subtitles with detected speech.
 * `center` is the current offset (s): candidates span center ± range.
 */
export function alignSubtitles(samples: SpeechSample[], cues: SubtitleCue[], opts: { center?: number; range?: number; scales?: number[] } = {}): Alignment | undefined {
  const center = opts.center ?? 0;
  const range = opts.range ?? 20;
  const scales = opts.scales ?? SYNC_SCALES;
  if (cues.length < 8) return undefined;

  // Resample to the 100 ms grid (max energy per slot; ignore silence from mute / -Infinity).
  const slots = new Map<number, number>();
  for (const s of samples) {
    if (!Number.isFinite(s.e)) continue;
    const k = Math.round(s.t * HZ);
    const prev = slots.get(k);
    if (prev === undefined || s.e > prev) slots.set(k, s.e);
  }
  if (slots.size < 60 * HZ) return undefined; // need at least a minute of audio

  const keys = [...slots.keys()].sort((a, b) => a - b);
  const energies = keys.map((k) => slots.get(k)!);
  const sorted = [...energies].sort((a, b) => a - b);
  // Speech is the louder part of the speech band; the median adapts to each mix and volume.
  const threshold = percentile(sorted, 0.5);
  const speech: number[] = energies.map((e) => (e > threshold ? 1 : 0));
  const mean = speech.reduce((a, b) => a + b, 0) / speech.length;
  const centered = speech.map((v) => v - mean);
  const times = keys.map((k) => k / HZ);

  const cov = coverage(cues);
  const steps = Math.round(range * HZ);
  let best: { offset: number; scale: number; score: number; scores: number[]; idx: number } | undefined;

  for (const scale of scales) {
    const scores: number[] = [];
    for (let j = -steps; j <= steps; j++) {
      const offset = center + j / HZ;
      let dot = 0;
      let on = 0;
      for (let i = 0; i < times.length; i++) {
        const k = Math.round(((times[i] - offset) / scale) * HZ);
        if (k >= 0 && k < cov.length && cov[k]) { dot += centered[i]; on++; }
      }
      // Normalise by how much subtitle time is in the window (edges have less).
      const p = on / times.length;
      const score = p > 0.02 && p < 0.98 ? dot / Math.sqrt(on * (1 - p)) : 0;
      scores.push(score);
    }
    for (let idx = 0; idx < scores.length; idx++) {
      if (!best || scores[idx] > best.score) best = { offset: center + (idx - steps) / HZ, scale, score: scores[idx], scores, idx };
    }
  }
  if (!best || best.score <= 0) return undefined;

  // Sub-step precision: fit a parabola through the peak and its neighbours.
  let offset = best.offset;
  const { scores, idx } = best;
  if (idx > 0 && idx < scores.length - 1) {
    const [a, b, c] = [scores[idx - 1], scores[idx], scores[idx + 1]];
    const denom = a - 2 * b + c;
    if (denom < 0) offset += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) / HZ;
  }

  const others = best.scores.filter((_, i) => Math.abs(i - best!.idx) > HZ);
  const m = others.reduce((a, b) => a + b, 0) / Math.max(1, others.length);
  const sd = Math.sqrt(others.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, others.length)) || 1e-9;
  const runnerUp = Math.max(1e-9, ...others);
  return {
    offset: Math.round(offset * 1000) / 1000,
    scale: best.scale,
    z: (best.score - m) / sd,
    ratio: best.score / runnerUp,
    seconds: slots.size / HZ,
  };
}

/** Whether an alignment is trustworthy enough to apply without asking. */
export const confident = (a: Alignment | undefined) => !!a && a.z >= 6 && a.ratio >= 1.15;

/** Two estimates agree (same speed, shift within 200 ms). */
export const agrees = (a: Alignment, b: Alignment) => a.scale === b.scale && Math.abs(a.offset - b.offset) <= 0.2;
