'use client';
/**
 * Samples speech-band loudness from the playing video for automatic subtitle sync.
 *
 * Safety rules (getting these wrong silences the video):
 *  - The video's audio is routed through Web Audio only when the media is readable
 *    by the page (same-origin, a blob/MSE stream, or loaded with CORS). For other
 *    media the browser would output silence, so we never tap it.
 *  - Routing is only set up once the AudioContext is running, which iOS allows only
 *    after a user gesture: `unlockAudio()` is called from Play taps.
 */
import type { SpeechSample } from './autosync';

let ctx: AudioContext | undefined;
const taps = new WeakMap<HTMLMediaElement, AnalyserNode>();

/** Call from a user gesture (tap on Play): creates/resumes the shared AudioContext. */
export function unlockAudio() {
  try {
    const C = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!C) return;
    ctx ??= new C();
    if (ctx.state !== 'running') ctx.resume().catch(() => undefined);
  } catch { /* no Web Audio */ }
}

/** True once this element's audio goes through Web Audio (it can't be undone for that element). */
export const isTapped = (v: HTMLMediaElement) => taps.has(v);

/** Whether the page can read this element's audio (otherwise tapping it would mute it). */
export function canReadMedia(v: HTMLVideoElement): boolean {
  const src = v.currentSrc;
  if (!src || v.readyState < 2) return false;
  if (src.startsWith('blob:')) return true;
  try { if (new URL(src).origin === location.origin) return true; } catch { return false; }
  return v.crossOrigin === 'anonymous';
}

export class AudioTap {
  samples: SpeechSample[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private buf?: Float32Array<ArrayBuffer>;

  constructor(private video: HTMLVideoElement) {}

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  reset() {
    this.samples = [];
  }

  /** True when samples are being collected (audio routed and readable). */
  get active() {
    return isTapped(this.video) && canReadMedia(this.video);
  }

  private tick() {
    const v = this.video;
    if (v.paused || v.seeking || v.readyState < 3 || v.muted || v.volume === 0 || v.playbackRate > 4) return;
    let analyser = taps.get(v);
    if (!analyser) {
      if (!ctx || ctx.state !== 'running' || !canReadMedia(v)) return;
      try {
        const source = ctx.createMediaElementSource(v);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        source.connect(ctx.destination); // keep the sound playing
        taps.set(v, analyser);
      } catch {
        return;
      }
    }
    if (!ctx || ctx.state !== 'running') { ctx?.resume().catch(() => undefined); return; }
    if (!canReadMedia(v)) return;
    if (!this.buf || this.buf.length !== analyser.frequencyBinCount) this.buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(this.buf);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const lo = Math.floor(300 / binHz);
    const hi = Math.min(this.buf.length - 1, Math.ceil(3000 / binHz));
    let power = 0;
    for (let i = lo; i <= hi; i++) power += 10 ** (this.buf[i] / 10);
    const e = 10 * Math.log10(power / (hi - lo + 1));
    this.samples.push({ t: v.currentTime, e });
    if (this.samples.length > 15000) this.samples.splice(0, this.samples.length - 12000); // keep ~20 min
  }
}
