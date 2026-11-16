'use client';
/**
 * Speech-band loudness of an audio clip, computed offline (faster than real time):
 * the browser decodes the clip, a band-pass keeps 300–3000 Hz, and the level is
 * measured every 100 ms. Output matches what the live audio tap records.
 */
import { speechiness, type SpeechSample } from './autosync';
import type { AudioClip } from './speech/audio-source';

type OfflineCtor = typeof OfflineAudioContext;
const Offline = (): OfflineCtor | undefined =>
  typeof window === 'undefined' ? undefined : (window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext);

export const canAnalyseAudio = () => !!Offline();

function decode(ctx: OfflineAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject); // callback form for older Safari
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

export async function analyseClip(clip: AudioClip): Promise<SpeechSample[]> {
  const Ctor = Offline();
  if (!Ctor) throw new Error('no offline audio');
  const bytes = clip.bytes;
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const buffer = await decode(new Ctor(1, 1, 44100), copy);
  let rate = 16000;
  let ctx: OfflineAudioContext;
  try { ctx = new Ctor(1, Math.ceil(buffer.duration * rate), rate); }
  catch { rate = buffer.sampleRate; ctx = new Ctor(1, Math.ceil(buffer.duration * rate), rate); }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
  src.connect(hp); hp.connect(lp); lp.connect(ctx.destination);
  src.start();
  const pcm = (await ctx.startRendering()).getChannelData(0);
  // Power every 10 ms, turned into a speech measure that music and effects don't fool.
  const hop = Math.round(rate / 100);
  const power = new Float64Array(Math.floor(pcm.length / hop));
  for (let j = 0; j < power.length; j++) {
    let sum = 0;
    for (let k = j * hop; k < (j + 1) * hop; k++) sum += pcm[k] * pcm[k];
    power[j] = sum / hop;
  }
  const out: SpeechSample[] = speechiness(power).map((e, i) => ({ t: clip.start + i / 10, e }));
  return out;
}

/**
 * A clip as 16 kHz mono WAV (what speech recognition uses anyway, and a format every service
 * accepts). Undefined when this browser can't decode the clip (then the original is sent).
 */
export async function toWav16k(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  const Ctor = Offline();
  if (!Ctor) return undefined;
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const buffer = await decode(new Ctor(1, 1, 44100), copy);
    const rate = 16000;
    const ctx = new Ctor(1, Math.max(1, Math.ceil(buffer.duration * rate)), rate);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    const pcm = (await ctx.startRendering()).getChannelData(0);
    const out = new Uint8Array(44 + pcm.length * 2);
    const dv = new DataView(out.buffer);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return out;
  } catch {
    return undefined;
  }
}
