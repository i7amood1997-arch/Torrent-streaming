/**
 * Subtitles from speech: reads the audio a minute at a time, a few minutes ahead of the
 * playhead, sends it to the speech recogniser (Whisper on the user's relay) and turns the
 * result into subtitle cues.
 */
import type { SubtitleCue } from '../types';
import type { AudioSource } from './audio-source';

export interface SpeechWord { word: string; start: number; end: number }
export interface SpeechSegment { start: number; end: number; text: string; words?: SpeechWord[] }
export interface Transcript { language?: string; segments: SpeechSegment[] }

export type TranscribeFn = (audio: { bytes: Uint8Array; mime: string }, opts: { language?: string }, signal?: AbortSignal) => Promise<Transcript>;

const MAX_CHARS = 84; // two lines of ~42
const MAX_SECONDS = 6;

/** Things Whisper says over music or silence. */
const HALLUCINATIONS = /^(thanks? (you )?for watching|subtitles? by|subscribe|amara\.org|transcribed by|\[?music\]?|♪+)[.!]*$/i;

/** Turn recogniser segments into subtitle-sized cues (≤ 2 lines, ≤ 6 s), using word timings when present. */
export function segmentsToCues(segments: SpeechSegment[], offset = 0): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const push = (start: number, end: number, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || HALLUCINATIONS.test(t)) return;
    cues.push({ start: start + offset, end: Math.max(end, start + 0.8) + offset, text: wrap(t) });
  };
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    if (text.length <= MAX_CHARS && s.end - s.start <= MAX_SECONDS) { push(s.start, s.end, text); continue; }
    const words = s.words?.length ? s.words : spreadWords(s);
    let cur: SpeechWord[] = [];
    const flush = () => { if (cur.length) push(cur[0].start, cur[cur.length - 1].end, cur.map((w) => w.word.trim()).join(' ')); cur = []; };
    for (const w of words) {
      const len = cur.reduce((n, x) => n + x.word.trim().length + 1, 0);
      if (cur.length && (len + w.word.trim().length > MAX_CHARS || w.end - cur[0].start > MAX_SECONDS)) flush();
      cur.push(w);
      // Prefer breaking after sentence punctuation once a cue has some length.
      if (/[.!?…]["')\]]?$/.test(w.word.trim()) && len > 20) flush();
    }
    flush();
  }
  return cues;
}

/** No word timings: spread the segment's words evenly over its duration. */
function spreadWords(s: SpeechSegment): SpeechWord[] {
  const parts = s.text.trim().split(/\s+/);
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  let t = s.start;
  return parts.map((p) => {
    const d = ((p.length + 1) / total) * (s.end - s.start);
    const w = { word: p, start: t, end: t + d };
    t += d;
    return w;
  });
}

/** Break a long line into two balanced lines at a space. */
function wrap(t: string): string {
  if (t.length <= 42) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best > 0 ? `${t.slice(0, best)}\n${t.slice(best + 1)}` : t;
}

export interface GeneratorStatus {
  state: 'working' | 'waiting' | 'error' | 'done';
  message?: string;
  /** Media time (s) up to which subtitles exist, counting from the playhead's window. */
  readyUntil?: number;
  language?: string;
}

export class SubtitleGenerator {
  private done = new Set<number>();
  private running = false;
  private stopped = false;
  private time = 0;
  private language?: string;
  private ac = new AbortController();
  private failures = 0;

  constructor(
    private src: AudioSource,
    private transcribe: TranscribeFn,
    private onCues: (lang: string, cues: SubtitleCue[]) => void,
    private onStatus: (s: GeneratorStatus) => void,
    private window = 60,
    private ahead = 3,
  ) {}

  /** Tell the generator where playback is; it works on the windows from here on. */
  setTime(t: number) {
    this.time = t;
    void this.pump();
  }

  stop() {
    this.stopped = true;
    this.ac.abort();
  }

  private readyUntil() {
    let k = Math.floor(this.time / this.window);
    while (this.done.has(k)) k++;
    return k * this.window;
  }

  private next(): number | undefined {
    const total = Math.ceil(this.src.duration / this.window) || Infinity;
    const k0 = Math.floor(this.time / this.window);
    for (let k = k0; k <= k0 + this.ahead && k < total; k++) if (!this.done.has(k)) return k;
    return undefined;
  }

  private async pump() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let k = this.next(); k !== undefined && !this.stopped; k = this.next()) {
        this.onStatus({ state: 'working', readyUntil: this.readyUntil(), language: this.language });
        try {
          const clip = await this.src.read(k * this.window, (k + 1) * this.window, this.ac.signal);
          const tr = await this.transcribe(clip, { language: this.language }, this.ac.signal);
          // Lock the language after the first confident window, so music or a foreign line doesn't flip it.
          if (!this.language && tr.language && tr.segments.length >= 3) this.language = tr.language;
          const lang = this.language ?? tr.language ?? 'en';
          const cues = segmentsToCues(tr.segments, clip.start).filter((c) => c.start < (k + 1) * this.window + 2);
          this.done.add(k);
          this.failures = 0;
          if (cues.length) this.onCues(lang, cues);
        } catch (e) {
          if (this.stopped || (e as Error).name === 'AbortError') return;
          this.failures++;
          const message = (e as Error).message;
          // Out of quota / unsupported: stop trying. Otherwise retry this window a few times.
          if ((e as { fatal?: boolean }).fatal || this.failures >= 3) {
            this.onStatus({ state: 'error', message, readyUntil: this.readyUntil(), language: this.language });
            this.stopped = true;
            return;
          }
          await new Promise((r) => setTimeout(r, 3000 * this.failures));
        }
      }
      if (!this.stopped) this.onStatus({ state: this.readyUntil() >= this.src.duration ? 'done' : 'waiting', readyUntil: this.readyUntil(), language: this.language });
    } finally {
      this.running = false;
    }
  }
}
