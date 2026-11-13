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
import { canPlayMkv, isHlsUrl, isIOS, supportsWebTorrent } from '@/lib/platform';
import { formatBytes } from '@/lib/release-parser';
import { hasDebrid, useApp } from '@/lib/store';
import { toVtt } from '@/lib/subtitle-parser';
import { startWebTorrent, type WebTorrentSession, type WebTorrentStats } from '@/lib/webtorrent-engine';
import { IconBack, IconCC, IconExpand, IconMute, IconPause, IconPip, IconPlay, IconShrink, IconVolume } from './icons';
import { LANGS, SubtitleOverlay, SubtitlePanel, useSubtitles } from './subtitles';


type Engine = 'debrid' | 'cloud' | 'webtorrent' | 'webtor' | 'direct';
type Phase = 'idle' | 'resolving' | 'ready' | 'error';

interface Source {
  url: string;
  engine: Engine;
  fileName?: string;
  mime?: string;
  alt?: string; // alternative (e.g. HLS transcode) if the primary fails
  /** MKV the browser can't open itself: repackage to MP4 on the fly (lib/mkv). */
  remux?: boolean;
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

/**
 * webtor.io opens a magnet as a top-level page via /ext/magnet?url=… (the route its
 * browser extension uses). Its embedded iframe player fails on iPhone Safari with
 * "CSRF token mismatch" because Safari blocks third-party cookies inside iframes.
 */
const webtorUrl = (magnet: string) => `https://webtor.io/ext/magnet?url=${encodeURIComponent(magnet)}`;

export function VideoPlayer({ onBack }: { onBack?: () => void }) {
  const req = useApp((s) => s.nowPlaying);
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

  const subs = useSubtitles(req, source?.fileName);
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
          const preferHls = !!res.hlsUrl && (isIOS() || (res.mimeType === 'video/x-matroska' && !canPlayMkv()));
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
      on('play', () => setPlaying(true)),
      on('pause', () => setPlaying(false)),
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
        if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        if (resumeId && Math.abs(v.currentTime - lastSave) > 5) {
          lastSave = v.currentTime;
          try { localStorage.setItem(resumeKey(resumeId), String(Math.floor(v.currentTime))); } catch { /* ignore */ }
        }
      }),
      on('error', () => {
        const code = v.error?.code;
        if (!v.currentSrc && !hlsRef.current) return;
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
      if (t?.cues.length) out.push({ lang, url: URL.createObjectURL(new Blob([toVtt(t.cues, subs.offsets[lang] / 1000, lang === 'ar')], { type: 'text/vtt' })) });
    }
    return out;
  }, [subs.loaded, subs.offsets]);
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

  return (
    <div
      ref={containerRef}
      className="player relative aspect-video w-full select-none overflow-hidden bg-black md:rounded-xl [&:fullscreen]:aspect-auto [&:fullscreen]:rounded-none"
      data-controls={controls && phase === 'ready'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { gesture.current = null; setScrub(undefined); }}
      onMouseLeave={() => playing && setControls(false)}
      style={{ touchAction: 'pan-y' }}
    >
      <video
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

      {/* Idle / resolving / error overlays */}
      {phase !== 'ready' && (
        <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-gradient-to-b from-ink-900 to-black px-6 pb-4 pt-16 text-center" onPointerUp={(e) => e.stopPropagation()}>
          {phase === 'idle' && (
            <div className="max-w-sm space-y-2 text-ink-400">
              <IconPlay size={40} className="mx-auto text-ink-600" />
              <p className="text-sm">Pick a stream or paste a magnet link to start playing.</p>
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
          {phase === 'error' && (
            <div className="max-w-md space-y-3">
              <p className="text-sm text-red-300">{error}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {req?.kind === 'torrent' && caps?.stream && source?.engine !== 'cloud' && engineOverride !== 'cloud' && (
                  <button className="btn-ghost border border-ink-600" onClick={() => setEngineOverride('cloud')}>Stream via your relay</button>
                )}
                {req?.kind === 'torrent' && engineOverride !== 'webtor' && (
                  <button className="btn-ghost border border-ink-600" onClick={() => setEngineOverride('webtor')}>Try free online player</button>
                )}
                {req?.kind === 'torrent' && supportsWebTorrent() && source?.engine !== 'webtorrent' && (
                  <button className="btn-ghost border border-ink-600" onClick={() => setEngineOverride('webtorrent')}>Try WebTorrent</button>
                )}
                {req?.kind === 'torrent' && hasDebrid(settings, caps) && engineOverride === 'webtorrent' && (
                  <button className="btn-ghost border border-ink-600" onClick={() => setEngineOverride('debrid')}>Use Debrid</button>
                )}
                {onBack && <button className="btn-ghost border border-ink-600" onClick={onBack}>Back to results</button>}
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'ready' && waiting && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      )}

      {phase === 'ready' && !playing && !waiting && (
        <button className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white backdrop-blur" onPointerUp={(e) => { e.stopPropagation(); togglePlay(); }} aria-label="Play">
          <IconPlay size={28} />
        </button>
      )}

      {flash && (
        <div key={flash.key} className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${flash.side === 'left' ? 'left-[12%]' : flash.side === 'right' ? 'right-[12%]' : 'left-1/2 -translate-x-1/2'}`}>
          <div className="animate-ripple rounded-full bg-white/20 px-4 py-3 text-sm font-semibold text-white">{flash.label}</div>
        </div>
      )}

      {scrub != null && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-4 py-2 text-lg font-semibold tabular-nums text-white">
          {fmtTime(scrub)} / {fmtTime(duration)}
        </div>
      )}

      {/* Top bar */}
      {req && (
        <div className={`absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-black/80 to-transparent p-3 pt-[max(0.75rem,env(safe-area-inset-top))] transition-opacity ${controls || phase !== 'ready' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          onPointerUp={(e) => e.stopPropagation()}>
          {onBack && <button className="btn-ghost -ml-1 p-1 text-white md:hidden" onClick={onBack} aria-label="Back"><IconBack /></button>}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{req.title}{req.season != null ? ` · S${String(req.season).padStart(2, '0')}E${String(req.episode ?? '').padStart(2, '0')}` : ''}</p>
            <p className="truncate text-[11px] text-white/60">
              {source?.engine === 'cloud' ? (source.remux ? 'your relay · MKV converted' : 'your relay') : source?.engine === 'direct' ? `direct link${source.url.includes('/api/proxy') ? ' via your relay' : ''}${source.remux ? ' · MKV converted' : ''}` : source?.engine ?? '…'}{source?.fileName ? ` · ${source.fileName}` : ''}
              {source?.engine === 'cloud' && cloudStats && ` · ${cloudStats.peers} peer${cloudStats.peers === 1 ? '' : 's'} · ↓ ${formatBytes(cloudStats.downSpeed)}/s`}
              {wtStats && ` · ${wtStats.numPeers} peers · ↓ ${formatBytes(wtStats.downloadSpeed)}/s · ${(wtStats.progress * 100).toFixed(1)}%`}
            </p>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      {phase === 'ready' && (
        <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-8 transition-opacity ${controls ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); poke(); }}>
          <div className="relative mb-1 h-4">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white/30" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
            </div>
            <input type="range" aria-label="Seek" min={0} max={duration || 0} step={0.1} value={shownTime}
              onChange={(e) => { const v = videoRef.current; if (v) v.currentTime = +e.target.value; }}
              className="absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent" />
          </div>
          <div className="flex items-center gap-1 text-white">
            <button className="btn-ghost p-2 text-white" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <IconPause size={20} /> : <IconPlay size={20} />}</button>
            <button className="btn-ghost hidden p-2 text-xs text-white sm:inline-flex" onClick={() => seekBy(-10)} aria-label="Back 10 seconds">−10</button>
            <button className="btn-ghost hidden p-2 text-xs text-white sm:inline-flex" onClick={() => seekBy(10)} aria-label="Forward 10 seconds">+10</button>
            <span className="px-1 text-xs tabular-nums text-white/80">{fmtTime(shownTime)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <div className="group hidden items-center lg:flex">
              <button className="btn-ghost p-2 text-white" onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <IconMute size={18} /> : <IconVolume size={18} />}</button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => setVol(+e.target.value)} className="w-0 opacity-0 transition-all group-hover:w-20 group-hover:opacity-100 focus:w-20 focus:opacity-100" aria-label="Volume" />
            </div>
            <button className={`btn-ghost p-2 ${subsHidden ? 'text-white/50' : 'text-white'}`} onClick={() => setPanel((p) => !p)} aria-label="Subtitles">
              <IconCC size={18} />
              {LANGS.filter((l) => subs.loaded[l]?.cues.length).map((l) => <span key={l} className="text-[10px] font-bold uppercase">{l}</span>)}
            </button>
            <button className="btn-ghost hidden p-2 text-white sm:inline-flex" onClick={togglePip} aria-label="Picture in picture"><IconPip size={18} /></button>
            <button className="btn-ghost p-2 text-white" onClick={toggleFullscreen} aria-label="Fullscreen">{fullscreen ? <IconShrink size={18} /> : <IconExpand size={18} />}</button>
          </div>
        </div>
      )}

      {/* Subtitle panel */}
      {panel && (
        <div className="absolute inset-0 z-20 bg-ink-950/95 backdrop-blur md:inset-y-0 md:left-auto md:w-96 md:border-l md:border-ink-700"
          onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <SubtitlePanel subs={subs} onClose={() => setPanel(false)} hidden={subsHidden} onHiddenChange={setSubsHidden} />
        </div>
      )}
    </div>
  );
}
