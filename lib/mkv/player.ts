'use client';
/**
 * Plays an MKV over HTTP in browsers that can't open MKV themselves (iPhone/iPad
 * Safari, desktop Safari, Firefox): streams the file with Range requests,
 * repackages it to fragmented MP4 on the fly (lib/mkv/remux) and feeds Media
 * Source Extensions — ManagedMediaSource on iOS 17.1+, MediaSource elsewhere.
 *
 * Nothing is re-encoded, so it only works when the device can decode the codecs
 * inside (H.264 8-bit, HEVC, AV1 on newer devices; AAC, AC-3, E-AC-3, Opus).
 */
import { MkvDemuxer, type CuePoint, type MkvFrame, type MkvHeader } from './ebml';
import { MkvRemuxer, selectTracks, TIMELINE_OFFSET_MS, type Selection, type SubtitleCue } from './remux';

type Kind = 'video' | 'audio';

export interface MkvPlayerOptions {
  onError(message: string): void;
  /** Embedded text subtitles (times already on the media timeline). */
  onSubtitle?(lang: string, label: string, cue: { start: number; end: number; text: string }): void;
  onTracks?(info: { video: string; audio?: string; subtitles: number }): void;
  audioLanguages?: string[];
  /** Used if `url` can't be read from the browser (e.g. the host doesn't allow other sites): typically the relay proxy. */
  fallbackUrl?: string;
}

const MAX_AHEAD_S = 75; // stop downloading this far ahead of the playhead
const KEEP_BEHIND_S = 30; // evict buffered media older than this
const MAX_QUEUED_BYTES = 6 << 20;

function mediaSourceCtor(): (typeof MediaSource) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as any;
  return w.ManagedMediaSource ?? w.MediaSource;
}

/** True if this browser can use the converter at all (codec support is checked per file). */
export function mkvRemuxSupported(): boolean {
  return !!mediaSourceCtor();
}

/** Friendlier names for codec strings in error messages. */
function codecName(problem: string): string {
  return problem
    .replace(/avc1\.6e\w*/i, '10-bit H.264 (Hi10P)')
    .replace(/avc1\.\w+/i, 'H.264')
    .replace(/hvc1[\w.]*/i, 'HEVC')
    .replace(/av01[\w.]*/i, 'AV1')
    .replace(/vp09[\w.]*/i, 'VP9')
    .replace(/ec-3/i, 'Dolby Digital Plus')
    .replace(/ac-3/i, 'Dolby Digital')
    .replace(/mp4a\.40\.\d+/i, 'AAC');
}

/** Set `localStorage.mkvDebug = '1'` to log the converter's decisions to the console. */
const debug = (...a: unknown[]) => { try { if (localStorage.getItem('mkvDebug')) console.log('[mkv]', ...a); } catch { /* storage blocked */ } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MkvMsePlayer {
  private MS = mediaSourceCtor()!;
  private ms?: MediaSource;
  private objectUrl?: string;
  private sb: Partial<Record<Kind, SourceBuffer>> = {};
  private queue: Record<Kind, Uint8Array[]> = { video: [], audio: [] };
  private queuedBytes = 0;
  private demux?: MkvDemuxer;
  private remux?: MkvRemuxer;
  private header?: MkvHeader;
  private selection?: Selection;
  private cues?: CuePoint[];
  private cuesLoading?: Promise<void>;
  private fileSize?: number;
  private gen = 0;
  private fetchCtl?: AbortController;
  private destroyed = false;
  private failed = false;
  private ended = false;
  private startJumped = false;
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private evictTimer?: ReturnType<typeof setInterval>;

  constructor(private video: HTMLVideoElement, private url: string, private opts: MkvPlayerOptions) {}

  async start() {
    const MS = this.MS;
    const managed = MS !== (window as any).MediaSource;
    const ms = (this.ms = new MS());
    // ManagedMediaSource needs AirPlay disabled (or an alternative source) to be allowed to play.
    if (managed) (this.video as any).disableRemotePlayback = true;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
    await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
    if (this.destroyed) return;

    this.demux = new MkvDemuxer({
      onHeader: (h) => this.onHeader(h),
      onFrame: (f) => this.onFrame(f),
      onCues: (c) => { this.cues = c; },
    });
    this.video.addEventListener('seeking', this.onSeeking);
    this.video.addEventListener('waiting', this.onWaiting);
    this.evictTimer = setInterval(() => this.evict(), 5000);
    void this.load(0, this.gen);
    // Fetch the seek index in the background once playback is under way.
    setTimeout(() => { if (!this.destroyed && !this.failed) void this.loadCues(); }, 15000);
  }

  destroy() {
    this.destroyed = true;
    this.gen++;
    this.fetchCtl?.abort();
    clearTimeout(this.waitingTimer);
    clearInterval(this.evictTimer);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('waiting', this.onWaiting);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  private fail(message: string) {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    this.fetchCtl?.abort();
    this.opts.onError(message);
  }

  // ── container → MSE ───────────────────────────────────────────────────────

  private onHeader(h: MkvHeader) {
    if (this.header) return;
    this.header = h;
    const sel = (this.selection = selectTracks(h, { isSupported: (t) => this.MS.isTypeSupported(t), audioLanguages: this.opts.audioLanguages }));
    const problems = [...new Set(sel.problems.map(codecName))];
    if (!sel.video) {
      this.fail(`This MKV can't be played on this device (${problems.join(', ') || 'no video track'}). Choose another release, e.g. an 8-bit H.264 or HEVC one, or an MP4.`);
      return;
    }
    if (!sel.audio && h.tracks.some((t) => t.type === 'audio')) {
      this.fail(`This release's audio (${problems.filter((p) => !/video/.test(p)).join(', ') || 'unknown format'}) can't be played on this device. Choose a release with AAC or DDP (E-AC-3) audio.`);
      return;
    }
    try {
      for (const o of [sel.video, sel.audio]) if (o) this.sb[o.kind] = this.ms!.addSourceBuffer(o.plan.mime);
      if (h.durationMs) this.ms!.duration = (h.durationMs + TIMELINE_OFFSET_MS) / 1000;
    } catch (e) {
      this.fail(`The player couldn't start (${(e as Error).message}).`);
      return;
    }
    for (const kind of ['video', 'audio'] as Kind[]) this.sb[kind]?.addEventListener('updateend', () => this.pump(kind));
    const subTracks = new Map(sel.subtitles.map((t) => [t.number, t]));
    this.remux = new MkvRemuxer(sel, (cue: SubtitleCue) => {
      const t = subTracks.get(cue.track);
      if (t) this.opts.onSubtitle?.(t.language, t.name ?? '', cue);
    });
    this.opts.onTracks?.({ video: codecName(sel.video.plan.codec), audio: sel.audio && codecName(sel.audio.plan.codec), subtitles: sel.subtitles.length });
  }

  private onFrame(f: MkvFrame) {
    if (!this.remux || this.failed) return;
    const r = this.remux.push(f);
    if (!r) return;
    if (r.init) this.enqueue(r.kind, r.init);
    for (const s of r.segments) this.enqueue(s.kind, s.data);
  }

  private enqueue(kind: Kind, data: Uint8Array) {
    if (!this.sb[kind]) return;
    this.queue[kind].push(data);
    this.queuedBytes += data.length;
    this.pump(kind);
  }

  private pump(kind: Kind) {
    const sb = this.sb[kind];
    // 'ended' is fine too: appending after endOfStream() reopens the MediaSource (e.g. seeking back).
    if (!sb || sb.updating || this.destroyed || this.ms?.readyState === 'closed') return;
    const next = this.queue[kind][0];
    if (!next) {
      this.afterAppend();
      return;
    }
    try {
      debug('append', kind, next.length, 'queued', this.queuedBytes);
      sb.appendBuffer(next as BufferSource);
      this.queue[kind].shift();
      this.queuedBytes -= next.length;
    } catch (e) {
      debug('append failed', kind, (e as Error).name, (e as Error).message);
      if ((e as DOMException).name === 'QuotaExceededError') {
        // Buffer full: drop old media and retry shortly (playback frees room too).
        this.evict(true);
        setTimeout(() => this.pump(kind), 500);
      } else {
        this.fail(`The video stream was rejected by the player (${(e as Error).message}).`);
      }
    }
  }

  /** Jump over the small gap at the very start (timeline offset) or tiny gaps between fragments. */
  private afterAppend() {
    const v = this.video;
    const b = this.sb.video?.buffered;
    if (!b?.length) return;
    if (!this.startJumped && v.currentTime < b.start(0) && b.start(0) - v.currentTime < 3) {
      this.startJumped = true;
      v.currentTime = b.start(0);
    }
    if (this.ended && !this.queue.video.length && !this.queue.audio.length && !this.sb.video?.updating && !this.sb.audio?.updating && this.ms?.readyState === 'open') {
      debug('endOfStream');
      try { this.ms.endOfStream(); } catch { /* not ready yet */ }
    }
  }

  private evict(force = false) {
    const t = this.video.currentTime;
    for (const kind of ['video', 'audio'] as Kind[]) {
      const sb = this.sb[kind];
      if (!sb || sb.updating || !sb.buffered.length) continue;
      const cut = t - (force ? 10 : KEEP_BEHIND_S);
      if (sb.buffered.start(0) < cut - 1) {
        try { sb.remove(0, cut); } catch { /* ignore */ }
      }
    }
  }

  private bufferedAhead(): number {
    const b = this.sb.video?.buffered;
    const t = this.video.currentTime;
    if (!b) return 0;
    // A range starting just ahead (the timeline offset at the start) counts too.
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 1 && b.end(i) > t) return b.end(i) - t;
    return 0;
  }

  private isBuffered(t: number): boolean {
    for (const sb of Object.values(this.sb)) {
      if (!sb) continue;
      let ok = false;
      for (let i = 0; i < sb.buffered.length; i++) if (sb.buffered.start(i) <= t + 0.25 && sb.buffered.end(i) > t + 0.5) ok = true;
      if (!ok) return false;
    }
    return true;
  }

  /** Download pacing: enough buffered, a full append queue, or a ManagedMediaSource asking us to pause. */
  private async waitForRoom(gen: number) {
    for (;;) {
      if (gen !== this.gen || this.destroyed) return;
      const streamingAllowed = (this.ms as any)?.streaming !== false;
      if (streamingAllowed && this.queuedBytes < MAX_QUEUED_BYTES && this.bufferedAhead() < MAX_AHEAD_S) return;
      await sleep(400);
    }
  }

  // ── network ───────────────────────────────────────────────────────────────

  private async load(pos: number, gen: number) {
    let attempt = 0;
    while (gen === this.gen && !this.destroyed && !this.failed) {
      const ac = new AbortController();
      this.fetchCtl = ac;
      try {
        debug('load from', pos, 'gen', gen);
        const res = await fetch(this.url, { headers: { Range: `bytes=${pos}-` }, signal: ac.signal });
        if (res.status !== 206 && !(res.status === 200 && pos === 0)) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-range')?.split('/')[1]);
        if (total) this.fileSize = total;
        else if (res.status === 200) this.fileSize = Number(res.headers.get('content-length')) || this.fileSize;
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (gen !== this.gen) { reader.cancel().catch(() => undefined); return; }
          if (done) break;
          pos += value.length;
          attempt = 0;
          try {
            this.demux!.push(value);
          } catch (e) {
            // Corrupt or misaligned data: drop what's pending and resync at the next cluster.
            debug('parse error, resyncing', (e as Error).message);
            this.remux?.reset();
            this.demux!.seekTo(pos, true);
          }
          if (this.failed) { reader.cancel().catch(() => undefined); return; }
          await this.waitForRoom(gen);
          if (gen !== this.gen) { reader.cancel().catch(() => undefined); return; }
        }
        debug('load finished at', pos, 'of', this.fileSize, 'gen', gen);
        if (this.fileSize && pos >= this.fileSize) {
          for (const s of this.remux?.flush() ?? []) this.enqueue(s.kind, s.data);
          this.ended = true;
          this.afterAppend();
          return;
        }
        // Connection closed early (idle timeout while paused): resume where we stopped.
      } catch (e) {
        if (gen !== this.gen || this.destroyed) return;
        if ((e as Error).name === 'AbortError') return;
        debug('load error', (e as Error).message);
        // Nothing read yet and the link can't be fetched from here (CORS, refused): switch to the fallback once.
        if (pos === 0 && this.opts.fallbackUrl && this.url !== this.opts.fallbackUrl && (e instanceof TypeError || /HTTP 40[13]/.test((e as Error).message))) {
          debug('switching to fallback URL');
          this.url = this.opts.fallbackUrl;
          continue;
        }
        if (++attempt > 6) {
          this.fail(`Lost the connection to the video (${(e as Error).message}).`);
          return;
        }
        await sleep(800 * attempt);
      }
    }
  }

  /** Read the Cues (seek index). Usually at the end of the file; positions are byte offsets of clusters. */
  private loadCues(): Promise<void> {
    if (this.cues || !this.header?.cuesPosition) return Promise.resolve();
    this.cuesLoading ??= (async () => {
      const start = this.header!.cuesPosition!;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      try {
        const dm = new MkvDemuxer({ onCues: (c) => { this.cues = c; ac.abort(); } });
        dm.seekTo(start, false, this.header!.segmentStart);
        const res = await fetch(this.url, { headers: { Range: `bytes=${start}-` }, signal: ac.signal });
        const reader = res.body!.getReader();
        let read = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          dm.push(value);
          read += value.length;
          if (this.cues || read > 32 << 20) { reader.cancel().catch(() => undefined); break; }
        }
      } catch { /* aborted on success, or no index: seeks fall back to estimates */ }
      finally { clearTimeout(timer); }
    })();
    return this.cuesLoading;
  }

  // ── seeking ───────────────────────────────────────────────────────────────

  private onSeeking = () => {
    if (!this.header || this.failed) return;
    const t = this.video.currentTime;
    debug('seeking to', t, 'buffered?', this.isBuffered(t));
    if (this.isBuffered(t)) return;
    void this.seekTo(t);
  };

  /** If playback stalls on data we no longer have (evicted), refetch from the playhead. */
  private onWaiting = () => {
    clearTimeout(this.waitingTimer);
    this.waitingTimer = setTimeout(() => {
      const t = this.video.currentTime;
      if (this.destroyed || this.failed || this.isBuffered(t)) return;
      const b = this.sb.video?.buffered;
      // A tiny gap right ahead: skip it.
      if (b) for (let i = 0; i < b.length; i++) if (b.start(i) > t && b.start(i) - t < 1) { this.video.currentTime = b.start(i) + 0.01; return; }
      void this.seekTo(t);
    }, 2500);
  };

  private async seekTo(t: number) {
    const gen = ++this.gen;
    this.fetchCtl?.abort();
    this.ended = false;
    this.remux?.reset();
    // Drop queued fragments for the old position (an in-progress append finishes on its own).
    for (const kind of ['video', 'audio'] as Kind[]) {
      for (const d of this.queue[kind]) this.queuedBytes -= d.length;
      this.queue[kind] = [];
    }
    const h = this.header!;
    const fileMs = Math.max(0, t * 1000 - TIMELINE_OFFSET_MS);
    await this.loadCues();
    if (gen !== this.gen) return;

    let pos: number;
    let resync = false;
    const videoTrack = this.selection?.video?.track.number;
    const cues = (this.cues ?? []).filter((c) => !videoTrack || c.track === videoTrack || !this.cues!.some((x) => x.track === videoTrack));
    if (cues.length) {
      let best = cues[0];
      for (const c of cues) if (c.timeMs <= fileMs) best = c;
      pos = best.pos;
    } else if (this.fileSize && h.durationMs) {
      // No index: estimate by bitrate, then scan forward to the next cluster.
      const frac = Math.min(0.995, fileMs / h.durationMs);
      pos = Math.max(h.segmentStart, Math.floor(h.segmentStart + frac * (this.fileSize - h.segmentStart)) - (2 << 20));
      resync = true;
    } else {
      pos = h.segmentStart;
      resync = true;
    }
    debug('seek', t, '→ byte', pos, resync ? '(estimated)' : '(cue)', 'cues', this.cues?.length);
    this.demux!.seekTo(pos, resync);
    void this.load(pos, gen);
  }
}
