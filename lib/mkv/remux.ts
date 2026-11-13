/**
 * MKV → fragmented MP4 remuxer (pure: no DOM, testable in Node).
 *
 * Picks one video and one audio track, then turns Matroska frames into MSE
 * segments. Matroska stores presentation timestamps in decode order; MP4 needs
 * decode timestamps too, so they're reconstructed from a window of upcoming
 * frames (the i-th decoded frame gets the i-th smallest presentation time).
 */
import { planTrack, type TrackPlan } from './codecs';
import type { MkvFrame, MkvHeader, MkvTrack } from './ebml';
import { fragment, initSegment, type FragSample } from './fmp4';

export interface OutputTrack {
  kind: 'video' | 'audio';
  track: MkvTrack;
  plan: TrackPlan;
}

export interface Segment {
  kind: 'video' | 'audio';
  data: Uint8Array;
  /** Covered time range in seconds (for logging/buffer decisions). */
  start: number;
  end: number;
}

export interface SubtitleCue {
  track: number;
  start: number; // s
  end: number; // s
  text: string;
}

/**
 * The whole media timeline is shifted later by this much. B-frames are decoded
 * before they are shown, so decode times run ahead of presentation times; the
 * shift keeps every decode time ≥ 0 and ≤ its presentation time, and absorbs
 * negative audio priming timestamps. Media time = file time + offset.
 */
export const TIMELINE_OFFSET_MS = 500;

const REORDER_WINDOW = 16; // frames held back to reconstruct decode timestamps
const VIDEO_FRAGMENT_MS = 2000;
const AUDIO_FRAGMENT_MS = 1000;

interface Pending { pts: number; keyframe: boolean; data: Uint8Array }

export interface SelectOptions {
  /** MediaSource.isTypeSupported (or a stub in tests). */
  isSupported?: (mime: string) => boolean;
  /** Preferred audio languages, ISO 639-2 or IETF, in order. */
  audioLanguages?: string[];
}

export interface Selection {
  video?: OutputTrack;
  audio?: OutputTrack;
  subtitles: MkvTrack[];
  /** Why no playable video/audio was found (for a friendly error). */
  problems: string[];
}

const langMatches = (track: string, want: string) => {
  const a = track.toLowerCase();
  const b = want.toLowerCase();
  return a === b || a.startsWith(b.slice(0, 2)) || (b === 'en' && a === 'eng') || (b === 'ar' && a === 'ara') || (b === 'ja' && a === 'jpn');
};

export function selectTracks(header: MkvHeader, opts: SelectOptions = {}): Selection {
  const supported = opts.isSupported ?? (() => true);
  const problems: string[] = [];
  const candidates = (type: 'video' | 'audio') =>
    header.tracks.filter((t) => t.type === type && !t.encrypted).flatMap((t) => {
      const plan = planTrack(t);
      if ('unsupported' in plan) { problems.push(plan.unsupported); return []; }
      if (!supported(plan.mime)) { problems.push(`${plan.codec} isn't supported by this device`); return []; }
      return [{ kind: type, track: t, plan } as OutputTrack];
    });

  const videos = candidates('video');
  const audios = candidates('audio');
  const langs = opts.audioLanguages ?? [];
  const rank = (o: OutputTrack) => {
    const li = langs.findIndex((l) => langMatches(o.track.language, l));
    return (li < 0 ? 100 : li) * 2 + (o.track.isDefault ? 0 : 1);
  };
  audios.sort((a, b) => rank(a) - rank(b));
  return {
    video: videos.sort((a, b) => Number(b.track.isDefault) - Number(a.track.isDefault))[0],
    audio: audios[0],
    subtitles: header.tracks.filter((t) => t.type === 'subtitle' && /^S_TEXT\/(UTF8|ASS|SSA)$/.test(t.codecId)),
    problems,
  };
}

class TrackMuxer {
  init?: Uint8Array;
  private pending: Pending[] = [];
  private seq = 1;
  private lastDts = -Infinity;
  private lastDuration: number;

  constructor(readonly out: OutputTrack) {
    this.lastDuration = out.plan.defaultDuration;
  }

  reset() {
    this.pending = [];
    this.lastDts = -Infinity;
  }

  /** Returns the init segment the first time a frame arrives (Dolby needs the frame to build it). */
  push(f: MkvFrame): Segment[] {
    const out: Segment[] = [];
    if (!this.init) {
      const entry = this.out.plan.entry(f.data);
      this.init = initSegment(entry, this.out.plan.timescale);
    }
    if (this.out.kind === 'video') {
      if (f.keyframe && this.pending.length) out.push(...this.flushVideo(0));
      this.pending.push({ pts: f.pts, keyframe: f.keyframe, data: f.data });
      const span = this.pending[this.pending.length - 1].pts - this.pending[0].pts;
      if (span >= VIDEO_FRAGMENT_MS && this.pending.length > REORDER_WINDOW) out.push(...this.flushVideo(REORDER_WINDOW));
    } else {
      this.pending.push({ pts: f.pts, keyframe: true, data: f.data });
      const span = this.pending[this.pending.length - 1].pts - this.pending[0].pts;
      if (span >= AUDIO_FRAGMENT_MS) out.push(...this.flushAudio());
    }
    return out;
  }

  flush(): Segment[] {
    return this.out.kind === 'video' ? this.flushVideo(0) : this.flushAudio();
  }

  private ticks(ms: number) {
    return Math.round((ms * this.out.plan.timescale) / 1000);
  }

  /** Emit all pending video frames except the last `keep` (needed to order the rest). */
  private flushVideo(keep: number): Segment[] {
    const n = this.pending.length - keep;
    if (n <= 0) return [];
    const sorted = this.pending.map((p) => Math.max(0, this.ticks(p.pts))).sort((a, b) => a - b);
    const frames = this.pending.slice(0, n);
    const dts: number[] = [];
    for (let i = 0; i < n; i++) {
      let d = sorted[i];
      const prev = i ? dts[i - 1] : this.lastDts;
      if (d <= prev) d = prev + 1;
      dts.push(d);
    }
    // Next frame's decode time, if known, gives the last frame's duration.
    const nextDts = n < sorted.length ? Math.max(sorted[n], dts[n - 1] + 1) : undefined;
    const samples: FragSample[] = frames.map((f, i) => {
      const next = i + 1 < n ? dts[i + 1] : nextDts;
      const duration = next !== undefined ? next - dts[i] : this.lastDuration;
      if (i + 1 < n || next !== undefined) this.lastDuration = Math.max(1, duration);
      return { duration: Math.max(1, duration), size: f.data.length, cto: this.ticks(f.pts + TIMELINE_OFFSET_MS) - dts[i], sync: f.keyframe };
    });
    this.lastDts = dts[n - 1];
    this.pending = this.pending.slice(n);
    const data = fragment(this.seq++, Math.max(0, dts[0]), samples, frames.map((f) => f.data));
    const ts = this.out.plan.timescale;
    return [{ kind: 'video', data, start: dts[0] / ts, end: (dts[n - 1] + samples[n - 1].duration) / ts }];
  }

  private flushAudio(): Segment[] {
    const frames = this.pending;
    if (!frames.length) return [];
    this.pending = [];
    const dts = frames.map((f) => this.ticks(f.pts + TIMELINE_OFFSET_MS));
    for (let i = 0; i < dts.length; i++) {
      const prev = i ? dts[i - 1] : this.lastDts;
      if (dts[i] <= prev) dts[i] = prev + 1;
    }
    const samples: FragSample[] = frames.map((f, i) => {
      const duration = i + 1 < frames.length ? dts[i + 1] - dts[i] : this.lastDuration;
      if (i + 1 < frames.length) this.lastDuration = Math.max(1, duration);
      return { duration: Math.max(1, duration), size: f.data.length, cto: 0, sync: true };
    });
    this.lastDts = dts[dts.length - 1];
    const data = fragment(this.seq++, Math.max(0, dts[0]), samples, frames.map((f) => f.data));
    const ts = this.out.plan.timescale;
    return [{ kind: 'audio', data, start: dts[0] / ts, end: (dts[dts.length - 1] + samples[samples.length - 1].duration) / ts }];
  }
}

export class MkvRemuxer {
  readonly video?: TrackMuxer;
  readonly audio?: TrackMuxer;
  private subtitleTracks: Map<number, MkvTrack>;

  constructor(readonly selection: Selection, private onCue?: (cue: SubtitleCue) => void) {
    if (selection.video) this.video = new TrackMuxer(selection.video);
    if (selection.audio) this.audio = new TrackMuxer(selection.audio);
    this.subtitleTracks = new Map(selection.subtitles.map((t) => [t.number, t]));
  }

  /** Frame in, zero or more segments out. An init segment is emitted before a track's first media segment. */
  push(f: MkvFrame): { kind: 'video' | 'audio'; init?: Uint8Array; segments: Segment[] } | undefined {
    const mux = f.track === this.selection.video?.track.number ? this.video : f.track === this.selection.audio?.track.number ? this.audio : undefined;
    if (!mux) {
      const st = this.subtitleTracks.get(f.track);
      if (st && this.onCue) {
        const text = subtitleText(f.data, st.codecId);
        if (text) this.onCue({ track: f.track, start: (f.pts + TIMELINE_OFFSET_MS) / 1000, end: (f.pts + TIMELINE_OFFSET_MS + (f.durationMs ?? 3000)) / 1000, text });
      }
      return undefined;
    }
    const hadInit = !!mux.init;
    const segments = mux.push(f);
    return { kind: mux.out.kind, init: hadInit ? undefined : mux.init, segments };
  }

  flush(): Segment[] {
    return [...(this.video?.flush() ?? []), ...(this.audio?.flush() ?? [])];
  }

  /** Drop pending frames (after a seek: the next frames start a new coded sequence). */
  reset() {
    this.video?.reset();
    this.audio?.reset();
  }
}

const td = new TextDecoder();

/** Text from an S_TEXT/UTF8 or ASS/SSA block (Matroska stores ASS events without timing). */
export function subtitleText(data: Uint8Array, codecId: string): string {
  let s = td.decode(data);
  if (codecId !== 'S_TEXT/UTF8') {
    // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    let commas = 0;
    let i = 0;
    for (; i < s.length && commas < 8; i++) if (s[i] === ',') commas++;
    s = s.slice(i);
    if (/\\p[1-9]/.test(s)) return ''; // vector drawings, not text
    s = s.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
  } else {
    s = s.replace(/<[^>]+>/g, '');
  }
  return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}
