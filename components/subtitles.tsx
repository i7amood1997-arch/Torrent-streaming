'use client';
/**
 * Subtitle engine (client):
 *  - useSubtitles(): searches OpenSubtitles/SubDL by IMDB/TMDB id + release name,
 *    auto-selects the best Arabic and English tracks, downloads cues, supports
 *    local .srt/.vtt upload and per-language sync offsets.
 *  - <SubtitleOverlay/>: custom renderer with true RTL for Arabic (Cairo/Tajawal).
 *  - <SubtitlePanel/>: track pickers + sync (±ms) + size/opacity/colour/position.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { useApp, type PlayRequest } from '@/lib/store';
import { activeCues, autoSelectTracks, decodeSubtitleBytes, hasRtlChars, isRtlLang, parseSubtitles, releaseSimilarity } from '@/lib/subtitle-parser';
import { languageName, plainLine, translateLines, type BatchTranslateFn } from '@/lib/translate';
import type { SubtitleCue, SubtitleTrackInfo } from '@/lib/types';
import type { GeneratorStatus } from '@/lib/speech/generate';
import { IconUpload, IconX } from './icons';
import { Disclosure, Row, Segmented, Switch } from './ui';

export type Lang = 'ar' | 'en';
export const LANGS: Lang[] = ['ar', 'en'];

export interface LoadedTrack {
  info: SubtitleTrackInfo;
  cues: SubtitleCue[];
}

/** The playing file, for exact-release subtitle matching. `ready` once hashing finished (or was skipped). */
export interface PlayingFile {
  name?: string;
  hash?: string;
  size?: number;
  ready: boolean;
}

export interface AutoSyncInfo {
  offsetMs: number;
  scale: number;
  /** How it was found: the film's audio, another subtitle known to be right, or recognised words. */
  method?: 'audio' | 'reference' | 'words';
}

export type SyncPhase = 'checking' | 'unsure';

export interface SubtitleState {
  tracks: SubtitleTrackInfo[];
  loaded: Partial<Record<Lang, LoadedTrack | null>>;
  offsets: Record<Lang, number>; // ms, positive = show later
  /** Speed factor per language (frame-rate conversions): media time = cue time × scale + shift. */
  scales: Record<Lang, number>;
  /** Shift applied to downloaded (not embedded) subtitles, e.g. the MKV converter's timeline offset. */
  baseShiftMs: number;
  setBaseShift: (ms: number) => void;
  /** Languages the user synced by hand (auto-sync leaves them alone). */
  manual: Set<Lang>;
  /** Last automatic correction per language. */
  autoSynced: Partial<Record<Lang, AutoSyncInfo>>;
  applyAutoSync: (lang: Lang, offsetMs: number, scale: number, method?: AutoSyncInfo['method']) => void;
  /** Up-front sync progress per language. */
  syncPhase: Partial<Record<Lang, SyncPhase>>;
  setSyncPhase: (lang: Lang, phase: SyncPhase | undefined) => void;
  /** Replace a language's subtitle with a better-fitting one (not a user choice). */
  autoSwitch: (lang: Lang, info: SubtitleTrackInfo, cues: SubtitleCue[]) => void;
  /** Undo manual timing changes: automatic sync takes over again. */
  resetSync: (lang: Lang) => void;
  loading: boolean;
  /** The subtitle search has finished (with or without results). */
  searched: boolean;
  /** Automatic translation / generation per language. */
  auto: Partial<Record<Lang, AutoJob>>;
  /** Add cues recognised from the audio (`src` = spoken language). */
  addGenerated: (src: string, cues: SubtitleCue[]) => void;
  errors: string[];
  select: (lang: Lang, track: SubtitleTrackInfo | null) => void;
  loadFile: (file: File, lang: Lang) => Promise<void>;
  setOffset: (lang: Lang, ms: number) => void;
  /** Effective timing for a language's loaded track. */
  timing: (lang: Lang) => { shiftMs: number; scale: number };
  /** Add a cue from a subtitle track embedded in the video file (MKV). */
  addEmbedded: (lang: string, label: string, cue: SubtitleCue) => void;
}

/** ISO 639-2 / IETF code → the app's 'ar' | 'en', or undefined for other languages. */
export function appLang(code: string): Lang | undefined {
  const c = code.toLowerCase();
  if (c === 'ara' || c === 'ar' || c.startsWith('ar-')) return 'ar';
  if (c === 'eng' || c === 'en' || c.startsWith('en-')) return 'en';
  return undefined;
}

/** The AI translator on the relay, when available and chosen. */
function aiTranslator(from: string, to: string, title?: string): BatchTranslateFn | undefined {
  const st = useApp.getState();
  if (!st.caps?.ai || st.caps.offline || st.settings.subtitle.translator === 'google') return undefined;
  return (lines, context, signal) => api.translateAI(lines, context, from, to, title, signal);
}

export interface AutoJob {
  kind: 'translate' | 'generate';
  /** Which translator did the work (AI falls back to Google when its allowance runs out). */
  engine?: 'ai' | 'google';
  status: 'working' | 'done' | 'error';
  from?: string;
  /** 0..1 while translating. */
  progress?: number;
  message?: string;
}

/** Languages that machine-translate well, in order of preference, after English. */
const SOURCE_PREF = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'ro', 'pl', 'tr', 'ru', 'cs', 'el', 'ar', 'fa', 'he'];

/** Best track to translate into `target`: English first, then exact-file matches, then well-supported languages. */
export function pickTranslationSource(tracks: SubtitleTrackInfo[], target: string): SubtitleTrackInfo | undefined {
  const rank = (l: string) => { const i = SOURCE_PREF.indexOf(l); return i < 0 ? SOURCE_PREF.length : i; };
  return tracks
    .filter((t) => t.lang !== target && t.token && (t.provider === 'opensubtitles' || t.provider === 'subdl'))
    .sort((a, b) => rank(a.lang) - rank(b.lang) || Number(!!b.hashMatch) - Number(!!a.hashMatch) || (b.score ?? 0) - (a.score ?? 0))[0];
}

export function useSubtitles(req: PlayRequest | undefined, file: PlayingFile): SubtitleState {
  const releaseName = file.name;
  const titleRef = useRef<string | undefined>(undefined);
  titleRef.current = req?.title;
  const [tracks, setTracks] = useState<SubtitleTrackInfo[]>([]);
  const [loaded, setLoaded] = useState<SubtitleState['loaded']>({});
  const [offsets, setOffsets] = useState<Record<Lang, number>>({ ar: 0, en: 0 });
  const [scales, setScales] = useState<Record<Lang, number>>({ ar: 1, en: 1 });
  const [baseShiftMs, setBaseShift] = useState(0);
  const [manual, setManual] = useState<Set<Lang>>(new Set());
  const [autoSynced, setAutoSynced] = useState<Partial<Record<Lang, AutoSyncInfo>>>({});
  const [auto, setAuto] = useState<Partial<Record<Lang, AutoJob>>>({});
  const [syncPhase, setPhases] = useState<Partial<Record<Lang, SyncPhase>>>({});
  const setSyncPhase = useCallback((lang: Lang, phase: SyncPhase | undefined) => setPhases((p) => (p[lang] === phase ? p : { ...p, [lang]: phase })), []);
  const prevIds = useRef<Partial<Record<Lang, string>>>({});
  const keepSync = useRef<Partial<Record<Lang, string>>>({});
  const autoSwitch = useCallback((lang: Lang, info: SubtitleTrackInfo, cues: SubtitleCue[]) => {
    if (userPickedRef.current.has(lang)) return;
    keepSync.current[lang] = info.id;
    setTracks((ts) => (ts.some((t) => t.id === info.id) ? ts : [...ts, info]));
    setLoaded((l) => ({ ...l, [lang]: { info, cues } }));
  }, []);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  /** Embedded (in-file) subtitle cues per language, filled while the file streams. */
  const embeddedRef = useRef<Partial<Record<Lang, { info: SubtitleTrackInfo; cues: SubtitleCue[]; dirty: boolean }>>>({});
  /** Languages the user picked by hand: auto-selection must not override them. */
  const userPickedRef = useRef(new Set<Lang>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Finished translations by track id (switching back is instant). */
  const translatedRef = useRef(new Map<string, LoadedTrack>());
  const jobRef = useRef<Partial<Record<Lang, AbortController>>>({});
  /** Subtitles made from the audio, per language, as windows arrive. */
  const generatedRef = useRef<Partial<Record<Lang, LoadedTrack>>>({});
  const genQueue = useRef<Promise<void>>(Promise.resolve());
  const genAbort = useRef(new AbortController());

  const loadCues = useCallback(async (lang: Lang, info: SubtitleTrackInfo, signal?: AbortSignal) => {
    setLoaded((l) => ({ ...l, [lang]: { info, cues: [] } }));
    try {
      const cues = (await api.subtitleCues(info.token, signal)).cues ?? [];
      setLoaded((l) => (l[lang]?.info.id === info.id ? { ...l, [lang]: { info, cues } } : l));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setErrors((x) => [...x, `${lang.toUpperCase()}: ${(e as Error).message}`]);
      setLoaded((l) => (l[lang]?.info.id === info.id ? { ...l, [lang]: null } : l));
    }
  }, []);

  /** Machine-translate a downloaded track into `lang`; the first minutes show while the rest is translated. */
  const translateInto = useCallback(async (lang: Lang, src: SubtitleTrackInfo, parent?: AbortSignal) => {
    jobRef.current[lang]?.abort();
    const ac = new AbortController();
    jobRef.current[lang] = ac;
    parent?.addEventListener('abort', () => ac.abort(), { once: true });
    const ai = aiTranslator(src.lang, lang, titleRef.current);
    let engine: 'ai' | 'google' = ai ? 'ai' : 'google';
    const id = `tr-${lang}-${src.id}-${engine}`;
    const info: SubtitleTrackInfo = {
      id, provider: 'translated', lang, sourceLang: src.lang, token: '', score: src.score, hashMatch: src.hashMatch,
      label: `${lang.toUpperCase()} · Translated from ${languageName(src.lang)}`, releaseName: src.releaseName,
    };
    setTracks((ts) => (ts.some((t) => t.id === id) ? ts : [...ts, info]));
    const cached = translatedRef.current.get(id);
    if (cached) { setLoaded((l) => ({ ...l, [lang]: cached })); return; }
    setLoaded((l) => ({ ...l, [lang]: { info, cues: [] } }));
    setAuto((a) => ({ ...a, [lang]: { kind: 'translate', engine, status: 'working', from: src.lang, progress: 0 } }));
    try {
      const srcCues = (await api.subtitleCues(src.token, ac.signal)).cues ?? [];
      if (!srcCues.length) throw new Error('the subtitle file is empty');
      const lines = srcCues.map((c) => plainLine(c.text));
      const publish = (out: (string | undefined)[]) => {
        const cues = srcCues.flatMap((c, i) => (out[i] ? [{ start: c.start, end: c.end, text: out[i]! }] : []));
        setLoaded((l) => (l[lang]?.info.id === id ? { ...l, [lang]: { info, cues } } : l));
        return cues;
      };
      const out = await translateLines(lines, src.lang, lang, {
        translate: api.translate,
        ai,
        signal: ac.signal,
        onAiFailed: () => { engine = 'google'; },
        onBatch: (done, partial) => {
          publish(partial);
          setAuto((a) => ({ ...a, [lang]: { kind: 'translate', engine, status: 'working', from: src.lang, progress: done / Math.max(1, lines.length) } }));
        },
      });
      translatedRef.current.set(id, { info, cues: publish(out) });
      setAuto((a) => ({ ...a, [lang]: { kind: 'translate', engine, status: 'done', from: src.lang } }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setAuto((a) => ({ ...a, [lang]: { kind: 'translate', status: 'error', from: src.lang, message: `Couldn’t translate: ${(e as Error).message}` } }));
      setLoaded((l) => (l[lang]?.info.id === id && !l[lang]?.cues.length ? { ...l, [lang]: null } : l));
    }
  }, []);

  // Reset everything when a new item starts playing.
  useEffect(() => {
    abortRef.current?.abort();
    for (const l of LANGS) jobRef.current[l]?.abort();
    genAbort.current.abort();
    genAbort.current = new AbortController();
    setTracks([]); setLoaded({}); setErrors([]); setOffsets({ ar: 0, en: 0 }); setScales({ ar: 1, en: 1 });
    setManual(new Set()); setAutoSynced({}); setAuto({}); setSearched(false); setPhases({});
    embeddedRef.current = {};
    userPickedRef.current = new Set();
    translatedRef.current = new Map();
    generatedRef.current = {};
    clearTimeout(flushTimer.current);
  }, [req?.nonce]);

  // Search once the playing file is known (and hashed, for exact-release matches).
  useEffect(() => {
    if (!req || !file.ready) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const autoTranslate = useApp.getState().settings.subtitle.autoTranslate;
    api
      .subtitles({ imdb: req.imdbId, tmdb: req.tmdbId, type: req.type, season: req.season, episode: req.episode, release: releaseName ?? req.result?.title, q: req.imdbId || req.tmdbId ? undefined : req.title, langs: autoTranslate ? 'ar,en,*' : 'ar,en', hash: file.hash, size: file.size, file: file.name }, ac.signal)
      .then(({ tracks = [], errors = [] }) => {
        setTracks((prev) => [...prev.filter((t) => t.provider === 'embedded' || t.provider === 'local' || t.provider === 'generated'), ...tracks]);
        setErrors(errors.map((e) => `${e.provider}: ${e.message}`));
        const best = autoSelectTracks(tracks, LANGS);
        for (const lang of LANGS) {
          // Embedded subtitles (exact timing) and the user's own choice win over downloads.
          if (userPickedRef.current.has(lang) || embeddedRef.current[lang]) continue;
          const t = best[lang];
          if (t) { loadCues(lang, t, ac.signal); continue; }
          // Missing language: translate the best other track (English first).
          const src = autoTranslate ? pickTranslationSource(tracks, lang) : undefined;
          if (src) void translateInto(lang, src, ac.signal);
        }
      })
      .catch((e) => { if (e.name !== 'AbortError') setErrors([e.message]); })
      .finally(() => { if (!ac.signal.aborted) { setLoading(false); setSearched(true); } });
    return () => ac.abort();
  }, [req?.nonce, file.ready, file.hash, releaseName, loadCues, translateInto]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = useCallback((lang: Lang, t: SubtitleTrackInfo | null) => {
    userPickedRef.current.add(lang);
    if (t?.provider !== 'translated') jobRef.current[lang]?.abort();
    const emb = embeddedRef.current[lang];
    const gen = generatedRef.current[lang];
    if (!t) setLoaded((l) => ({ ...l, [lang]: null }));
    else if (t.provider === 'embedded' && emb) setLoaded((l) => ({ ...l, [lang]: { info: emb.info, cues: [...emb.cues] } }));
    else if (t.provider === 'generated' && gen) setLoaded((l) => ({ ...l, [lang]: { info: gen.info, cues: [...gen.cues] } }));
    else if (t.provider === 'translated') {
      const cached = translatedRef.current.get(t.id);
      if (cached) setLoaded((l) => ({ ...l, [lang]: cached }));
    } else if (t.lang !== lang) void translateInto(lang, t); // another language picked: translate it
    else loadCues(lang, t);
  }, [loadCues, translateInto]);

  /** Cues recognised from the audio (language `src`): shown directly or translated into Arabic/English. */
  const addGenerated = useCallback((src: string, cues: SubtitleCue[]) => {
    const signal = genAbort.current.signal;
    for (const lang of LANGS) {
      const cur = loadedRef.current[lang];
      // Real subtitles (downloaded, embedded, the viewer's own) win.
      if (cur && cur.info.provider !== 'generated' && cur.info.provider !== 'translated') continue;
      if (cur?.info.provider === 'translated' && cur.cues.length) continue;
      const info: SubtitleTrackInfo = {
        id: `gen-${lang}`, provider: 'generated', lang, sourceLang: src, token: '', score: 1,
        label: src === lang ? `${lang.toUpperCase()} · From the audio` : `${lang.toUpperCase()} · From the audio, translated from ${languageName(src)}`,
      };
      const apply = (add: SubtitleCue[]) => {
        if (signal.aborted) return;
        const g = (generatedRef.current[lang] ??= { info, cues: [] });
        g.cues = [...g.cues.filter((c) => !add.some((a) => Math.abs(a.start - c.start) < 0.05)), ...add].sort((a, b) => a.start - b.start);
        setTracks((ts) => (ts.some((t) => t.id === info.id) ? ts : [...ts, info]));
        setLoaded((l) => {
          const now = l[lang];
          if (now && now.info.id !== info.id && now.info.provider !== 'translated') return l;
          if (userPickedRef.current.has(lang) && now?.info.id !== info.id) return l;
          return { ...l, [lang]: { info: g.info, cues: [...g.cues] } };
        });
      };
      if (src === lang) apply(cues);
      else {
        genQueue.current = genQueue.current
          .then(() => translateLines(cues.map((c) => plainLine(c.text)), src, lang, { translate: api.translate, ai: aiTranslator(src, lang, titleRef.current), signal }))
          .then((out) => apply(cues.map((c, i) => ({ ...c, text: out[i] })).filter((c) => c.text)))
          .catch(() => undefined);
      }
    }
  }, []);

  // Embedded subtitles are timed for this exact release, so they win over downloaded ones
  // unless the user chose a track themselves. Cues arrive one by one; publish them in batches.
  const flushEmbedded = useCallback(() => {
    for (const lang of LANGS) {
      const e = embeddedRef.current[lang];
      if (!e?.dirty) continue;
      e.dirty = false;
      const cues = [...e.cues];
      jobRef.current[lang]?.abort();
      setTracks((ts) => (ts.some((t) => t.id === e.info.id) ? ts : [e.info, ...ts]));
      setLoaded((l) => {
        const cur = l[lang];
        if (cur?.info.id === e.info.id) return { ...l, [lang]: { info: e.info, cues } };
        if (userPickedRef.current.has(lang) || cur?.info.provider === 'local') return l;
        return { ...l, [lang]: { info: e.info, cues } };
      });
    }
  }, []);

  const addEmbedded = useCallback((code: string, label: string, cue: SubtitleCue) => {
    const lang = appLang(code);
    if (!lang) return;
    let e = embeddedRef.current[lang];
    if (!e) {
      const info: SubtitleTrackInfo = { id: `embedded-${lang}`, provider: 'embedded', lang, label: `${lang.toUpperCase()} · In the video file`, releaseName: label ? `In the file: ${label}` : 'In the video file', token: '', score: 1 };
      e = embeddedRef.current[lang] = { info, cues: [], dirty: true };
    }
    // Keep sorted (cues arrive in order, except after a seek) and skip duplicates.
    const list = e.cues;
    let i = list.length;
    while (i > 0 && list[i - 1].start > cue.start) i--;
    if (!(i > 0 && list[i - 1].start === cue.start && list[i - 1].text === cue.text)) list.splice(i, 0, cue);
    e.dirty = true;
    if (!flushTimer.current) flushTimer.current = setTimeout(() => { flushTimer.current = undefined; flushEmbedded(); }, 800);
  }, [flushEmbedded]);

  const loadFile = useCallback(async (file: File, lang: Lang) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cues = parseSubtitles(decodeSubtitleBytes(bytes, lang));
    const info: SubtitleTrackInfo = { id: `local-${file.name}-${file.lastModified}`, provider: 'local', lang, label: `${lang.toUpperCase()} · ${file.name}`, releaseName: file.name, token: '', score: releaseSimilarity(file.name, releaseName) };
    userPickedRef.current.add(lang);
    jobRef.current[lang]?.abort();
    setTracks((t) => [info, ...t]);
    setLoaded((l) => ({ ...l, [lang]: { info, cues } }));
  }, [releaseName]);

  /** Manual sync: also stops auto-sync for this language. */
  const setOffset = useCallback((lang: Lang, ms: number) => {
    setManual((m) => (m.has(lang) ? m : new Set(m).add(lang)));
    setOffsets((o) => ({ ...o, [lang]: Math.max(-30000, Math.min(30000, Math.round(ms))) }));
  }, []);

  /** Back to automatic timing for a language. */
  const resetSync = useCallback((lang: Lang) => {
    setManual((m) => { const n = new Set(m); n.delete(lang); return n; });
    setOffsets((o) => ({ ...o, [lang]: 0 }));
    setScales((s) => ({ ...s, [lang]: 1 }));
    setAutoSynced((a) => { const n = { ...a }; delete n[lang]; return n; });
  }, []);

  const applyAutoSync = useCallback((lang: Lang, offsetMs: number, scale: number, method?: AutoSyncInfo['method']) => {
    setOffsets((o) => ({ ...o, [lang]: Math.round(offsetMs) }));
    setScales((s) => ({ ...s, [lang]: scale }));
    setAutoSynced((a) => ({ ...a, [lang]: { offsetMs: Math.round(offsetMs), scale, method } }));
  }, []);

  // A different track has different timing: drop the previous automatic correction.
  const trackIds = LANGS.map((l) => loaded[l]?.info.id ?? '').join('|');
  useEffect(() => {
    for (const lang of LANGS) {
      const id = loaded[lang]?.info.id ?? '';
      if (prevIds.current[lang] === id) continue;
      prevIds.current[lang] = id;
      if (keepSync.current[lang] === id) continue; // switched by the sync engine, which sets the timing itself
      setOffsets((o) => (o[lang] ? { ...o, [lang]: 0 } : o));
      setScales((s) => (s[lang] !== 1 ? { ...s, [lang]: 1 } : s));
      setAutoSynced((a) => { if (!a[lang]) return a; const n = { ...a }; delete n[lang]; return n; });
      setManual((m) => { if (!m.has(lang)) return m; const n = new Set(m); n.delete(lang); return n; });
      setPhases((p) => (p[lang] ? { ...p, [lang]: undefined } : p));
    }
  }, [trackIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const timing = useCallback((lang: Lang) => {
    const embedded = loaded[lang]?.info.provider === 'embedded';
    return { shiftMs: (embedded ? 0 : baseShiftMs) + offsets[lang], scale: embedded ? 1 : scales[lang] };
  }, [loaded, baseShiftMs, offsets, scales]);

  return { tracks, loaded, offsets, scales, baseShiftMs, setBaseShift, manual, autoSynced, applyAutoSync, syncPhase, setSyncPhase, autoSwitch, resetSync, timing, loading, searched, errors, auto, select, loadFile, setOffset, addEmbedded, addGenerated };
}

// ─── Overlay renderer ───────────────────────────────────────────────────────

export function SubtitleOverlay({ video, subs }: { video: HTMLVideoElement | null; subs: SubtitleState }) {
  const style = useApp((s) => s.settings.subtitle);
  const [lines, setLines] = useState<{ lang: Lang; text: string }[]>([]);
  const lastKey = useRef('');

  const primary: Lang = style.primaryLang;
  const secondary: Lang = primary === 'ar' ? 'en' : 'ar';

  useEffect(() => {
    if (!video) return;
    let raf = 0;
    const tick = () => {
      const t = video.currentTime;
      const out: { lang: Lang; text: string }[] = [];
      for (const lang of style.dual ? [secondary, primary] : [primary]) {
        const tr = subs.loaded[lang];
        if (!tr?.cues.length) continue;
        const { shiftMs, scale } = subs.timing(lang);
        const cues = activeCues(tr.cues, (t - shiftMs / 1000) / scale);
        if (cues.length) out.push({ lang, text: cues.map((c) => c.text).join('\n') });
      }
      // Single-language fallback: if the primary language has no track loaded, show whatever is loaded.
      const key = out.map((o) => o.lang + o.text).join('|');
      if (key !== lastKey.current) { lastKey.current = key; setLines(out); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, subs, style.dual, primary, secondary]);

  return (
    <div
      className="sub-layer"
      aria-live="off"
      style={{
        ['--sub-scale' as string]: style.scale,
        ['--sub-bg' as string]: `rgba(0,0,0,${style.bgOpacity})`,
        ['--sub-color' as string]: style.color,
        ['--sub-bottom' as string]: `${style.position}%`,
        ['--sub-ar-font' as string]: style.arabicFont,
      }}
    >
      {lines.map(({ lang, text }) => {
        const rtl = isRtlLang(lang) || hasRtlChars(text);
        return (
          <span key={lang} lang={lang} dir={rtl ? 'rtl' : 'ltr'} className={`sub-cue ${lang !== primary ? 'secondary' : ''}`}>
            {text}
          </span>
        );
      })}
    </div>
  );
}

// ─── Settings / sync panel ──────────────────────────────────────────────────

/** What the speech-to-subtitles generator is doing (owned by the player). */
export interface GenerateControl {
  available: boolean;
  /** Why it isn't available (shown under the button). */
  reason?: string;
  status?: GeneratorStatus;
  running: boolean;
  start: () => void;
}

function syncText(subs: SubtitleState, lang: Lang, enabled: boolean, listening: boolean): { text: string; good?: boolean } | undefined {
  const tr = subs.loaded[lang];
  const info = tr?.info;
  if (!info) return undefined;
  const job = subs.auto[lang];
  if (info.provider === 'translated' && job?.status === 'working') return { text: `${job.engine === 'ai' ? 'AI is translating' : 'Translating'} from ${languageName(job.from)}… ${Math.round((job.progress ?? 0) * 100)}%` };
  if (!tr.cues.length) return { text: info.provider === 'generated' ? 'Listening to the first minute…' : 'Downloading…' };
  if (info.provider === 'embedded') return { text: 'From the video file · always in sync', good: true };
  if (info.provider === 'generated') return { text: info.sourceLang === lang ? 'Made from the audio · in sync' : `Made from the audio · machine-translated from ${languageName(info.sourceLang)}`, good: true };
  if (subs.manual.has(lang)) return { text: 'Timing set by hand' };
  const auto = subs.autoSynced[lang];
  const prefix = info.provider === 'translated' ? `${subs.auto[lang]?.engine === 'ai' ? 'AI-translated' : 'Machine-translated'} from ${languageName(info.sourceLang)} · ` : '';
  if (auto) {
    const s = auto.offsetMs / 1000;
    const how = auto.method === 'reference' ? 'matched to the other subtitle' : auto.method === 'words' ? 'matched to the spoken words' : 'matched to the audio';
    const moved = Math.abs(s) >= 0.05 || auto.scale !== 1 ? ` (${s > 0 ? '+' : ''}${s.toFixed(1)} s${auto.scale !== 1 ? ', speed fixed' : ''})` : '';
    return { text: `${prefix}In sync · ${how}${moved}`, good: true };
  }
  if (!enabled) return { text: `${prefix}Auto-sync off` };
  const phase = subs.syncPhase[lang];
  if (phase === 'checking') return { text: `${prefix}Syncing to the film’s audio…` };
  if (info.hashMatch) return { text: `${prefix}Made for this exact file · in sync`, good: true };
  if (phase === 'unsure') return { text: `${prefix}Couldn’t confirm the timing${listening ? ' yet · still listening' : ''}` };
  if (listening) return { text: `${prefix}Checking the timing against the dialogue…` };
  return { text: `${prefix}Timing not checked yet` };
}

const COLORS = ['#ffffff', '#ffe066', '#9be9a8', '#8bd3ff', '#ffb3c7'];
const fmtShift = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${(Math.abs(ms) / 1000).toFixed(1)} s`;

function LanguageCard({ subs, lang, enabled, listening }: { subs: SubtitleState; lang: Lang; enabled: boolean; listening: boolean }) {
  const cur = subs.loaded[lang];
  const hasSubdl = useApp((s) => !!s.settings.subdlKey || !!s.caps?.subtitles.subdl);
  const own = subs.tracks.filter((t) => t.lang === lang);
  const foreign = subs.tracks.filter((t) => t.lang !== lang && t.lang !== 'ar' && t.lang !== 'en' && t.token).slice(0, 12);
  const other = subs.tracks.filter((t) => t.lang === (lang === 'ar' ? 'en' : 'ar') && t.token).slice(0, 4);
  const status = syncText(subs, lang, enabled, listening);
  const job = subs.auto[lang];
  const shift = subs.offsets[lang];
  const step = (d: number) => subs.setOffset(lang, shift + d);
  const optionLabel = (t: SubtitleTrackInfo) =>
    t.provider === 'embedded' ? 'In the video file' : t.provider === 'generated' ? 'From the audio' : t.provider === 'translated' ? `Translated from ${languageName(t.sourceLang)}` : t.provider === 'local' ? `Your file · ${t.releaseName}` : `${t.hashMatch ? '★ ' : t.score != null && t.score > 0.5 ? '☆ ' : ''}${t.releaseName ?? t.label}${t.hearingImpaired ? ' [HI]' : ''}`;
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-white" lang={lang}>{lang === 'ar' ? 'العربية' : 'English'}</span>
        {!cur && !job && !subs.loading && <span className="text-xs text-ink-400">{own.length ? 'Off' : 'None found'}</span>}
      </div>
      <select className="input py-2.5 text-sm" value={cur?.info.id ?? ''} aria-label={`${lang === 'ar' ? 'Arabic' : 'English'} subtitles`}
        onChange={(e) => subs.select(lang, subs.tracks.find((t) => t.id === e.target.value) ?? null)}>
        <option value="">Off</option>
        {own.length > 0 && <optgroup label={lang === 'ar' ? 'Arabic subtitles' : 'English subtitles'}>{own.map((t) => <option key={t.id} value={t.id}>{optionLabel(t)}</option>)}</optgroup>}
        {(other.length > 0 || foreign.length > 0) && (
          <optgroup label="Translate from another language">
            {[...other, ...foreign].map((t) => <option key={t.id} value={t.id}>{languageName(t.lang)} · {t.releaseName ?? t.label}</option>)}
          </optgroup>
        )}
      </select>
      {status && <p className={`text-xs ${status.good ? 'text-hd' : 'text-ink-400'}`}>{status.good && '✓ '}{status.text}</p>}
      {job?.status === 'error' && <p className="text-xs text-red-300">{job.message}</p>}
      {lang === 'ar' && cur?.info.provider === 'translated' && !hasSubdl && (
        <p className="text-[11px] leading-snug text-ink-400">Tip: a free SubDL key (Settings → Optional keys) finds many more Arabic subtitles made by people.</p>
      )}
      {cur && cur.cues.length > 0 && cur.info.provider !== 'embedded' && (
        <div className="flex items-center gap-1.5">
          <span className="mr-auto text-xs text-ink-400">Timing</span>
          <button className="btn-ghost h-9 w-11 bg-ink-800 px-0 text-xs" onClick={() => step(-500)} aria-label="Subtitles 0.5 s earlier">−0.5</button>
          <button className="btn-ghost h-9 w-11 bg-ink-800 px-0 text-xs" onClick={() => step(-100)} aria-label="Subtitles 0.1 s earlier">−0.1</button>
          <span className="w-16 text-center text-sm font-semibold tabular-nums text-white">{fmtShift(shift)}</span>
          <button className="btn-ghost h-9 w-11 bg-ink-800 px-0 text-xs" onClick={() => step(100)} aria-label="Subtitles 0.1 s later">+0.1</button>
          <button className="btn-ghost h-9 w-11 bg-ink-800 px-0 text-xs" onClick={() => step(500)} aria-label="Subtitles 0.5 s later">+0.5</button>
          {subs.manual.has(lang) && <button className="btn-ghost h-9 px-2 text-xs text-accent" onClick={() => subs.resetSync(lang)}>Auto</button>}
        </div>
      )}
    </div>
  );
}

/** Subtitle settings: shown under the video, or as a sheet over it in fullscreen. */
export function SubtitleSettings({ subs, hidden, onHiddenChange, listening, generate, onClose }: { subs: SubtitleState; hidden: boolean; onHiddenChange: (h: boolean) => void; listening?: boolean; generate?: GenerateControl; onClose?: () => void }) {
  const style = useApp((s) => s.settings.subtitle);
  const update = useApp((s) => s.updateSubtitleStyle);
  const caps = useApp((s) => s.caps);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadLang, setUploadLang] = useState<Lang>('ar');
  const none = subs.searched && !LANGS.some((l) => subs.loaded[l]);
  const gs = generate?.status;

  return (
    <div className="space-y-5 text-sm" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-3">
        <h2 className="mr-auto text-base font-semibold text-white">Subtitles</h2>
        {subs.loading && <span className="animate-pulse text-xs text-ink-400">Searching…</span>}
        <Switch checked={!hidden} onChange={(v) => onHiddenChange(!v)} label="Show subtitles" />
        {onClose && <button className="btn-ghost -mr-2 p-2" onClick={onClose} aria-label="Close"><IconX size={18} /></button>}
      </div>

      <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">
        {LANGS.map((lang) => <LanguageCard key={lang} subs={subs} lang={lang} enabled={style.autoSync} listening={!!listening} />)}
      </div>

      {generate && (none || generate.running || gs) && (
        <div className="space-y-2 rounded-2xl bg-ink-900 p-4 ring-1 ring-white/[0.06]">
          <p className="font-medium text-white">Make subtitles from the audio</p>
          <p className="text-xs leading-relaxed text-ink-400">Speech recognition on your relay listens a few minutes ahead and writes subtitles, translated into Arabic and English.</p>
          {gs && (
            <p className={`text-xs ${gs.state === 'error' ? 'text-red-300' : 'text-ink-200'}`}>
              {gs.state === 'error' ? gs.message : gs.state === 'working' ? `Working… ready up to ${fmtClock(gs.readyUntil ?? 0)}${gs.language ? ` · speech: ${languageName(gs.language)}` : ''}` : `Ready up to ${fmtClock(gs.readyUntil ?? 0)}`}
            </p>
          )}
          {!generate.running && (
            <button className="btn-primary w-full" disabled={!generate.available} onClick={generate.start}>Generate subtitles</button>
          )}
          {!generate.available && generate.reason && <p className="text-xs text-ink-400">{generate.reason}</p>}
        </div>
      )}

      {subs.errors.length > 0 && none && !generate?.running && <p className="text-xs text-ink-400">{subs.errors.join(' · ')}</p>}

      <Disclosure title="Appearance">
        <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">
          <Row label="Main language">
            <Segmented label="Main subtitle language" size="sm" value={style.primaryLang} onChange={(v) => update({ primaryLang: v })}
              options={[{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }]} />
          </Row>
          <Row label="Show both languages" hint="The other language appears smaller above.">
            <Switch checked={style.dual} onChange={(v) => update({ dual: v })} label="Show both languages" />
          </Row>
          <Row label="Size"><input type="range" min={0.6} max={2} step={0.05} value={style.scale} onChange={(e) => update({ scale: +e.target.value })} className="w-32" aria-label="Subtitle size" /></Row>
          <Row label="Background"><input type="range" min={0} max={1} step={0.05} value={style.bgOpacity} onChange={(e) => update({ bgOpacity: +e.target.value })} className="w-32" aria-label="Subtitle background" /></Row>
          <Row label="Height"><input type="range" min={2} max={40} step={1} value={style.position} onChange={(e) => update({ position: +e.target.value })} className="w-32" aria-label="Subtitle height" /></Row>
          <Row label="Colour">
            <div className="flex items-center gap-1.5">
              {COLORS.map((c) => <button key={c} className={`h-6 w-6 rounded-full ring-2 ${style.color === c ? 'ring-accent' : 'ring-transparent'}`} style={{ background: c }} onClick={() => update({ color: c })} aria-label={`Colour ${c}`} />)}
            </div>
          </Row>
          <Row label="Arabic font">
            <Segmented label="Arabic font" size="sm" value={style.arabicFont} onChange={(v) => update({ arabicFont: v })}
              options={(['Cairo', 'Tajawal'] as const).map((f) => ({ value: f, label: <span style={{ fontFamily: f }}>{f}</span> }))} />
          </Row>
        </div>
      </Disclosure>

      <Disclosure title="Automatic">
        <div className="divide-y divide-white/[0.07] overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/[0.06]">
          <Row label="Sync to the audio" hint="Lines subtitles up with the dialogue, including speed differences.">
            <Switch checked={style.autoSync} onChange={(v) => update({ autoSync: v })} label="Sync to the audio" />
          </Row>
<Row wrap label="Translator" hint={caps?.ai ? 'AI reads the lines in context: more natural Arabic. It uses your relay’s free daily allowance; Google takes over when that runs out.' : 'AI translation needs your relay, updated to the latest version.'}>
          <Segmented label="Translator" size="sm" value={style.translator} onChange={(v) => update({ translator: v })}
            options={[{ value: 'ai', label: 'AI (best)' }, { value: 'google', label: 'Google' }]} />
        </Row>
        <Row label="Translate when missing" hint="No Arabic or English? Translate the best subtitle in another language.">
            <Switch checked={style.autoTranslate} onChange={(v) => update({ autoTranslate: v })} label="Translate when missing" />
          </Row>
          <Row label="Make from the audio" hint="No subtitles at all? Generate them with speech recognition on your relay.">
            <Switch checked={style.autoGenerate} onChange={(v) => update({ autoGenerate: v })} label="Make from the audio" />
          </Row>
        </div>
      </Disclosure>

      <Disclosure title="Your own file">
        <div className="flex items-center gap-2">
          <Segmented label="Language of the file" size="sm" value={uploadLang} onChange={setUploadLang} options={[{ value: 'ar', label: 'Arabic' }, { value: 'en', label: 'English' }]} />
          <button className="btn-ghost ml-auto bg-ink-800" onClick={() => fileRef.current?.click()}><IconUpload size={16} /> Load .srt / .vtt</button>
          <input ref={fileRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) subs.loadFile(f, uploadLang); e.target.value = ''; }} />
        </div>
      </Disclosure>
    </div>
  );
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
