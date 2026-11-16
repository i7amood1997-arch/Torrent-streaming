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
import { speechiness, type SpeechSample } from './autosync';

let ctx: AudioContext | undefined;
const taps = new WeakMap<HTMLMediaElement, AnalyserNode>();

/**
 * Speech-band power every 10 ms, with the media time it was heard at: the same input the up-front
 * sync uses (lib/audio-energy.ts), so live listening can tell speech from music just as well.
 */
interface PowerLog { t: number[]; p: number[] }
const powerLogs = new WeakMap<HTMLMediaElement, PowerLog>();
const KEEP_10MS = 8 * 60 * 100; // 8 minutes

function attachPowerLog(v: HTMLVideoElement, source: MediaElementAudioSourceNode, c: AudioContext) {
  const log: PowerLog = { t: [], p: [] };
  powerLogs.set(v, log);
  if (typeof c.createScriptProcessor !== 'function') return;
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
  const proc = c.createScriptProcessor(2048, 1, 1);
  const mute = c.createGain(); mute.gain.value = 0; // the processor must reach the output to run; silently
  source.connect(hp); hp.connect(lp); lp.connect(proc); proc.connect(mute); mute.connect(c.destination);
  const hop = Math.max(1, Math.round(c.sampleRate / 100));
  let next: number | undefined;
  proc.onaudioprocess = (ev) => {
    if (v.paused || v.seeking || v.muted || v.volume === 0 || v.playbackRate > 4) { next = undefined; return; }
    const x = ev.inputBuffer.getChannelData(0);
    const chunks = Math.floor(x.length / hop);
    // The media clock is read coarsely: follow on exactly from the previous buffer while it agrees
    // (within 0.25 s), and only jump to the clock after a seek or a pause.
    const estimate = v.currentTime - x.length / c.sampleRate;
    const start = next !== undefined && Math.abs(estimate - next) < 0.25 ? next : estimate;
    for (let k = 0; k < chunks; k++) {
      let sum = 0;
      for (let i = k * hop; i < (k + 1) * hop; i++) sum += x[i] * x[i];
      log.t.push(start + (k * hop) / c.sampleRate);
      log.p.push(sum / hop);
    }
    next = start + (chunks * hop) / c.sampleRate;
    if (log.t.length > KEEP_10MS + 6000) { log.t.splice(0, log.t.length - KEEP_10MS); log.p.splice(0, log.p.length - KEEP_10MS); }
  };
}

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
    const log = powerLogs.get(this.video);
    if (log) { log.t = []; log.p = []; }
  }

  /**
   * The last `seconds` heard as speech measures every 100 ms (lib/autosync speechiness), from the
   * 10 ms power log; continuous stretches only (a seek or pause starts a new one). Falls back to
   * the coarse levels when the browser has no audio processing for the log.
   */
  speech(seconds: number): { samples: SpeechSample[]; precise: boolean } {
    const log = powerLogs.get(this.video);
    if (!log || log.t.length < 200) return { samples: this.samples.slice(-Math.round(seconds * 12.5)), precise: false };
    const from = Math.max(0, log.t.length - Math.round(seconds * 100));
    const out: SpeechSample[] = [];
    let runStart = from;
    const flush = (end: number) => {
      if (end - runStart < 100) return; // under a second: skip
      const e = speechiness(log.p.slice(runStart, end));
      const t0 = log.t[runStart];
      e.forEach((v, i) => out.push({ t: t0 + i / 10, e: v }));
    };
    for (let i = from + 1; i < log.t.length; i++) {
      const dt = log.t[i] - log.t[i - 1];
      if (dt < 0 || dt > 0.05) { flush(i); runStart = i; }
    }
    flush(log.t.length);
    return { samples: out, precise: true };
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
        try { attachPowerLog(v, source, ctx); } catch { /* the 100 ms levels still work */ }
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
