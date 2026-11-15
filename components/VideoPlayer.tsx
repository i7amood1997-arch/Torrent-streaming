'use client';
/**
 * Custom video player.
 *
 * Engines
 *  - debrid:     magnet → /api/debrid/resolve (polls while the provider caches) → HTTPS MP4/MKV or HLS
 *  - webtorrent: magnet → in-browser WebRTC swarm → service-worker stream URL (desktop only)
 *  - direct:     user pasted an http(s) .mp4/.m3u8 URL
 *
 * Playback: native HLS on Safari/iOS, hls.js elsewhere; progressive HTTP for files.
 * Subtitles: custom RTL-aware overlay (Arabic + English, dual) with native <track>
 * fallback for iPhone's system fullscreen player.
 * Input: Space/K play · F fullscreen · ←/→ seek · ↑/↓ volume · M mute · C subs · [ ] sub delay · P PiP
 * Touch: tap = controls, double-tap left/right = ∓10 s, horizontal drag = scrub.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { api, apiBase, type StreamStats } from '@/lib/client-api';
import { MkvMsePlayer, mkvRemuxSupported } from '@/lib/mkv/player';
import { TIMELINE_OFFSET_MS } from '@/lib/mkv/remux';
import { agrees, alignSubtitles, confident, type Alignment } from '@/lib/autosync';
import { AudioTap, isTapped, unlockAudio } from '@/lib/audio-tap';
import { hashRemoteVideo } from '@/lib/subtitle-hash';
import { audioPlayable, canPlayMkv, isHlsUrl, isIOS, supportsWebTorrent } from '@/lib/platform';
import { formatBytes } from '@/lib/release-parser';
import { hasDebrid, useApp } from '@/lib/store';
import { toVtt } from '@/lib/subtitle-parser';
import { startWebTorrent, type WebTorrentSession, type WebTorrentStats } from '@/lib/webtorrent-engine';
import { openAudioSource } from '@/lib/speech/audio-source';
import { SubtitleGenerator, type GeneratorStatus } from '@/lib/speech/generate';
import { IconBack, IconBack10, IconCC, IconCopy, IconExpand, IconFwd10, IconMute, IconPause, IconPip, IconPlay, IconShrink, IconVolume } from './icons';
import { usePresync } from './use-presync';
import { isTV, moveFocus, nativeTV, onTvBack, setTvKeyOverride } from '@/lib/tv';
import { LANGS, setSubtitlePlayhead, SubtitleOverlay, SubtitleSettings, useSubtitles, type GenerateControl, type Lang, type PlayingFile } from './subtitles';


type Engine = 'debrid' | 'cloud' | 'webtorrent' | 'webtor' | 'direct';
type Phase = 'idle' | 'resolving' | 'ready' | 'error' | 'native';

interface Source {
  url: string;
  engine: Engine;
  fileName?: string;
  mime?: string;
  alt?: string; // alternative (e.g. HLS transcode) if the primary fails
  /** MKV the browser can't open itself: repackage to MP4 on the fly (lib/mkv). */
  remux?: boolean;
  /** false after the host refused a CORS load: play without it (no audio analysis for auto-sync). */
  cors?: boolean;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

const fmtTime = (s: number) => {
  if (!Number.isFinite(s)) return '--:--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const resumeKey = (id: string) => `resume:${id}`;

/** Links to the playing file that page code can read with Range requests (direct, alternate, relay copy). */
function readableUrls(source: Source): string[] | undefined {
  if (source.engine === 'webtor' || source.engine === 'webtorrent') return undefined;
  const urls = [
    isHlsUrl(source.url, source.mime) ? undefined : source.url,
    source.alt && !isHlsUrl(source.alt) ? source.alt : undefined,
    source.engine !== 'cloud' && !source.url.includes('/api/proxy') && !isHlsUrl(source.url, source.mime) ? api.proxyUrl(source.url) : undefined,
  ].filter((u): u is string => !!u);
  return urls.length ? [...new Set(urls)] : undefined;
}

const PROVIDER_NAMES: Record<string, string> = { realdebrid: 'Real-Debrid', torbox: 'TorBox', debridlink: 'Debrid-Link' };

/**
 * webtor.io opens a magnet as a top-level page via /ext/magnet?url=… (the route its
 * browser extension uses). Its embedded iframe player fails on iPhone Safari with
 * "CSRF token mismatch" because Safari blocks third-party cookies inside iframes.
 */
const webtorUrl = (magnet: string) => `https://webtor.io/ext/magnet?url=${encodeURIComponent(magnet)}`;

export function VideoPlayer({ onBack }: { onBack?: () => void }) {
  const req = useApp((s) => s.nowPlaying);
  const view = useApp((s) => s.view);
  const settings = useApp((s) => s.settings);
  const caps = useApp((s) => s.caps);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const wtRef = useRef<WebTorrentSession | null>(null);
  const mkvRef = useRef<MkvMsePlayer | null>(null);
  const subsRef = useRef<ReturnType<typeof useSubtitles> | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState<Source>();
  const [wtStats, setWtStats] = useState<WebTorrentStats>();
  const [cloudStats, setCloudStats] = useState<StreamStats>();
  const [engineOverride, setEngineOverride] = useState<Engine>();
  /** Engine the current attempt used (so a failed Debrid attempt doesn't offer "Use Debrid" again). */
  const [engineUsed, setEngineUsed] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState(false);
  const [subsHidden, setSubsHidden] = useState(false);
  const [flash, setFlash] = useState<{ side: 'left' | 'right' | 'center'; label: string; key: number }>();
  const [scrub, setScrub] = useState<number>();

  const [videoKey, setVideoKey] = useState(0);
  const [playingFile, setPlayingFile] = useState<PlayingFile>({ ready: false });
  const subs = useSubtitles(req, playingFile);
  subsRef.current = subs;
  const resumeId = req?.result?.id ?? req?.url;

  // ── Engine selection & resolution ─────────────────────────────────────────
  const chooseEngine = useCallback((): Engine | string => {
    if (req?.kind === 'url') return 'direct';
    const pref = engineOverride ?? settings.engine;
    const debridOk = hasDebrid(settings, caps);
    const wtOk = supportsWebTorrent();
    if (pref === 'debrid') return debridOk ? 'debrid' : 'Add a Debrid API key in Settings to stream on this device.';
    if (pref === 'webtorrent') return wtOk ? 'webtorrent' : 'WebTorrent needs a desktop Chromium/Firefox browser. Use the free online player on iPhone/iPad.';
    if (pref === 'webtor') return 'webtor';
    if (pref === 'cloud') return caps?.stream ? 'cloud' : 'Built-in streaming needs your own relay (Settings → Advanced: own backend).';
    if (debridOk) return 'debrid';
    // No Debrid key: stream through the user's own relay if it supports it, else the free online player.
    return caps?.stream ? 'cloud' : 'webtor';
  }, [req?.kind, engineOverride, settings, caps]);

  useEffect(() => {
    setEngineOverride(undefined);
  }, [req?.nonce]);

  useEffect(() => {
    wtRef.current?.destroy();
    wtRef.current = null;
    setSource(undefined); setError(undefined); setProgress(undefined); setWtStats(undefined); setCloudStats(undefined); setPanel(false);
    if (!req) { setPhase('idle'); return; }

    const ac = new AbortController();
    const engine = chooseEngine();
    setEngineUsed(engine);
    setNotice(undefined);
    setPhase('resolving');

    (async () => {
      if (engine === 'direct') {
        const link = req.url!;
        const fileName = req.result?.fileName ?? decodeURIComponent(link.split('?')[0].split('/').pop() ?? '');
        const headers = req.result?.headers;
        const viaRelay = api.proxyUrl(link, headers);
        const ext = (req.result?.container ?? fileName.split('.').pop() ?? '').toLowerCase();
        const hls = isHlsUrl(link) || ext === 'm3u8';
        const mkv = ext === 'mkv' || (ext === 'webm' && isIOS());
        if (headers && !viaRelay) throw new Error('This link needs your own relay to play (Settings → Advanced: own backend).');
        if (mkv && !canPlayMkv()) {
          // The converter reads the file itself, which most hosts only allow through the relay (CORS).
          if (!mkvRemuxSupported()) throw new Error('Playing MKV files on iPhone/iPad needs iOS 17.1 or later.');
          setSource({ url: viaRelay ?? link, engine: 'direct', fileName, mime: 'video/x-matroska', remux: true });
          return;
        }
        // Try the link as-is first (fastest); fall back to the relay if the host refuses.
        setSource({
          url: headers ? viaRelay! : link,
          alt: headers ? undefined : viaRelay,
          engine: 'direct',
          fileName,
          mime: hls ? 'application/vnd.apple.mpegurl' : undefined,
        });
        return;
      }
      if (engine !== 'debrid' && engine !== 'cloud' && engine !== 'webtorrent' && engine !== 'webtor') throw new Error(engine);
      const r = req.result!;

      if (engine === 'cloud') {
        setStatus('Opening the torrent on your relay…');
        const deadline = Date.now() + 120_000;
        for (;;) {
          const res = await api.streamPrepare(r, { season: req.season, episode: req.episode }, ac.signal);
          if (res.status === 'error') throw new Error(res.message);
          if (res.status === 'ready') {
            const ext = res.fileName.split('.').pop()?.toLowerCase() ?? '';
            const native = ['mp4', 'm4v', 'mov'].includes(ext) || (ext === 'mkv' && canPlayMkv()) || (ext === 'webm' && !isIOS());
            const remux = !native && (ext === 'mkv' || ext === 'webm') && mkvRemuxSupported();
            if (!native && !remux) {
              throw new Error(
                ext === 'mkv' || ext === 'webm'
                  ? 'Playing MKV files on iPhone/iPad needs iOS 17.1 or later. Update iOS, pick an MP4 release (YTS results are MP4), or use the free online player.'
                  : `This release is a .${ext} file, which this browser can’t play. Pick an MP4 or MKV release, or use the free online player.`,
              );
            }
            setCloudStats(res.stats);
            setSource({ url: api.streamUrl(res.path), engine, fileName: res.fileName, mime: res.mime, remux });
            return;
          }
          const s = res.stats;
          setStatus(s.peers ? `Connected to ${s.peers} peer${s.peers > 1 ? 's' : ''}, reading the file list…` : `Finding peers… (${s.candidates + s.peersTried} found, ${s.trackersOk} tracker${s.trackersOk === 1 ? '' : 's'} answered)`);
          if (Date.now() > deadline) {
            throw new Error(`Couldn’t reach any peers for this torrent through your relay (${s.trackersOk} trackers answered, ${s.peersTried} peers tried${s.lastPeerError ? `, last: ${s.lastPeerError}` : s.lastTrackerError ? `, last: ${s.lastTrackerError}` : ''}). Try a result with more seeders.`);
          }
          await sleep(1500, ac.signal);
        }
      }

      if (engine === 'webtor') {
        setSource({ url: r.magnet, engine, fileName: r.fileName ?? r.title });
        setPhase('ready');
        return;
      }

      if (engine === 'webtorrent') {
        setStatus('Connecting to WebRTC peers…');
        const session = await startWebTorrent(r.magnet, { fileIdx: r.fileIdx, season: req.season, episode: req.episode, onStats: setWtStats, signal: ac.signal });
        if (ac.signal.aborted) { session.destroy(); return; }
        wtRef.current = session;
        setSource({ url: session.url, engine, fileName: session.fileName });
        return;
      }

      setStatus(`Sending to ${settings.debridProvider}…`);
      for (let attempt = 0; attempt < 180; attempt++) {
        const res = await api.resolveDebrid(r, { season: req.season, episode: req.episode }, ac.signal);
        if (res.status === 'error') throw new Error(res.message ?? 'Debrid error');
        if (res.status === 'ready' && res.url) {
          // Real-Debrid's HLS version has AAC audio: use it on iPhone, for MKV the browser can't open, and when
          // the file's audio (Dolby / DTS) wouldn't play in this browser — otherwise the video plays in silence.
          const preferHls = !!res.hlsUrl && (isIOS() || (res.mimeType === 'video/x-matroska' && !canPlayMkv()) || !audioPlayable(r.audio));
          const mkv = res.mimeType === 'video/x-matroska' || /\.(mkv|webm)$/i.test(res.fileName ?? '');
          if (!preferHls && mkv && !canPlayMkv()) {
            // No iPhone-friendly (HLS) version from the Debrid service: convert the MKV in the page instead.
            if (!mkvRemuxSupported()) throw new Error('This release is an MKV file. Playing MKV on iPhone/iPad needs iOS 17.1 or later, or choose an MP4 release.');
            setSource({ url: res.url, alt: api.proxyUrl(res.url), engine, fileName: res.fileName, mime: 'video/x-matroska', remux: true });
            return;
          }
          setSource({
            url: preferHls ? res.hlsUrl! : res.url,
            alt: preferHls ? res.url : res.hlsUrl,
            engine,
            fileName: res.fileName,
            mime: preferHls ? 'application/vnd.apple.mpegurl' : res.mimeType,
          });
          if (res.message) setStatus(res.message);
          return;
        }
        setProgress(res.progress);
        setStatus(res.message ?? 'Caching torrent on debrid…');
        await sleep(attempt < 5 ? 2000 : 5000, ac.signal);
      }
      throw new Error('Timed out waiting for the debrid service to cache this torrent.');
    })().catch((e) => {
      if (e?.name === 'AbortError') return;
      setError(e?.message ?? String(e));
      setPhase('error');
    });

    return () => {
      ac.abort();
      wtRef.current?.destroy();
      wtRef.current = null;
    };
  }, [req?.nonce, engineOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Exact-release subtitles: hash the playing file (two small range reads) ─────
  const hashKey = source ? `${req?.nonce}|${source.url.split('?')[0]}` : '';
  useEffect(() => {
    if (!source) { setPlayingFile({ ready: false }); return; }
    const name = source.fileName;
    const hlsOnly = isHlsUrl(source.url, source.mime) && (!source.alt || isHlsUrl(source.alt));
    if (source.engine === 'webtor' || hlsOnly) { setPlayingFile({ name, ready: true }); return; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 7000); // don't hold subtitles back for long
    hashRemoteVideo(readableUrls(source) ?? [], ac.signal)
      .then((h) => setPlayingFile({ name, hash: h?.hash, size: h?.size, ready: true }))
      .catch(() => setPlayingFile({ name, ready: true }))
      .finally(() => clearTimeout(timer));
    setPlayingFile({ name, ready: false });
    return () => { clearTimeout(timer); ac.abort(); };
  }, [hashKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The MKV converter shifts the media timeline; downloaded subtitles need the same shift.
  useEffect(() => { subs.setBaseShift(source?.remux ? TIMELINE_OFFSET_MS : 0); }, [source?.remux]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Automatic subtitle sync from the soundtrack ───────────────────────────
  const tapRef = useRef<AudioTap | null>(null);
  const [syncListening, setSyncListening] = useState(false);
  useEffect(() => {
    if (!videoEl) return;
    const tap = new AudioTap(videoEl);
    tapRef.current = tap;
    tap.start();
    return () => { tap.stop(); if (tapRef.current === tap) tapRef.current = null; };
  }, [videoEl]);
  useEffect(() => { tapRef.current?.reset(); }, [req?.nonce]);

  const syncState = useRef<Partial<Record<Lang, { track: string; last?: Alignment; applied?: Alignment }>>>({});
  useEffect(() => {
    if (!settings.subtitle.autoSync) return;
    const t = setInterval(() => {
      const tap = tapRef.current;
      setSyncListening(!!tap?.active);
      if (!tap?.active) return;
      for (const lang of LANGS) {
        const tr = subs.loaded[lang];
        if (!tr?.cues.length || tr.info.provider === 'embedded' || tr.info.provider === 'generated' || subs.manual.has(lang)) continue;
        const st = syncState.current[lang]?.track === tr.info.id ? syncState.current[lang]! : (syncState.current[lang] = { track: tr.info.id });
        const base = subs.baseShiftMs;
        const center = (base + subs.offsets[lang]) / 1000;
        const a = alignSubtitles(tap.samples, tr.cues, { center: st.applied ? center : base / 1000, range: st.applied ? 3 : 20 });
        if (!confident(a)) continue;
        // Apply when two consecutive estimates agree; later, only move if a new estimate is stable and differs.
        if (st.last && agrees(a!, st.last) && (!st.applied || (a!.scale === st.applied.scale && Math.abs(a!.offset - st.applied.offset) > 0.35))) {
          st.applied = a;
          subs.applyAutoSync(lang, a!.offset * 1000 - base, a!.scale);
        }
        st.last = a;
      }
    }, 15000);
    return () => clearInterval(t);
  }, [settings.subtitle.autoSync, subs]);
  useEffect(() => { syncState.current = {}; }, [req?.nonce]);

  // Up-front sync: fit subtitles to audio sampled from across the file, before the viewer needs them.
  const presyncUrls = source ? readableUrls(source) : undefined;
  usePresync({
    playKey: source ? `${req?.nonce}|${source.url}` : '',
    urls: presyncUrls,
    enabled: settings.subtitle.autoSync,
    ai: !!caps?.ai,
    subsRef,
    getTime: () => videoRef.current?.currentTime ?? 0,
    onApplied: (lang, a) => {
      const applied: Alignment = { offset: a.offset, scale: a.scale, z: 99, ratio: 99, seconds: 0 };
      syncState.current[lang] = { track: a.track, applied, last: undefined };
    },
  });

  // ── Subtitles from speech (no subtitles anywhere, or asked for) ───────────
  const genRef = useRef<SubtitleGenerator | null>(null);
  const [genStatus, setGenStatus] = useState<GeneratorStatus>();
  const [genWanted, setGenWanted] = useState(false);
  useEffect(() => { setGenWanted(false); setGenStatus(undefined); }, [req?.nonce]);
  const genUrls = source ? readableUrls(source) : undefined;
  const genReason = !caps?.ai
    ? apiBase() ? 'Your relay needs one update for this: open it in Cloudflare → Deployments and redeploy the latest version.' : 'This needs your own relay (Settings → Relay).'
    : source && !genUrls ? 'Not available for this kind of stream.' : undefined;
  const noSubs = subs.searched && !subs.tracks.some((t) => t.provider !== 'generated');
  const runGen = !genReason && !!source && phase === 'ready' && (genWanted || (settings.subtitle.autoGenerate && noSubs));
  const genKey = `${req?.nonce}|${source?.url ?? ''}`;
  useEffect(() => {
    if (!runGen || !genUrls) return;
    const ac = new AbortController();
    let gen: SubtitleGenerator | undefined;
    setGenStatus({ state: 'working', readyUntil: 0 });
    openAudioSource(genUrls, ac.signal)
      .then((src) => {
        if (ac.signal.aborted) return;
        gen = new SubtitleGenerator(src, (a, o, sig) => api.transcribe(a, o, sig), (lang, cues) => subsRef.current?.addGenerated(lang, cues), setGenStatus);
        genRef.current = gen;
        gen.setTime(videoRef.current?.currentTime ?? 0);
      })
      .catch((e) => { if (e.name !== 'AbortError') setGenStatus({ state: 'error', message: e.message }); });
    return () => { ac.abort(); gen?.stop(); genRef.current = null; };
  }, [runGen, genKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const generate: GenerateControl = { available: !genReason, reason: genReason, status: genStatus, running: runGen, start: () => setGenWanted(true) };

  // ── Cloud streaming keep-alive: each ping refills the relay's connection budget and reports speed ──
  const cloudHash = source?.engine === 'cloud' ? req?.result?.infoHash : undefined;
  useEffect(() => {
    if (!cloudHash) { setCloudStats(undefined); return; }
    const ac = new AbortController();
    const t = setInterval(() => {
      api.streamStatus(cloudHash, ac.signal).then(setCloudStats).catch(() => undefined);
    }, 4000);
    return () => { clearInterval(t); ac.abort(); };
  }, [cloudHash]);

  // ── Attach source to <video> (native / hls.js / progressive) ───────────────
  useEffect(() => {
    const video = videoRef.current;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    mkvRef.current?.destroy();
    mkvRef.current = null;
    if (!video || !source || source.engine === 'webtor') {
      if (video) { video.removeAttribute('src'); video.load(); }
      return;
    }
    let cancelled = false;
    (async () => {
      if (source.remux) {
        const player = new MkvMsePlayer(video, source.url, {
          audioLanguages: ['en', 'ar', 'ja'],
          fallbackUrl: source.alt,
          onError: (m) => { setError(m); setPhase('error'); },
          onSubtitle: (lang, label, cue) => subsRef.current?.addEmbedded(lang, label, cue),
          onTracks: (t) => setStatus(`Converting MKV · ${t.video}${t.audio ? ` + ${t.audio}` : ''}`),
        });
        mkvRef.current = player;
        await player.start();
        if (cancelled) return;
      } else if (isHlsUrl(source.url, source.mime) && !video.canPlayType('application/vnd.apple.mpegurl')) {
        const { default: HlsCtor } = await import('hls.js');
        if (cancelled) return;
        if (!HlsCtor.isSupported()) throw new Error('HLS is not supported in this browser.');
        const hls = new HlsCtor({ enableWorker: true, maxBufferLength: 60 });
        hls.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (data.fatal) { setError(`HLS error: ${data.details}`); setPhase('error'); }
        });
        hls.loadSource(source.url);
        hls.attachMedia(video);
        hlsRef.current = hls;
      } else {
        // Load with CORS when possible so auto-sync can analyse the audio; hosts that refuse
        // get a plain retry (see the error handler).
        if (source.cors === false) video.removeAttribute('crossorigin');
        else video.crossOrigin = 'anonymous';
        video.src = source.url;
      }
      setPhase('ready');
      video.play().catch(() => setControls(true)); // autoplay may be blocked; big play button stays visible
    })().catch((e) => { setError(e.message); setPhase('error'); });
    return () => { cancelled = true; };
  }, [source]);

  useEffect(() => () => { hlsRef.current?.destroy(); wtRef.current?.destroy(); mkvRef.current?.destroy(); }, []);

  // ── Media element events ──────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let lastSave = 0;
    const on = (ev: string, fn: () => void) => { v.addEventListener(ev, fn); return () => v.removeEventListener(ev, fn); };
    const offs = [
      on('play', () => { setPlaying(true); nativeTV()?.setKeepScreenOn(true); }),
      on('pause', () => { setPlaying(false); nativeTV()?.setKeepScreenOn(false); }),
      on('waiting', () => setWaiting(true)),
      on('playing', () => setWaiting(false)),
      on('canplay', () => setWaiting(false)),
      on('volumechange', () => { setVolume(v.volume); setMuted(v.muted); }),
      on('durationchange', () => setDuration(v.duration)),
      on('loadedmetadata', () => {
        setDuration(v.duration);
        if (!resumeId) return;
        try {
          const saved = Number(localStorage.getItem(resumeKey(resumeId)));
          if (saved > 30 && saved < v.duration - 60) v.currentTime = saved;
        } catch { /* storage blocked */ }
      }),
      on('timeupdate', () => {
        setTime(v.currentTime);
        genRef.current?.setTime(v.currentTime);
        setSubtitlePlayhead(v.currentTime);
        if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        if (resumeId && Math.abs(v.currentTime - lastSave) > 5) {
          lastSave = v.currentTime;
          try { localStorage.setItem(resumeKey(resumeId), String(Math.floor(v.currentTime))); } catch { /* ignore */ }
        }
      }),
      on('error', () => {
        const code = v.error?.code;
        if (!v.currentSrc && !hlsRef.current) return;
        // Maybe the host just refused the CORS load: retry plainly (the sound must never depend on auto-sync).
        if (source && source.cors !== false && !source.remux && !hlsRef.current && v.crossOrigin === 'anonymous' && !v.currentSrc.startsWith('blob:')) {
          if (isTapped(v)) setVideoKey((k) => k + 1); // a fresh element: the old one's audio is routed through Web Audio
          setSource({ ...source, cors: false });
          return;
        }
        if (source?.alt && v.currentSrc !== source.alt) {
          setStatus('Primary stream failed, trying alternate…');
          setSource({ ...source, url: source.alt, alt: undefined, mime: isHlsUrl(source.alt) ? 'application/vnd.apple.mpegurl' : undefined });
          return;
        }
        // The browser claimed it could open this MKV but couldn't: convert it instead.
        const isMkv = /\.(mkv|webm)$/i.test(source?.fileName ?? '') || source?.mime === 'video/x-matroska';
        if (source && isMkv && !source.remux && (source.engine === 'cloud' || source.engine === 'direct' || source.engine === 'debrid') && mkvRemuxSupported()) {
          setStatus('Converting MKV for this browser…');
          const viaRelay = source.engine !== 'cloud' && !source.url.includes('/api/proxy') ? api.proxyUrl(source.url) : undefined;
          // Try the link itself first; the relay copy is the fallback if the host won't share it with this page.
          setSource({ ...source, alt: viaRelay, remux: true });
          return;
        }
        setError(
          code === 4
            ? 'This browser cannot decode this file (container/codec). On iPhone/iPad choose an MP4 / H.264 release, or a Real-Debrid stream with HLS transcoding.'
            : `Playback error (${v.error?.message || code}).`,
        );
        setPhase('error');
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [resumeId, source]);

  // ── Silent video: the browser plays the picture but can't decode the audio (Dolby/DTS in Chrome/Firefox) ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !source || phase !== 'ready' || source.remux || isHlsUrl(source.url, source.mime)) return;
    const t = setInterval(() => {
      if (v.paused || v.currentTime < 3 || v.readyState < 3) return;
      const x = v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; mozHasAudio?: boolean; webkitVideoDecodedByteCount?: number };
      const silent = x.webkitAudioDecodedByteCount !== undefined ? x.webkitAudioDecodedByteCount === 0 && (x.webkitVideoDecodedByteCount ?? 1) > 0
        : x.mozHasAudio !== undefined ? !x.mozHasAudio : false;
      clearInterval(t);
      if (!silent) return;
      if (source.alt && isHlsUrl(source.alt)) {
        // Same video from the Debrid service, transcoded with AAC audio: continue from here.
        try { if (resumeId) localStorage.setItem(resumeKey(resumeId), String(Math.floor(v.currentTime))); } catch { /* ignore */ }
        setStatus('This file’s audio doesn’t play in this browser; switching to a version that does…');
        setSource({ ...source, url: source.alt, alt: source.url, mime: 'application/vnd.apple.mpegurl' });
      } else {
        setNotice('No sound: this file’s audio (Dolby or DTS) doesn’t play in this browser. Pick a release with AAC audio, or use Safari or the iPhone app.');
      }
    }, 1500);
    return () => clearInterval(t);
  }, [source, phase, resumeId]);

  // ── Fullscreen ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onFs = () => setFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => { document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs); };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as any;
    const v = videoRef.current as any;
    const doc = document as any;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
      return;
    }
    // iPhone has no element fullscreen: only the <video> itself can go fullscreen (system player,
    // where the native <track> subtitle fallback takes over). It must be called synchronously in
    // the tap handler — after a rejected requestFullscreen() promise the tap no longer counts.
    const elementFs = (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled) && !/iPhone|iPod/.test(navigator.userAgent);
    if (!elementFs && v?.webkitEnterFullscreen) {
      if (v.readyState >= 1) v.webkitEnterFullscreen();
      return;
    }
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => undefined);
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (v?.readyState >= 1) v?.webkitEnterFullscreen?.();
  }, []);

  // ── Native text-track fallback (iPhone system fullscreen / AirPlay) ───────
  const nativeTracks = useMemo(() => {
    const out: { lang: string; url: string }[] = [];
    for (const lang of LANGS) {
      const t = subs.loaded[lang];
      const { shiftMs, scale } = subs.timing(lang);
      if (t?.cues.length) out.push({ lang, url: URL.createObjectURL(new Blob([toVtt(t.cues, shiftMs / 1000, lang === 'ar', scale)], { type: 'text/vtt' })) });
    }
    return out;
  }, [subs.loaded, subs.timing]);
  useEffect(() => () => nativeTracks.forEach((t) => URL.revokeObjectURL(t.url)), [nativeTracks]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const setMode = (native: boolean) => {
      for (const tt of Array.from(v.textTracks)) {
        tt.mode = native && !subsHidden && tt.language === settings.subtitle.primaryLang ? 'showing' : 'hidden';
      }
    };
    setMode(false);
    const begin = () => setMode(true);
    const end = () => setMode(false);
    v.addEventListener('webkitbeginfullscreen', begin);
    v.addEventListener('webkitendfullscreen', end);
    return () => { v.removeEventListener('webkitbeginfullscreen', begin); v.removeEventListener('webkitendfullscreen', end); };
  }, [nativeTracks, settings.subtitle.primaryLang, subsHidden]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const showFlash = (side: 'left' | 'right' | 'center', label: string) => setFlash({ side, label, key: Date.now() });
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !source) return;
    unlockAudio(); // user gesture: lets auto-sync listen to the audio
    if (v.paused) v.play().catch(() => undefined); else v.pause();
  }, [source]);
  const seekBy = useCallback((d: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + d));
    showFlash(d < 0 ? 'left' : 'right', `${d > 0 ? '+' : ''}${d}s`);
  }, []);
  const setVol = (val: number) => { const v = videoRef.current; if (v) { v.volume = Math.max(0, Math.min(1, val)); v.muted = v.volume === 0; } };
  const togglePip = async () => {
    const v = videoRef.current as any;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v?.requestPictureInPicture) await v.requestPictureInPicture();
      else v?.webkitSetPresentationMode?.(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch { /* not allowed */ }
  };

  // Auto-hide controls
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const poke = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (videoRef.current && !videoRef.current.paused) setControls(false); }, 3000);
  }, []);
  useEffect(() => { if (!playing) setControls(true); else poke(); }, [playing, poke]);

  // ── Android TV: remote keys, Back, and the TV's own player for files the WebView can't decode ──
  const tv = useMemo(() => isTV(), []);
  useEffect(() => {
    if (!tv) return;
    setTvKeyOverride((e) => {
      if (useApp.getState().view !== 'player' || phase !== 'ready' || panel) return false;
      const k = e.key;
      if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') { togglePlay(); poke(); return true; }
      if (k === 'MediaFastForward') { seekBy(30); poke(); return true; }
      if (k === 'MediaRewind') { seekBy(-30); poke(); return true; }
      const el = document.activeElement as HTMLElement | null;
      const free = !el || el === document.body || !containerRef.current?.contains(el);
      if (!free) {
        poke();
        // The seek bar's own arrow step is 0.1 s: on the remote, jump 10 s instead.
        if (el?.matches('input[aria-label="Seek"]') && (k === 'ArrowLeft' || k === 'ArrowRight')) { seekBy(k === 'ArrowLeft' ? -10 : 10); return true; }
        if (k === 'ArrowUp' && !moveFocus('up')) { el!.blur(); return true; }
        return false;
      }
      if (k === 'ArrowLeft') { seekBy(-10); poke(); return true; }
      if (k === 'ArrowRight') { seekBy(10); poke(); return true; }
      if (k === 'Enter' || k === ' ') { togglePlay(); poke(); return true; }
      if (k === 'ArrowUp') { poke(); return true; }
      if (k === 'ArrowDown') {
        poke();
        setTimeout(() => (containerRef.current?.querySelector('[data-tv-controls] button') as HTMLElement | null)?.focus(), 40);
        return true;
      }
      return false;
    });
    return () => setTvKeyOverride(undefined);
  }, [tv, phase, panel, togglePlay, seekBy, poke]);

  useEffect(() => onTvBack(() => {
    if (useApp.getState().view !== 'player') return false;
    if (panel) { setPanel(false); return true; }
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && containerRef.current?.contains(el)) { el.blur(); setControls(false); return true; }
    return false;
  }), [panel]);

  // Subtitle sheet opened from the remote: start on its first control.
  useEffect(() => {
    if (!tv || !panel) return;
    const t = setTimeout(() => (containerRef.current?.querySelector('[role="dialog"] button, [role="dialog"] select') as HTMLElement | null)?.focus(), 60);
    return () => clearTimeout(t);
  }, [tv, panel]);

  const nativeTried = useRef('');
  const playInTvPlayer = useCallback(async () => {
    const bridge = nativeTV();
    const v = videoRef.current;
    if (!bridge || !source || !req) return;
    nativeTried.current = `${req.nonce}|${source.url}`;
    v?.pause();
    setPhase('native');
    setStatus('Opening in the TV player…');
    // Give subtitles a moment to load and sync, so they travel with the video.
    for (let i = 0; i < 20; i++) {
      const s = subsRef.current;
      if (s?.searched && !LANGS.some((l) => s.syncPhase[l] === 'checking')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const s = subsRef.current;
    const timelineShift = source.remux ? TIMELINE_OFFSET_MS : 0; // the TV player uses the file's own timeline
    const subtitles = s ? LANGS.flatMap((l) => {
      const t = s.loaded[l];
      if (!t?.cues.length) return [];
      const { shiftMs, scale } = s.timing(l);
      return [{ lang: l, label: l === 'ar' ? 'العربية' : 'English', vtt: toVtt(t.cues, (shiftMs - timelineShift) / 1000, false, scale), primary: l === settings.subtitle.primaryLang }];
    }) : [];
    let position = v && v.currentTime > 1 ? v.currentTime - timelineShift / 1000 : 0;
    if (!position && resumeId) { try { position = Number(localStorage.getItem(resumeKey(resumeId))) || 0; } catch { /* ignore */ } }
    bridge.playNative(JSON.stringify({ url: source.url, title: `${req.title}${req.season != null ? ` · S${req.season} E${req.episode}` : ''}`, position, subtitles }));
  }, [source, req, settings.subtitle.primaryLang, resumeId]);

  // The WebView couldn't play this file: hand it to the TV's player automatically (once).
  useEffect(() => {
    if (!tv || phase !== 'error' || !source || !req || source.engine === 'webtor' || !nativeTV()) return;
    if (nativeTried.current === `${req.nonce}|${source.url}`) return;
    void playInTvPlayer();
  }, [tv, phase, source, req, playInTvPlayer]);

  useEffect(() => {
    if (!tv) return;
    (window as unknown as { __tvNativeClosed?: (pos: number) => void }).__tvNativeClosed = (pos: number) => {
      if (resumeId && pos > 0) { try { localStorage.setItem(resumeKey(resumeId), String(Math.floor(pos))); } catch { /* ignore */ } }
      const st = useApp.getState();
      if (st.view === 'player') st.setView(st.listView);
    };
  }, [tv, resumeId]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!source || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const v = videoRef.current;
      if (!v) return;
      const k = e.key;
      const handled = () => { e.preventDefault(); poke(); };
      if (k === ' ' || k === 'k' || k === 'K') { handled(); togglePlay(); }
      else if (k === 'f' || k === 'F') { handled(); toggleFullscreen(); }
      else if (k === 'ArrowLeft') { handled(); seekBy(e.shiftKey ? -30 : -10); }
      else if (k === 'ArrowRight') { handled(); seekBy(e.shiftKey ? 30 : 10); }
      else if (k === 'ArrowUp') { handled(); setVol(v.volume + 0.1); showFlash('center', `${Math.round(Math.min(1, v.volume + 0.1) * 100)}%`); }
      else if (k === 'ArrowDown') { handled(); setVol(v.volume - 0.1); showFlash('center', `${Math.round(Math.max(0, v.volume - 0.1) * 100)}%`); }
      else if (k === 'm' || k === 'M') { handled(); v.muted = !v.muted; }
      else if (k === 'c' || k === 'C') { handled(); setSubsHidden((h) => !h); }
      else if (k === 'p' || k === 'P') { handled(); togglePip(); }
      else if (k === '[' || k === ']') {
        handled();
        const lang = settings.subtitle.primaryLang;
        const next = subs.offsets[lang] + (k === '[' ? -100 : 100);
        subs.setOffset(lang, next);
        showFlash('center', `${lang.toUpperCase()} ${next > 0 ? '+' : ''}${next} ms`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, togglePlay, toggleFullscreen, seekBy, poke, settings.subtitle.primaryLang, subs]);

  // ── Touch / pointer gestures ──────────────────────────────────────────────
  const gesture = useRef<{ x0: number; t0: number; time0: number; moved: boolean; type: string } | null>(null);
  const lastTap = useRef<{ at: number; x: number } | null>(null);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onPointerDown = (e: React.PointerEvent) => {
    gesture.current = { x0: e.clientX, t0: Date.now(), time0: videoRef.current?.currentTime ?? 0, moved: false, type: e.pointerType };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.type === 'mouse') { if (e.pointerType === 'mouse') poke(); return; }
    const dx = e.clientX - g.x0;
    if (Math.abs(dx) > 24) {
      g.moved = true;
      const width = containerRef.current?.clientWidth ?? 1;
      const target = Math.max(0, Math.min(duration || 0, g.time0 + (dx / width) * Math.min(180, duration || 180)));
      setScrub(target);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.moved && scrub != null) {
      if (videoRef.current) videoRef.current.currentTime = scrub;
      setScrub(undefined);
      return;
    }
    const rect = containerRef.current!.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    const now = Date.now();
    const isDouble = !!lastTap.current && now - lastTap.current.at < 300;
    if (isDouble) {
      clearTimeout(singleTapTimer.current);
      lastTap.current = null;
      if (g.type === 'mouse') toggleFullscreen(); // desktop: double-click = fullscreen
      else if (rel < 0.35) seekBy(-10); // touch: double-tap sides = seek
      else if (rel > 0.65) seekBy(10);
      else togglePlay();
      return;
    }
    lastTap.current = { at: now, x: e.clientX };
    singleTapTimer.current = setTimeout(() => {
      lastTap.current = null;
      if (g.type === 'mouse') { togglePlay(); poke(); return; } // desktop: click = play/pause
      setControls((c) => !c); // touch: tap = show/hide controls
      if (!controls) poke();
    }, 260);
  };

  // ── Media Session (lock screen / headphones) ──────────────────────────────
  useEffect(() => {
    if (!req || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: req.title, artist: req.season != null ? `S${req.season}E${req.episode ?? ''}` : undefined });
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10));
    navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10));
  }, [req, seekBy]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (source?.engine === 'webtor' && req && phase !== 'error') {
    // Subtitle download links (via the user's own relay), for uploading into webtor's player if needed.
    const base = apiBase();
    const subLinks = base && !settings.accessToken
      ? LANGS.flatMap((l) => {
          const t = subs.loaded[l]?.info;
          return t?.token ? [{ lang: l, href: `${base}/api/subtitles/file?format=vtt${l === 'ar' ? '&rtl=1' : ''}&token=${encodeURIComponent(t.token)}` }] : [];
        })
      : [];
    return (
      <div className="relative w-full">
        <div className="relative grid aspect-video w-full place-items-center overflow-hidden bg-gradient-to-b from-ink-900 to-black p-6 text-center md:rounded-xl">
          <div className="max-w-sm space-y-4">
            <p className="text-sm text-ink-200">Ready to play with the free online player.</p>
            <a href={webtorUrl(source.url)} target="_blank" rel="noopener noreferrer" className="btn-primary px-6 py-3 text-base">
              ▶ Play free on webtor.io
            </a>
            {req.result?.quality === '4K' && (
              <p className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
                webtor’s free plan streams at up to 5 Mbit/s, which is too slow for 4K. Go back and pick a 1080p or 720p result for smooth playback.
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-ink-400">
              Opens webtor.io in a new tab. Their servers fetch the torrent, so it may take a minute to start.
            </p>
          </div>
        </div>
        <div className="space-y-2 px-3 py-2 text-[11px] text-ink-400 md:px-0">
          <div className="flex flex-wrap items-center gap-2">
            {onBack && <button className="btn-ghost -ml-1 px-2 py-1 text-xs md:hidden" onClick={onBack}>← Results</button>}
            {req.kind === 'torrent' && hasDebrid(settings, caps) && (
              <button className="btn-ghost border border-ink-600 px-2 py-1 text-xs" onClick={() => setEngineOverride('debrid')}>Use Debrid instead</button>
            )}
          </div>
          <p>Subtitles: in webtor’s player, tap the subtitles button. It can search OpenSubtitles itself.</p>
          {subLinks.length > 0 && (
            <p className="flex flex-wrap items-center gap-2">
              <span>Or save the app’s picks and upload them there:</span>
              {subLinks.map((s) => (
                <a key={s.lang} href={s.href} download={`${s.lang}.vtt`} target="_blank" rel="noopener noreferrer" className="pill border-ink-600 text-ink-200">
                  {s.lang === 'ar' ? 'العربية .vtt' : 'English .vtt'}
                </a>
              ))}
            </p>
          )}
        </div>
      </div>
    );
  }

  const showSubs = !subsHidden && LANGS.some((l) => subs.loaded[l]?.cues.length);
  const shownTime = scrub ?? time;
  const pad = (n?: number) => String(n ?? '').padStart(2, '0');
  const epTag = req?.season != null ? `S${pad(req.season)}E${pad(req.episode)}` : '';
  const engineName = !source ? undefined
    : source.engine === 'debrid' ? PROVIDER_NAMES[settings.debridProvider] ?? 'Debrid'
    : source.engine === 'cloud' ? 'Your relay (torrent)'
    : source.engine === 'direct' ? (source.url.includes('/api/proxy') ? 'Direct link, through your relay' : 'Direct link')
    : source.engine === 'webtorrent' ? 'WebTorrent' : 'webtor.io';
  const liveStats = source?.engine === 'cloud' && cloudStats
    ? `${cloudStats.peers} peer${cloudStats.peers === 1 ? '' : 's'} · ${formatBytes(cloudStats.downSpeed)}/s`
    : wtStats ? `${wtStats.numPeers} peers · ${formatBytes(wtStats.downloadSpeed)}/s · ${(wtStats.progress * 100).toFixed(1)}%` : undefined;

  const alternatives = req?.kind === 'torrent' ? [
    caps?.stream && source?.engine !== 'cloud' && engineOverride !== 'cloud' && engineUsed !== 'cloud' && { label: 'Stream through your relay', engine: 'cloud' as Engine },
    hasDebrid(settings, caps) && source?.engine !== 'debrid' && engineOverride !== 'debrid' && engineUsed !== 'debrid' && { label: `Use ${PROVIDER_NAMES[settings.debridProvider] ?? 'Debrid'}`, engine: 'debrid' as Engine },
    supportsWebTorrent() && source?.engine !== 'webtorrent' && { label: 'Try WebTorrent', engine: 'webtorrent' as Engine },
    engineOverride !== 'webtor' && { label: 'Free online player (webtor.io)', engine: 'webtor' as Engine },
  ].filter(Boolean) as { label: string; engine: Engine }[] : [];

  const onCC = () => {
    if (fullscreen || tv) { setPanel((p) => !p); return; }
    setSubsHidden((h) => { showFlash('center', h ? 'Subtitles on' : 'Subtitles off'); return !h; });
  };

  return (
    <div className="player-shell mx-auto max-w-[1700px] lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-8 lg:p-8" data-active={!!req}>
      <div
        ref={containerRef}
        className="player relative aspect-video w-full select-none overflow-hidden bg-black lg:rounded-2xl [&:fullscreen]:aspect-auto [&:fullscreen]:rounded-none"
        data-controls={controls && phase === 'ready'}
        data-tv-layer={tv && view === 'player' ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { gesture.current = null; setScrub(undefined); }}
        onMouseLeave={() => playing && setControls(false)}
        style={{ touchAction: 'pan-y' }}
      >
        <video
          key={videoKey}
          ref={(el) => { (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el; setVideoEl(el); }}
          className="absolute inset-0 h-full w-full"
          playsInline
          preload="auto"
          webkit-playsinline="true"
          x-webkit-airplay="allow"
        >
          {nativeTracks.map((t) => (
            <track key={t.url} kind="subtitles" srcLang={t.lang} label={t.lang === 'ar' ? 'العربية' : 'English'} src={t.url} />
          ))}
        </video>

        {showSubs && <SubtitleOverlay video={videoEl} subs={subs} />}

        {/* Idle / resolving / error */}
        {phase !== 'ready' && (
          <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-gradient-to-b from-ink-900 to-black px-6 pb-4 pt-12 text-center" onPointerUp={(e) => e.stopPropagation()}>
            {phase === 'idle' && (
              <div className="max-w-sm space-y-2 text-ink-400">
                <IconPlay size={36} className="mx-auto text-ink-600" />
                <p className="text-sm">Pick something to watch and it plays here.</p>
                <p className="hidden text-xs md:block"><kbd>⌘/Ctrl K</kbd> search torrents · <kbd>Space</kbd> pause · <kbd>F</kbd> fullscreen</p>
              </div>
            )}
            {phase === 'resolving' && (
              <div className="w-full max-w-xs space-y-3">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
                <p className="text-sm text-ink-200">{status}</p>
                {progress != null && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-700"><div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} /></div>
                )}
              </div>
            )}
            {phase === 'native' && (
              <div className="max-w-sm space-y-3">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
                <p className="text-sm text-ink-200">{status || 'Playing in the TV player'}</p>
              </div>
            )}
            {phase === 'error' && (
              <div className="max-w-md space-y-3">
                <p className="text-sm text-red-300">{error}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {alternatives.slice(0, 2).map((a) => <button key={a.engine} className="btn-ghost bg-white/10" onClick={() => setEngineOverride(a.engine)}>{a.label}</button>)}
                  {onBack && <button className="btn-ghost bg-white/10" onClick={onBack}>Back</button>}
                </div>
              </div>
            )}
          </div>
        )}

        {notice && phase === 'ready' && (
          <div className="absolute inset-x-3 top-14 z-10 flex items-start gap-3 rounded-xl bg-black/80 p-3 text-sm text-white backdrop-blur" onPointerUp={(e) => e.stopPropagation()}>
            <p className="flex-1">{notice}</p>
            <button className="btn-ghost -m-1 px-2 py-1 text-xs" onClick={() => setNotice(undefined)}>OK</button>
          </div>
        )}

        {phase === 'ready' && waiting && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}

        {/* Centre controls: touch = back 10 / play / forward 10; mouse = play when paused */}
        {phase === 'ready' && !waiting && (
          <div className={`absolute inset-0 hidden items-center justify-center gap-10 bg-black/25 transition-opacity [@media(pointer:coarse)]:flex ${controls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
            <button className="grid h-12 w-12 place-items-center rounded-full bg-black/40 text-white backdrop-blur" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); seekBy(-10); poke(); }} aria-label="Back 10 seconds"><IconBack10 size={24} /></button>
            <button className="grid h-16 w-16 place-items-center rounded-full bg-black/50 text-white backdrop-blur" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); togglePlay(); poke(); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <IconPause size={30} /> : <IconPlay size={30} />}</button>
            <button className="grid h-12 w-12 place-items-center rounded-full bg-black/40 text-white backdrop-blur" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); seekBy(10); poke(); }} aria-label="Forward 10 seconds"><IconFwd10 size={24} /></button>
          </div>
        )}
        {phase === 'ready' && !playing && !waiting && (
          <button className="tv-grid absolute left-1/2 top-1/2 hidden h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white backdrop-blur [@media(pointer:fine)]:grid" onPointerUp={(e) => { e.stopPropagation(); togglePlay(); }} aria-label="Play">
            <IconPlay size={28} />
          </button>
        )}

        {flash && (
          <div key={flash.key} className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${flash.side === 'left' ? 'left-[12%]' : flash.side === 'right' ? 'right-[12%]' : 'left-1/2 -translate-x-1/2'}`}>
            <div className="animate-ripple whitespace-nowrap rounded-full bg-black/60 px-4 py-2.5 text-sm font-semibold text-white">{flash.label}</div>
          </div>
        )}

        {scrub != null && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-4 py-2 text-lg font-semibold tabular-nums text-white">
            {fmtTime(scrub)} / {fmtTime(duration)}
          </div>
        )}

        {/* Top bar: back (phone) · title in fullscreen */}
        {req && (
          <div className={`absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 pb-6 pt-[max(0.5rem,env(safe-area-inset-top))] transition-opacity ${controls || phase !== 'ready' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            onPointerUp={(e) => e.stopPropagation()}>
            {onBack && <button className="player-back grid h-9 w-9 place-items-center rounded-full text-white" onClick={onBack} aria-label="Back"><IconBack size={22} /></button>}
            <p className="player-title hidden min-w-0 flex-1 truncate px-1 text-sm font-semibold text-white">{req.title}{epTag ? ` · ${epTag}` : ''}</p>
          </div>
        )}

        {/* Bottom controls */}
        {phase === 'ready' && (
          <div data-tv-controls className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-6 transition-opacity ${controls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); poke(); }}>
            <div className="flex items-center gap-1 text-white">
              <button className="tv-flex btn-ghost hidden p-2 text-white [@media(pointer:fine)]:inline-flex" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <IconPause size={20} /> : <IconPlay size={20} />}</button>
              <span className="px-1 text-xs tabular-nums text-white/90">{fmtTime(shownTime)} <span className="text-white/50">/ {fmtTime(duration)}</span></span>
              <div className="flex-1" />
              <div className="group hidden items-center lg:flex">
                <button className="btn-ghost p-2 text-white" onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <IconMute size={18} /> : <IconVolume size={18} />}</button>
                <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => setVol(+e.target.value)} className="w-0 opacity-0 transition-all group-hover:w-20 group-hover:opacity-100 focus:w-20 focus:opacity-100" aria-label="Volume" />
              </div>
              <button className={`btn-ghost p-2 ${subsHidden ? 'text-white/40' : 'text-white'}`} onClick={onCC} aria-label={fullscreen || tv ? 'Subtitle settings' : subsHidden ? 'Show subtitles' : 'Hide subtitles'} aria-pressed={!subsHidden}>
                <IconCC size={20} />
              </button>
              {tv ? (
                nativeTV() && <button className="btn-ghost px-2.5 py-1.5 text-xs font-semibold text-white" onClick={() => void playInTvPlayer()}>TV player</button>
              ) : (
                <button className="btn-ghost hidden p-2 text-white sm:inline-flex" onClick={togglePip} aria-label="Picture in picture"><IconPip size={18} /></button>
              )}
              {!tv && <button className="btn-ghost p-2 text-white" onClick={toggleFullscreen} aria-label="Fullscreen">{fullscreen ? <IconShrink size={20} /> : <IconExpand size={20} />}</button>}
            </div>
            <div className="relative h-5">
              <div className="absolute inset-x-1 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25">
                <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
                <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${duration ? (shownTime / duration) * 100 : 0}%` }} />
              </div>
              <input type="range" aria-label="Seek" min={0} max={duration || 0} step={0.1} value={shownTime}
                onChange={(e) => { const v = videoRef.current; if (v) v.currentTime = +e.target.value; }}
                className="seek absolute inset-0 h-5 w-full cursor-pointer appearance-none bg-transparent" />
            </div>
          </div>
        )}

        {/* Subtitle sheet (fullscreen only: otherwise the settings sit under the video) */}
        {panel && (fullscreen || tv) && (
          <div role="dialog" aria-label="Subtitles" className="absolute inset-y-0 right-0 z-20 w-full max-w-sm overflow-y-auto bg-ink-950/95 p-4 backdrop-blur scrollbar-thin"
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
            <SubtitleSettings subs={subs} hidden={subsHidden} onHiddenChange={setSubsHidden} listening={syncListening} generate={generate} onClose={() => setPanel(false)} />
          </div>
        )}
      </div>

      {req && (
        <div className="player-details mx-auto w-full max-w-2xl space-y-6 px-5 pb-10 pt-4 lg:px-0 lg:pt-0">
          <div className="space-y-1.5">
            <h1 className="text-lg font-semibold leading-snug text-white" dir="auto">{req.title}</h1>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-400">
              {epTag && <span className="font-medium text-ink-200">{epTag}</span>}
              {req.result?.quality && req.result.quality !== 'Unknown' && <span className="rounded bg-ink-800 px-1.5 py-0.5 text-xs font-semibold text-ink-200">{req.result.quality}</span>}
              <span>{[req.result?.sizeBytes ? formatBytes(req.result.sizeBytes) : '', engineName].filter(Boolean).join(' · ')}</span>
              {liveStats && <span className="text-hd">{liveStats}</span>}
            </p>
          </div>

          <SubtitleSettings subs={subs} hidden={subsHidden} onHiddenChange={setSubsHidden} listening={syncListening} generate={generate} />

          <StreamInfo req={req} source={source} engineName={engineName} alternatives={alternatives} onEngine={setEngineOverride} />
        </div>
      )}
    </div>
  );
}

function StreamInfo({ req, source, engineName, alternatives, onEngine }: {
  req: NonNullable<ReturnType<typeof useApp.getState>['nowPlaying']>;
  source?: Source;
  engineName?: string;
  alternatives: { label: string; engine: Engine }[];
  onEngine: (e: Engine) => void;
}) {
  const [copied, setCopied] = useState(false);
  const r = req.result;
  const link = req.url ?? r?.magnet;
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* denied */ }
  };
  return (
    <section>
      <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Stream</h3>
      <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 text-sm ring-1 ring-white/[0.06]">
        {engineName && (
          <div className="flex justify-between gap-4 px-4 py-3"><span className="text-ink-400">Playing via</span><span className="text-right text-ink-200">{engineName}{source?.remux ? ' · MKV converted' : ''}</span></div>
        )}
        {(source?.fileName || r?.title) && (
          <div className="space-y-0.5 px-4 py-3"><span className="text-ink-400">File</span><p className="break-all text-xs text-ink-200">{source?.fileName ?? r?.title}</p></div>
        )}
        {r && (r.seeders > 0 || r.tracker || r.releaseGroup) && (
          <div className="flex justify-between gap-4 px-4 py-3"><span className="text-ink-400">Release</span>
            <span className="text-right text-ink-200">{[r.seeders ? `${r.seeders} seeders` : '', r.tracker, r.releaseGroup].filter(Boolean).join(' · ')}</span></div>
        )}
        {link && (
          <button className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-ink-800/60" onClick={copy}>
            <span className="text-ink-200">{req.url ? 'Copy link' : 'Copy magnet link'}</span>
            {copied ? <span className="text-xs text-hd">Copied</span> : <IconCopy size={16} className="text-ink-400" />}
          </button>
        )}
      </div>
      {alternatives.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {alternatives.map((a) => <button key={a.engine} className="btn-ghost bg-ink-800 text-xs" onClick={() => onEngine(a.engine)}>{a.label}</button>)}
        </div>
      )}
    </section>
  );
}
