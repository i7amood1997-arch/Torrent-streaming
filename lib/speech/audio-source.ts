/**
 * Read the audio of a remote video file for a time range, ahead of playback, with
 * HTTP Range requests (the same way the player streams it). Used to generate
 * subtitles from speech when a title has none.
 *
 *  - MP4/MOV/M4V: the sample table (moov) says exactly where each audio frame is,
 *    so only audio bytes are downloaded.
 *  - MKV/WebM: audio is interleaved with video inside clusters, so the clusters for
 *    the time range are read (seek via the Cues index).
 */
import { MkvDemuxer, type CuePoint, type MkvHeader, type MkvTrack } from '../mkv/ebml';
import { buildAudioFile, type AudioCodec, type AudioFrame, type AudioTrackInfo } from './elementary';

export interface AudioClip {
  /** Media time (s) of the first frame: segment times from the recogniser are relative to it. */
  start: number;
  end: number;
  bytes: Uint8Array;
  mime: string;
}

export interface AudioSource {
  duration: number;
  codec: AudioCodec;
  read(start: number, end: number, signal?: AbortSignal): Promise<AudioClip>;
}

export class UnsupportedAudio extends Error {}

async function fetchRange(url: string, start: number, end: number | undefined, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end ?? ''}` }, signal });
  if (res.status !== 206 && !(res.status === 200 && start === 0)) {
    res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status}`);
  }
  return res;
}

async function readBytes(url: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetchRange(url, start, end, signal);
  const b = new Uint8Array(await res.arrayBuffer());
  return res.status === 200 ? b.subarray(start, end + 1) : b;
}

/** Open a video URL (trying each candidate, e.g. direct link then relay copy) for audio reads. */
export async function openAudioSource(urls: (string | undefined)[], signal?: AbortSignal): Promise<AudioSource> {
  let lastError: unknown;
  for (const url of urls) {
    if (!url) continue;
    let head: Uint8Array;
    let size: number;
    try {
      const res = await fetchRange(url, 0, 65535, signal);
      size = Number(res.headers.get('content-range')?.split('/')[1]) || Number(res.headers.get('content-length')) || 0;
      head = new Uint8Array(await res.arrayBuffer()).subarray(0, 65536);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      lastError = e;
      continue;
    }
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return openMkv(url, size, signal);
    if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return openMp4(url, head, size, signal);
    throw new UnsupportedAudio('This video format can’t be read for subtitles (only MP4 and MKV).');
  }
  throw new Error(`Couldn’t read the video (${(lastError as Error)?.message ?? 'no link'}).`);
}

// ─── MKV ────────────────────────────────────────────────────────────────────

const MKV_CODECS: Record<string, AudioCodec> = {
  A_AC3: 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', 'A_MPEG/L3': 'mp3', 'A_MPEG/L2': 'mp2', A_TRUEHD: 'truehd',
  A_FLAC: 'flac', A_OPUS: 'opus', A_VORBIS: 'vorbis', 'A_PCM/INT/LIT': 'pcm',
};

function mkvCodec(t: MkvTrack): AudioCodec | undefined {
  if (t.codecId.startsWith('A_AAC')) return 'aac';
  if (t.codecId.startsWith('A_DTS')) return 'dts';
  return MKV_CODECS[t.codecId];
}

/** The track a viewer most likely hears: the default one, else the first readable one. */
function pickMkvAudio(tracks: MkvTrack[]): MkvTrack | undefined {
  const audio = tracks.filter((t) => t.type === 'audio' && !t.encrypted && mkvCodec(t));
  return audio.find((t) => t.isDefault) ?? audio[0];
}

async function openMkv(url: string, size: number, signal?: AbortSignal): Promise<AudioSource> {
  let header: MkvHeader | undefined;
  let collect: ((track: number, pts: number, data: Uint8Array) => void) | undefined;
  const demux = new MkvDemuxer({
    onHeader: (h) => { header = h; },
    onFrame: (f) => collect?.(f.track, f.pts, f.data),
  });

  // The header (tracks) comes before the first cluster, normally within the first few MB.
  {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetchRange(url, 0, undefined, ac.signal);
      const reader = res.body!.getReader();
      let read = 0;
      while (!header && read < 32 << 20) {
        const { value, done } = await reader.read();
        if (done) break;
        demux.push(value);
        read += value.length;
      }
      reader.cancel().catch(() => undefined);
    } catch (e) {
      if (!header) throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      ac.abort();
    }
  }
  if (!header) throw new Error('Couldn’t read the MKV header.');
  const h = header;
  const track = pickMkvAudio(h.tracks);
  if (!track) throw new UnsupportedAudio('This file has no audio track that can be read.');
  const codec = mkvCodec(track)!;
  const info: AudioTrackInfo = {
    codec,
    config: track.codecPrivate,
    sampleRate: Math.round(track.outputSampleRate ?? track.sampleRate ?? 48000),
    channels: track.channels ?? 2,
    bitDepth: track.bitDepth,
  };
  const duration = (h.durationMs ?? 0) / 1000;

  let cues: CuePoint[] | undefined;
  const loadCues = async () => {
    if (cues || !h.cuesPosition) return;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const dm = new MkvDemuxer({ onCues: (c) => { cues = c; } });
      dm.seekTo(h.cuesPosition, false, h.segmentStart);
      const res = await fetchRange(url, h.cuesPosition, undefined, ac.signal);
      const reader = res.body!.getReader();
      let read = 0;
      while (!cues && read < 32 << 20) {
        const { value, done } = await reader.read();
        if (done) break;
        dm.push(value);
        read += value.length;
      }
      reader.cancel().catch(() => undefined);
    } catch { /* no index: estimate positions instead */ }
    finally { signal?.removeEventListener('abort', onAbort); ac.abort(); }
    const found = cues as CuePoint[] | undefined; // set from the demuxer callback
    if (found) {
      const videoTrack = h.tracks.find((t) => t.type === 'video')?.number;
      const v = found.filter((c) => c.track === videoTrack);
      cues = (v.length ? v : found).sort((a, b) => a.timeMs - b.timeMs);
    }
  };

  const bytesPerSec = duration && size ? size / duration : 0;

  const read = async (start: number, end: number, sig?: AbortSignal): Promise<AudioClip> => {
    await loadCues();
    let pos: number;
    let resync = false;
    if (cues?.length) {
      let best = cues[0];
      for (const c of cues) if (c.timeMs <= start * 1000) best = c;
      pos = best.pos;
    } else if (bytesPerSec) {
      pos = Math.max(h.segmentStart, Math.floor(h.segmentStart + (start / duration) * (size - h.segmentStart)) - (4 << 20));
      resync = true;
    } else {
      pos = h.segmentStart;
      resync = true;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const frames: AudioFrame[] = [];
      let firstPts: number | undefined;
      let finished = false;
      collect = (tn, pts, data) => {
        firstPts ??= pts;
        if (pts > end * 1000 + 1500) { finished = true; return; }
        if (tn !== track.number) return;
        if (pts >= start * 1000 - 50 && pts < end * 1000) frames.push({ t: pts / 1000, data });
      };
      demux.seekTo(pos, resync);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      sig?.addEventListener('abort', onAbort);
      try {
        const res = await fetchRange(url, pos, undefined, ac.signal);
        const reader = res.body!.getReader();
        let p = pos;
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) break;
          p += value.length;
          try { demux.push(value); } catch { demux.seekTo(p, true); }
        }
        reader.cancel().catch(() => undefined);
      } finally {
        sig?.removeEventListener('abort', onAbort);
        ac.abort();
        collect = undefined;
      }
      sig?.throwIfAborted();
      // An estimated position can land after the start: step back and try again.
      if (resync && firstPts !== undefined && firstPts > start * 1000 + 500 && pos > h.segmentStart) {
        pos = Math.max(h.segmentStart, pos - Math.max(8 << 20, Math.round(bytesPerSec * ((firstPts / 1000 - start) + 20))));
        continue;
      }
      if (!frames.length) throw new Error('No audio in this part of the video.');
      frames.sort((a, b) => a.t - b.t);
      const file = buildAudioFile(info, frames);
      return { start: frames[0].t, end: frames[frames.length - 1].t, ...file };
    }
    throw new Error('Couldn’t find this part of the video.');
  };

  return { duration, codec, read };
}

// ─── MP4 ────────────────────────────────────────────────────────────────────

interface Box { type: string; start: number; end: number } // payload range in the buffer

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr) return;
    yield { type, start: o + hdr, end: Math.min(end, o + size) };
    o += size;
  }
}

const child = (b: Uint8Array, parent: Box, type: string) => {
  for (const x of boxes(b, parent.start, parent.end)) if (x.type === type) return x;
  return undefined;
};

/** Find the moov box: at the start (fast-start files) or after the media data. */
async function loadMoov(url: string, head: Uint8Array, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  let offset = 0;
  for (let guard = 0; guard < 64; guard++) {
    let hdr: Uint8Array;
    if (offset + 16 <= head.length) hdr = head.subarray(offset, offset + 16);
    else if (size && offset + 8 <= size) hdr = await readBytes(url, offset, Math.min(size - 1, offset + 15), signal);
    else break;
    const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    let boxSize = dv.getUint32(0);
    const type = String.fromCharCode(hdr[4], hdr[5], hdr[6], hdr[7]);
    if (boxSize === 1) boxSize = Number(dv.getBigUint64(8));
    else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < 8) break;
    if (type === 'moov') {
      if (boxSize > 96 << 20) throw new UnsupportedAudio('This MP4’s index is too large to read.');
      const whole = offset + boxSize <= head.length ? head.subarray(offset, offset + boxSize) : await readBytes(url, offset, offset + boxSize - 1, signal);
      return whole;
    }
    offset += boxSize;
  }
  throw new Error('Couldn’t find the MP4 index (moov).');
}

function readDescriptorLength(b: Uint8Array, o: number): [number, number] {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const c = b[o++];
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return [len, o];
}

/** objectTypeIndication + DecoderSpecificInfo from an esds box payload. */
function parseEsds(b: Uint8Array, box: Box): { oti: number; dsi?: Uint8Array } {
  let o = box.start + 4; // version/flags
  let oti = 0x40;
  let dsi: Uint8Array | undefined;
  while (o < box.end) {
    const tag = b[o++];
    const [len, p] = readDescriptorLength(b, o);
    o = p;
    if (tag === 0x03) {
      const flags = b[o + 2];
      o += 3;
      if (flags & 0x80) o += 2;
      if (flags & 0x40) o += 1 + b[o];
      if (flags & 0x20) o += 2;
      continue; // descend
    }
    if (tag === 0x04) { oti = b[o]; o += 13; continue; }
    if (tag === 0x05) { dsi = b.slice(o, o + len); break; }
    o += len;
  }
  return { oti, dsi };
}

interface Mp4Track { info: AudioTrackInfo; times: Float64Array; offsets: Float64Array; sizes: Uint32Array; duration: number }

export function parseMp4Audio(moov: Uint8Array): Mp4Track {
  const b = moov;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const root = [...boxes(b, 0, b.length)].find((x) => x.type === 'moov');
  if (!root) throw new Error('Not an MP4 index');
  let unsupported = '';
  for (const trak of boxes(b, root.start, root.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(b, trak, 'mdia');
    const hdlr = mdia && child(b, mdia, 'hdlr');
    if (!mdia || !hdlr || String.fromCharCode(...b.subarray(hdlr.start + 8, hdlr.start + 12)) !== 'soun') continue;
    const mdhd = child(b, mdia, 'mdhd')!;
    const v1 = b[mdhd.start] === 1;
    const timescale = dv.getUint32(mdhd.start + (v1 ? 20 : 12));
    const stbl = child(b, child(b, mdia, 'minf')!, 'stbl')!;
    const stsd = child(b, stbl, 'stsd')!;
    const entry = [...boxes(b, stsd.start + 8, stsd.end)][0];
    if (!entry) continue;
    // AudioSampleEntry: 8 bytes SampleEntry + 20 bytes, plus 16/36 more for QuickTime v1/v2.
    const ver = dv.getUint16(entry.start + 8);
    const channels = dv.getUint16(entry.start + 16);
    const sampleRate = dv.getUint32(entry.start + 24) >>> 16;
    const kids = entry.start + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    const sub = (type: string) => { for (const x of boxes(b, kids, entry.end)) if (x.type === type) return x; return undefined; };
    let info: AudioTrackInfo | undefined;
    if (entry.type === 'mp4a') {
      const esds = sub('esds') ?? (sub('wave') && child(b, sub('wave')!, 'esds'));
      const { oti, dsi } = esds ? parseEsds(b, esds) : { oti: 0x40, dsi: undefined };
      if (oti === 0x40 || oti === 0x66 || oti === 0x67) info = { codec: 'aac', config: dsi, sampleRate, channels };
      else if (oti === 0x6b || oti === 0x69) info = { codec: 'mp3', sampleRate, channels };
      else unsupported = `audio type 0x${oti.toString(16)}`;
    } else if (entry.type === 'ac-3') info = { codec: 'ac3', sampleRate, channels };
    else if (entry.type === 'ec-3') info = { codec: 'eac3', sampleRate, channels };
    else if (entry.type === '.mp3') info = { codec: 'mp3', sampleRate, channels };
    else if (entry.type === 'fLaC') {
      const dfla = sub('dfLa');
      if (dfla) info = { codec: 'flac', config: Uint8Array.of(0x66, 0x4c, 0x61, 0x43, ...b.subarray(dfla.start + 4, dfla.end)), sampleRate, channels };
    } else unsupported = `audio codec ${entry.type}`;
    if (!info) continue;

    // Sample table → time, byte offset and size of every audio frame.
    const stsz = child(b, stbl, 'stsz')!;
    const uniform = dv.getUint32(stsz.start + 4);
    const count = dv.getUint32(stsz.start + 8);
    if (!count) throw new UnsupportedAudio('This MP4 keeps its audio in fragments, which can’t be read for subtitles.');
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = uniform || dv.getUint32(stsz.start + 12 + i * 4);

    const times = new Float64Array(count);
    const stts = child(b, stbl, 'stts')!;
    let n = 0;
    let t = 0;
    for (let e = 0, entries = dv.getUint32(stts.start + 4); e < entries && n < count; e++) {
      const c = dv.getUint32(stts.start + 8 + e * 8);
      const d = dv.getUint32(stts.start + 12 + e * 8);
      for (let k = 0; k < c && n < count; k++, n++) { times[n] = t / timescale; t += d; }
    }

    const stco = child(b, stbl, 'stco');
    const co64 = child(b, stbl, 'co64');
    const chunkCount = dv.getUint32((stco ?? co64)!.start + 4);
    const chunkOffset = (i: number) => (stco ? dv.getUint32(stco.start + 8 + i * 4) : Number(dv.getBigUint64(co64!.start + 8 + i * 8)));
    const stsc = child(b, stbl, 'stsc')!;
    const stscEntries = dv.getUint32(stsc.start + 4);
    const offsets = new Float64Array(count);
    let sample = 0;
    for (let e = 0; e < stscEntries; e++) {
      const first = dv.getUint32(stsc.start + 8 + e * 12) - 1;
      const per = dv.getUint32(stsc.start + 12 + e * 12);
      const next = e + 1 < stscEntries ? dv.getUint32(stsc.start + 20 + e * 12) - 1 : chunkCount;
      for (let c = first; c < next && sample < count; c++) {
        let o = chunkOffset(c);
        for (let k = 0; k < per && sample < count; k++, sample++) { offsets[sample] = o; o += sizes[sample]; }
      }
    }
    return { info, times, offsets, sizes, duration: t / timescale };
  }
  throw new UnsupportedAudio(unsupported ? `This video’s ${unsupported} can’t be read for subtitles.` : 'This video has no audio track.');
}

async function openMp4(url: string, head: Uint8Array, size: number, signal?: AbortSignal): Promise<AudioSource> {
  const moov = await loadMoov(url, head, size, signal);
  const tr = parseMp4Audio(moov);
  const MERGE_GAP = 256 << 10;

  const read = async (start: number, end: number, sig?: AbortSignal): Promise<AudioClip> => {
    let a = 0;
    let hi = tr.times.length;
    while (a < hi) { const m = (a + hi) >> 1; if (tr.times[m] < start) a = m + 1; else hi = m; }
    let z = a;
    while (z < tr.times.length && tr.times[z] < end) z++;
    if (z <= a) throw new Error('No audio in this part of the video.');
    // Contiguous byte runs (audio is stored in chunks between video chunks).
    const runs: { from: number; to: number; first: number; last: number }[] = [];
    for (let i = a; i < z; i++) {
      const o = tr.offsets[i];
      const r = runs[runs.length - 1];
      if (r && o >= r.to && o - r.to <= MERGE_GAP) { r.to = o + tr.sizes[i]; r.last = i; }
      else runs.push({ from: o, to: o + tr.sizes[i], first: i, last: i });
    }
    const frames: AudioFrame[] = new Array(z - a);
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const r = runs[next++];
        const bytes = await readBytes(url, r.from, r.to - 1, sig);
        for (let i = r.first; i <= r.last; i++) {
          const o = tr.offsets[i] - r.from;
          frames[i - a] = { t: tr.times[i], data: bytes.subarray(o, o + tr.sizes[i]) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, runs.length) }, worker));
    const list = frames.filter(Boolean);
    const file = buildAudioFile(tr.info, list);
    return { start: list[0].t, end: list[list.length - 1].t, ...file };
  };

  return { duration: tr.duration, codec: tr.info.codec, read };
}
