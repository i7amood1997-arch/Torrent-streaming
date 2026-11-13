/**
 * Subtitle sync without waiting: instead of listening while the viewer watches,
 * short stretches of the film's audio are fetched up front from several places in
 * the file, and each candidate subtitle is fitted against them.
 *
 *  - fitTrack():        shift + speed for one subtitle, and whether every stretch agrees
 *                       (a subtitle made for a different cut fits one stretch but not the others)
 *  - alignToReference(): line a subtitle up with another one that is known to be right
 *                       (subtitles inside the file, or the other language once synced)
 *  - anchorOffset():    match recognised words to subtitle text (last resort when music
 *                       drowns out the speech pattern)
 *
 * Pure functions; the audio decoding lives in lib/audio-energy.ts.
 */
import { alignSubtitles, confident, type Alignment, type SpeechSample } from './autosync';
import type { SubtitleCue } from './types';

export interface Fit extends Alignment {
  /** Every sampled stretch agrees with the overall fit (within 0.35 s). */
  consistent: boolean;
  /** Per-stretch shifts: [media time of the stretch, shift in seconds]. */
  local: { t: number; offset: number }[];
}

/** Where to sample: `count` start times spread over the dialogue, each on a talkative stretch. */
export function planWindows(cues: SubtitleCue[], duration: number, count: number, length: number): number[] {
  const first = cues[0]?.start ?? 0;
  const last = Math.min(duration || Infinity, cues[cues.length - 1]?.end ?? duration ?? 0);
  if (!(last - first > length * 2)) return [Math.max(0, first)];
  const cover = (from: number) => cues.reduce((n, c) => n + Math.max(0, Math.min(c.end, from + length) - Math.max(c.start, from)), 0);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const center = first + ((i + 0.5) / count) * (last - first) - length / 2;
    let best = center;
    let bestCover = -1;
    for (const d of [0, -90, 90, -180, 180]) {
      const s = Math.max(0, Math.min(last - length, center + d));
      const c = cover(s);
      if (c > bestCover + 2) { bestCover = c; best = s; }
    }
    out.push(Math.round(best));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Fit one subtitle against audio stretches from across the film. */
export function fitTrack(windows: SpeechSample[][], cues: SubtitleCue[], opts: { center?: number; range?: number } = {}): Fit | undefined {
  const all = windows.flat();
  const a = alignSubtitles(all, cues, { center: opts.center, range: opts.range ?? 20 });
  if (!a) return undefined;
  const local: Fit['local'] = [];
  let consistent = true;
  for (const w of windows) {
    if (w.length < 300) continue;
    const l = alignSubtitles(w, cues, { center: a.offset, range: 4, scales: [a.scale], minSeconds: 30 });
    if (!l || l.z < 4.5) continue; // this stretch has too little dialogue to judge
    local.push({ t: w[0].t, offset: l.offset });
    if (Math.abs(l.offset - a.offset) > 0.35) consistent = false;
  }
  return { ...a, consistent, local };
}

/** Good enough to apply without asking: clear peak, and every stretch agrees. */
export const fits = (f: Fit | undefined): f is Fit => !!f && confident(f) && f.consistent;

/** Rank candidate fits: consistent first, then the clearest peak. */
export function betterFit(a: Fit | undefined, b: Fit | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  if (fits(a) !== fits(b)) return fits(a);
  return a.z > b.z;
}

/**
 * Line `cues` up with reference cues that are known to be in sync (media time).
 * Dialogue rhythm is the same in every language, so "a line is on screen" patterns match.
 */
export function alignToReference(ref: SubtitleCue[], cues: SubtitleCue[], opts: { center?: number; range?: number } = {}): Alignment | undefined {
  if (ref.length < 12) return undefined;
  const from = ref[0].start;
  const to = ref[ref.length - 1].end;
  const samples: SpeechSample[] = [];
  let i = 0;
  for (let t = from; t <= to; t += 0.1) {
    while (i < ref.length && ref[i].end <= t) i++;
    samples.push({ t, e: i < ref.length && ref[i].start <= t ? 1 : 0 });
  }
  return alignSubtitles(samples, cues, { center: opts.center, range: opts.range ?? 20, threshold: 0.5 });
}

// ─── Word anchors (speech recognition) ──────────────────────────────────────

const norm = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Shift from recognised words: every recognised word votes for the shifts that would put
 * it on a subtitle line containing the same word; the true shift collects the most votes.
 */
export function anchorOffset(words: { word: string; start: number }[], cues: SubtitleCue[], scale = 1, range = 30): { offset: number; votes: number; ratio: number } | undefined {
  const index = new Map<string, number[]>(); // word → estimated cue-time of each occurrence
  for (const c of cues) {
    const tokens = c.text.split(/\s+/).map(norm).filter(Boolean);
    tokens.forEach((tok, k) => {
      if (tok.length < 4) return;
      const t = (c.start + ((k + 0.5) / tokens.length) * (c.end - c.start)) * scale;
      const list = index.get(tok);
      if (list) list.push(t); else index.set(tok, [t]);
    });
  }
  const bins = new Map<number, number>();
  for (const w of words) {
    const list = index.get(norm(w.word));
    if (!list || list.length > 40) continue; // very common words say nothing
    for (const t of list) {
      const d = w.start - t;
      if (Math.abs(d) <= range) { const b = Math.round(d * 5); bins.set(b, (bins.get(b) ?? 0) + 1 / list.length); }
    }
  }
  let best = 0;
  let bestBin = 0;
  const score = (b: number) => (bins.get(b - 1) ?? 0) + (bins.get(b) ?? 0) + (bins.get(b + 1) ?? 0);
  for (const b of bins.keys()) { const s = score(b); if (s > best) { best = s; bestBin = b; } }
  if (best < 5) return undefined;
  let runner = 0;
  for (const b of bins.keys()) if (Math.abs(b - bestBin) > 5) runner = Math.max(runner, score(b));
  // Weighted centre of the peak.
  let sum = 0;
  let weight = 0;
  for (const d of [-1, 0, 1]) { const v = bins.get(bestBin + d) ?? 0; sum += (bestBin + d) * v; weight += v; }
  return { offset: sum / weight / 5, votes: best, ratio: best / Math.max(runner, 1e-9) };
}
