/**
 * Audio from an HLS stream (Real-Debrid's iPhone-friendly copy and similar): the playlist says
 * which segment covers which time, so a time range costs a few small segments of the lowest
 * quality variant. MPEG-TS segments are demuxed to their AAC (ADTS) audio, which browsers decode.
 */
import type { AudioClip, AudioSource } from './audio-source';
import { UnsupportedAudio } from './audio-source';

export interface HlsSegment { uri: string; start: number; duration: number }

const attr = (line: string, key: string) => new RegExp(`${key}=("([^"]*)"|[^,]*)`).exec(line)?.[2] ?? new RegExp(`${key}=([^,]*)`).exec(line)?.[1];

/** A master playlist's best variant for reading audio: a separate audio rendition, else the lightest stream. */
export function pickAudioPlaylist(text: string, base: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const audio = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l) && attr(l, 'URI'));
  const rendition = audio.find((l) => /DEFAULT=YES/.test(l)) ?? audio[0];
  if (rendition) return new URL(attr(rendition, 'URI')!, base).toString();
  let best: { bw: number; uri: string } | undefined;
  lines.forEach((l, i) => {
    if (!l.startsWith('#EXT-X-STREAM-INF:')) return;
    const uri = lines.slice(i + 1).find((x) => x.trim() && !x.startsWith('#'));
    const bw = Number(attr(l, 'BANDWIDTH')) || Infinity;
    if (uri && (!best || bw < best.bw)) best = { bw, uri: new URL(uri.trim(), base).toString() };
  });
  return best?.uri;
}

/** Segments of a media playlist with their start times. */
export function parseMediaPlaylist(text: string, base: string): HlsSegment[] {
  if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(text)) throw new UnsupportedAudio('This stream is encrypted.');
  if (/#EXT-X-MAP:/.test(text)) throw new UnsupportedAudio('This stream’s audio format can’t be read (fMP4 segments).');
  const out: HlsSegment[] = [];
  let t = 0;
  let dur: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
    else if (line && !line.startsWith('#') && dur != null) {
      out.push({ uri: new URL(line, base).toString(), start: t, duration: dur });
      t += dur;
      dur = undefined;
    }
  }
  return out;
}

/** The AAC (ADTS) audio carried in MPEG-TS packets; plain ADTS input is returned as is. */
export function tsToAdts(ts: Uint8Array): Uint8Array {
  if (ts[0] === 0xff && (ts[1] & 0xf6) === 0xf0) return ts; // already ADTS (.aac segments)
  if (ts[0] === 0x49 && ts[1] === 0x44 && ts[2] === 0x33) return stripId3(ts);
  let pmtPid = -1;
  let audioPid = -1;
  const parts: Uint8Array[] = [];
  let pes: Uint8Array[] = [];
  const flush = () => {
    if (!pes.length) return;
    const all = concat(pes);
    pes = [];
    if (all.length < 9 || all[0] !== 0 || all[1] !== 0 || all[2] !== 1) return;
    parts.push(all.subarray(9 + all[8]));
  };
  for (let o = ts.indexOf(0x47); o >= 0 && o + 188 <= ts.length; o += 188) {
    if (ts[o] !== 0x47) { const next = ts.indexOf(0x47, o + 1); if (next < 0) break; o = next - 188; continue; }
    const pusi = (ts[o + 1] & 0x40) !== 0;
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    const afc = (ts[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc === 2 || afc === 0) continue; // no payload
    if (afc === 3) p += 1 + ts[p];
    if (p >= o + 188) continue;
    const payload = ts.subarray(p, o + 188);
    if (pid === 0 && pusi) {
      const s = payload.subarray(1 + payload[0]);
      const len = ((s[1] & 0x0f) << 8) | s[2];
      for (let i = 8; i + 4 <= Math.min(3 + len - 4, s.length); i += 4) {
        const prog = (s[i] << 8) | s[i + 1];
        if (prog !== 0) { pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3]; break; }
      }
    } else if (pid === pmtPid && pusi && audioPid < 0) {
      const s = payload.subarray(1 + payload[0]);
      const len = ((s[1] & 0x0f) << 8) | s[2];
      const infoLen = ((s[10] & 0x0f) << 8) | s[11];
      for (let i = 12 + infoLen; i + 5 <= Math.min(3 + len - 4, s.length);) {
        const type = s[i];
        const epid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
        const esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
        if (type === 0x0f) { audioPid = epid; break; } // AAC in ADTS
        i += 5 + esLen;
      }
    } else if (pid === audioPid && audioPid >= 0) {
      if (pusi) flush();
      pes.push(payload);
    }
  }
  flush();
  if (audioPid < 0) throw new UnsupportedAudio('No AAC audio in this stream.');
  return concat(parts);
}

function stripId3(b: Uint8Array): Uint8Array {
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return b.subarray(10 + size);
}

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of list) { out.set(x, o); o += x.length; }
  return out;
}

export async function openHls(url: string, signal?: AbortSignal, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<AudioSource> {
  const get = async (u: string) => {
    const res = await fetchFn(u, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  let playlistUrl = url;
  let text = await (await get(url)).text();
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const media = pickAudioPlaylist(text, url);
    if (!media) throw new UnsupportedAudio('Empty HLS playlist.');
    playlistUrl = media;
    text = await (await get(media)).text();
  }
  const segments = parseMediaPlaylist(text, playlistUrl);
  if (!segments.length) throw new UnsupportedAudio('Empty HLS playlist.');
  const last = segments[segments.length - 1];
  const duration = last.start + last.duration;
  // Rough cost from the first segment (the lightest variant: usually 50–200 KB/s).
  let costPerSecond = 150_000;
  return {
    duration,
    get costPerSecond() { return costPerSecond; },
    codec: 'aac',
    async read(start: number, end: number, sig?: AbortSignal): Promise<AudioClip> {
      const use = segments.filter((s) => s.start + s.duration > start && s.start < end);
      if (!use.length) throw new Error('nothing to read there');
      const parts: Uint8Array[] = [];
      let bytes = 0;
      for (const s of use) {
        const res = await fetchFn(s.uri, { signal: sig ?? signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const seg = new Uint8Array(await res.arrayBuffer());
        bytes += seg.length;
        parts.push(tsToAdts(seg));
      }
      const first = use[0];
      const lastSeg = use[use.length - 1];
      costPerSecond = Math.max(1, bytes / (lastSeg.start + lastSeg.duration - first.start));
      return { start: first.start, end: lastSeg.start + lastSeg.duration, bytes: concat(parts), mime: 'audio/aac' };
    },
  };
}
