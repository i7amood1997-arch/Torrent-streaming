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

/**
 * How far apart a subtitle and a video can be when nothing is known yet (seconds). Releases differ
 * in their openings (studio logos, recap, a cut intro) by tens of seconds: a real film's subtitles
 * were 34 s late, beyond the old ±20 s search, so they could never be matched.
 */
export const WIDE_RANGE = 120;

/** Frame-rate conversions seen in real releases (PAL speed-up, 23.976 vs 24). */
export const SYNC_SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

const HZ = 10; // analysis grid: 100 ms
const NARROW = 20; // seconds searched step by step; wider searches go coarse to fine
const COARSE = 10; // coarse step (in 100 ms units): 1 s
const CANDIDATES = 8; // coarse peaks refined
const SPEED_DOUBT = 0.97; // a non-normal speed needs a 3% better match to be chosen

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
export function alignSubtitles(samples: SpeechSample[], cues: SubtitleCue[], opts: { center?: number; range?: number; scales?: number[]; minSeconds?: number; threshold?: number; /** Tests: check every 100 ms step even over a wide range. */ exhaustive?: boolean } = {}): Alignment | undefined {
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
  if (slots.size < (opts.minSeconds ?? 60) * HZ) return undefined; // need at least a minute of audio

  const keys = [...slots.keys()].sort((a, b) => a - b);
  const energies = keys.map((k) => slots.get(k)!);
  const sorted = [...energies].sort((a, b) => a - b);
  // Speech is the louder part of the speech band; the median adapts to each mix and volume.
  const threshold = opts.threshold ?? percentile(sorted, 0.5);
  const speech: number[] = energies.map((e) => (e > threshold ? 1 : 0));
  const mean = speech.reduce((a, b) => a + b, 0) / speech.length;
  const centered = speech.map((v) => v - mean);
  const times = keys.map((k) => k / HZ);

  const cov = coverage(cues);
  const steps = Math.round(range * HZ);
  const N = times.length;
  /** How well "speech" lines up with "a subtitle is shown" at this shift and speed. */
  const scoreAt = (offset: number, scale: number) => {
    let dot = 0;
    let on = 0;
    for (let i = 0; i < N; i++) {
      const k = Math.round(((times[i] - offset) / scale) * HZ);
      if (k >= 0 && k < cov.length && cov[k]) { dot += centered[i]; on++; }
    }
    // Normalise by how much subtitle time is in the window (edges have less).
    const p = on / N;
    return p > 0.02 && p < 0.98 ? dot / Math.sqrt(on * (1 - p)) : 0;
  };

  let bestScale = scales[0];
  let bestJ = 0;
  let bestScore = -Infinity;
  let bestRank = -Infinity;
  /**
   * A speed change must clearly beat normal speed: over a short stretch, 24 vs 23.976 fps (0.1%)
   * is nearly indistinguishable and an unneeded speed fix makes the timing drift.
   */
  const rank = (v: number, scale: number) => (scale === 1 ? v : v * SPEED_DOUBT);
  /** Scores of the best speed by step j (relative to center), for precision and confidence. */
  let line = new Map<number, number>();

  if (steps <= NARROW * HZ || opts.exhaustive) {
    // Every 100 ms step, every speed.
    for (const scale of scales) {
      const sc = new Map<number, number>();
      for (let j = -steps; j <= steps; j++) {
        const v = scoreAt(center + j / HZ, scale);
        sc.set(j, v);
        if (rank(v, scale) > bestRank) { bestRank = rank(v, scale); bestScore = v; bestScale = scale; bestJ = j; line = sc; }
      }
    }
  } else {
    // Wide search, coarse to fine (same answer, ~10x less work so phones and TVs don't stall):
    // 1 s steps everywhere, then 100 ms steps around the most promising places.
    const coarse: { scale: number; j: number; v: number }[] = [];
    for (const scale of scales) for (let j = -steps; j <= steps; j += COARSE) coarse.push({ scale, j, v: scoreAt(center + j / HZ, scale) });
    coarse.sort((x, y) => y.v - x.v);
    const picks: typeof coarse = [];
    for (const c of coarse) {
      if (picks.length >= CANDIDATES) break;
      if (!picks.some((q) => q.scale === c.scale && Math.abs(q.j - c.j) < 2 * COARSE)) picks.push(c);
    }
    for (const c of picks) {
      for (let j = c.j - COARSE; j <= c.j + COARSE; j++) {
        if (j < -steps || j > steps) continue;
        const v = scoreAt(center + j / HZ, c.scale);
        if (rank(v, c.scale) > bestRank) { bestRank = rank(v, c.scale); bestScore = v; bestScale = c.scale; bestJ = j; }
      }
    }
    // The best speed's scores: 100 ms steps within 20 s of the peak, coarse beyond (runner-up).
    for (let j = Math.max(-steps, bestJ - NARROW * HZ); j <= Math.min(steps, bestJ + NARROW * HZ); j++) line.set(j, scoreAt(center + j / HZ, bestScale));
    for (const c of coarse) if (c.scale === bestScale && !line.has(c.j)) line.set(c.j, c.v);
  }
  if (!(bestScore > 0)) return undefined;

  // Sub-step precision: fit a parabola through the peak and its neighbours.
  let offset = center + bestJ / HZ;
  const a = line.get(bestJ - 1);
  const c = line.get(bestJ + 1);
  if (a !== undefined && c !== undefined) {
    const denom = a - 2 * bestScore + c;
    if (denom < 0) offset += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) / HZ;
  }

  // Peak strength against the shifts around it (±20 s), whatever the search range, so a wide
  // search isn't more easily convinced; the runner-up is taken from the whole range (stricter).
  const others: number[] = [];
  const near: number[] = [];
  for (const [j, v] of line) {
    const d = Math.abs(j - bestJ);
    if (d <= HZ) continue;
    others.push(v);
    if (d <= NARROW * HZ) near.push(v);
  }
  const m = near.reduce((x, y) => x + y, 0) / Math.max(1, near.length);
  const sd = Math.sqrt(near.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, near.length)) || 1e-9;
  const runnerUp = Math.max(1e-9, ...others);
  return {
    offset: Math.round(offset * 1000) / 1000,
    scale: bestScale,
    z: (bestScore - m) / sd,
    ratio: bestScore / runnerUp,
    seconds: slots.size / HZ,
  };
}

/**
 * Whether an alignment is trustworthy enough to apply without asking: a strong peak, or a slightly
 * weaker one that clearly beats every other shift (1.5×) — measured on real films, the right answer
 * often scores 5–6 with a clear lead, while wrong ones stay near 2–3 with no lead.
 */
export const confident = (a: Alignment | undefined) => !!a && ((a.z >= 6 && a.ratio >= 1.15) || (a.z >= 5 && a.ratio >= 1.5));

/**
 * Speech detection that music and effects don't fool (measured on two real films: right answer
 * 5 of 7 minutes, against 2 of 7 for plain loudness). In: speech-band power every 10 ms.
 * Out: one value per 100 ms = how far the level rises above the quietest moment within ±2 s
 * (a floor that follows the music) + how much it flickers (syllables) compared with the
 * surrounding 4 s.
 */
export function speechiness(power10ms: ArrayLike<number>): number[] {
  const db = (x: number) => 10 * Math.log10(x + 1e-12);
  const n = Math.floor(power10ms.length / 10);
  const f10: number[] = Array.from(power10ms, (x) => db(x));
  const level: number[] = [];
  const flicker: number[] = [];
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = j * 10; k < j * 10 + 10; k++) sum += power10ms[k];
    level.push(db(sum / 10));
    const a = Math.max(0, j * 10 - 10);
    const b = Math.min(f10.length, j * 10 + 20);
    let mean = 0;
    for (let k = a; k < b; k++) mean += f10[k];
    mean /= b - a;
    let v = 0;
    for (let k = a; k < b; k++) v += (f10[k] - mean) ** 2;
    let lvl = 0;
    for (let k = j * 10; k < j * 10 + 10; k++) lvl += f10[k];
    flicker.push(lvl / 10 + 1.5 * Math.sqrt(v / (b - a)));
  }
  return level.map((v, i) => {
    let floor = Infinity;
    let around = 0;
    let count = 0;
    for (let k = Math.max(0, i - 20); k <= Math.min(n - 1, i + 20); k++) {
      floor = Math.min(floor, level[k]);
      around += flicker[k];
      count++;
    }
    return v - floor + (flicker[i] - around / count);
  });
}

/**
 * The live tap only has a level every ~80 ms: use its rise above the quietest moment within ±1 s
 * (5 of 7 real minutes right, against 2 of 7 for the plain level).
 */
export function liveSpeechiness(samples: SpeechSample[]): SpeechSample[] {
  const out: SpeechSample[] = [];
  let lo = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].t;
    while (lo < i && samples[lo].t < t - 1) lo++;
    let floor = Infinity;
    for (let k = lo; k < samples.length && samples[k].t <= t + 1; k++) if (Number.isFinite(samples[k].e)) floor = Math.min(floor, samples[k].e);
    out.push({ t, e: Number.isFinite(samples[i].e) && Number.isFinite(floor) ? samples[i].e - floor : -Infinity });
  }
  return out;
}

/** Two estimates agree (same speed, shift within 200 ms). */
export const agrees = (a: Alignment, b: Alignment) => a.scale === b.scale && Math.abs(a.offset - b.offset) <= 0.2;
