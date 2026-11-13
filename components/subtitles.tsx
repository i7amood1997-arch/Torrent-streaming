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
import type { SubtitleCue, SubtitleTrackInfo } from '@/lib/types';
import { IconUpload, IconX } from './icons';

export type Lang = 'ar' | 'en';
export const LANGS: Lang[] = ['ar', 'en'];
const LANG_NAME: Record<Lang, string> = { ar: 'العربية · Arabic', en: 'English' };

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
}

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
  applyAutoSync: (lang: Lang, offsetMs: number, scale: number) => void;
  loading: boolean;
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

export function useSubtitles(req: PlayRequest | undefined, file: PlayingFile): SubtitleState {
  const releaseName = file.name;
  const [tracks, setTracks] = useState<SubtitleTrackInfo[]>([]);
  const [loaded, setLoaded] = useState<SubtitleState['loaded']>({});
  const [offsets, setOffsets] = useState<Record<Lang, number>>({ ar: 0, en: 0 });
  const [scales, setScales] = useState<Record<Lang, number>>({ ar: 1, en: 1 });
  const [baseShiftMs, setBaseShift] = useState(0);
  const [manual, setManual] = useState<Set<Lang>>(new Set());
  const [autoSynced, setAutoSynced] = useState<Partial<Record<Lang, AutoSyncInfo>>>({});
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  /** Embedded (in-file) subtitle cues per language, filled while the file streams. */
  const embeddedRef = useRef<Partial<Record<Lang, { info: SubtitleTrackInfo; cues: SubtitleCue[]; dirty: boolean }>>>({});
  /** Languages the user picked by hand: auto-selection must not override them. */
  const userPickedRef = useRef(new Set<Lang>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadCues = useCallback(async (lang: Lang, info: SubtitleTrackInfo, signal?: AbortSignal) => {
    setLoaded((l) => ({ ...l, [lang]: { info, cues: [] } }));
    try {
      const { cues } = await api.subtitleCues(info.token, signal);
      setLoaded((l) => (l[lang]?.info.id === info.id ? { ...l, [lang]: { info, cues } } : l));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setErrors((x) => [...x, `${lang.toUpperCase()}: ${(e as Error).message}`]);
      setLoaded((l) => (l[lang]?.info.id === info.id ? { ...l, [lang]: null } : l));
    }
  }, []);

  // Reset everything when a new item starts playing.
  useEffect(() => {
    abortRef.current?.abort();
    setTracks([]); setLoaded({}); setErrors([]); setOffsets({ ar: 0, en: 0 }); setScales({ ar: 1, en: 1 });
    setManual(new Set()); setAutoSynced({});
    embeddedRef.current = {};
    userPickedRef.current = new Set();
    clearTimeout(flushTimer.current);
  }, [req?.nonce]);

  // Search once the playing file is known (and hashed, for exact-release matches).
  useEffect(() => {
    if (!req || !file.ready) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    api
      .subtitles({ imdb: req.imdbId, tmdb: req.tmdbId, type: req.type, season: req.season, episode: req.episode, release: releaseName ?? req.result?.title, q: req.imdbId || req.tmdbId ? undefined : req.title, langs: 'ar,en', hash: file.hash, size: file.size, file: file.name }, ac.signal)
      .then(({ tracks, errors }) => {
        setTracks((prev) => [...prev.filter((t) => t.provider === 'embedded' || t.provider === 'local'), ...tracks]);
        setErrors(errors.map((e) => `${e.provider}: ${e.message}`));
        const best = autoSelectTracks(tracks, LANGS);
        for (const lang of LANGS) {
          const t = best[lang];
          // Embedded subtitles (exact timing) and the user's own choice win over downloads.
          if (t && !userPickedRef.current.has(lang) && !embeddedRef.current[lang]) loadCues(lang, t, ac.signal);
        }
      })
      .catch((e) => { if (e.name !== 'AbortError') setErrors([e.message]); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [req?.nonce, file.ready, file.hash, releaseName, loadCues]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = useCallback((lang: Lang, t: SubtitleTrackInfo | null) => {
    userPickedRef.current.add(lang);
    const emb = embeddedRef.current[lang];
    if (!t) setLoaded((l) => ({ ...l, [lang]: null }));
    else if (t.provider === 'embedded' && emb) setLoaded((l) => ({ ...l, [lang]: { info: emb.info, cues: [...emb.cues] } }));
    else loadCues(lang, t);
  }, [loadCues]);

  // Embedded subtitles are timed for this exact release, so they win over downloaded ones
  // unless the user chose a track themselves. Cues arrive one by one; publish them in batches.
  const flushEmbedded = useCallback(() => {
    for (const lang of LANGS) {
      const e = embeddedRef.current[lang];
      if (!e?.dirty) continue;
      e.dirty = false;
      const cues = [...e.cues];
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
    setTracks((t) => [info, ...t]);
    setLoaded((l) => ({ ...l, [lang]: { info, cues } }));
  }, [releaseName]);

  /** Manual sync: also stops auto-sync for this language. */
  const setOffset = useCallback((lang: Lang, ms: number) => {
    setManual((m) => (m.has(lang) ? m : new Set(m).add(lang)));
    setOffsets((o) => ({ ...o, [lang]: Math.max(-30000, Math.min(30000, Math.round(ms))) }));
  }, []);

  const applyAutoSync = useCallback((lang: Lang, offsetMs: number, scale: number) => {
    setOffsets((o) => ({ ...o, [lang]: Math.round(offsetMs) }));
    setScales((s) => ({ ...s, [lang]: scale }));
    setAutoSynced((a) => ({ ...a, [lang]: { offsetMs: Math.round(offsetMs), scale } }));
  }, []);

  // A different track has different timing: drop the previous automatic correction.
  const trackIds = LANGS.map((l) => loaded[l]?.info.id ?? '').join('|');
  useEffect(() => {
    setAutoSynced((a) => {
      const next = { ...a };
      for (const lang of LANGS) if (a[lang] && loaded[lang]?.info.provider === 'embedded') delete next[lang];
      return next;
    });
  }, [trackIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const timing = useCallback((lang: Lang) => {
    const embedded = loaded[lang]?.info.provider === 'embedded';
    return { shiftMs: (embedded ? 0 : baseShiftMs) + offsets[lang], scale: embedded ? 1 : scales[lang] };
  }, [loaded, baseShiftMs, offsets, scales]);

  return { tracks, loaded, offsets, scales, baseShiftMs, setBaseShift, manual, autoSynced, applyAutoSync, timing, loading, errors, select, loadFile, setOffset, addEmbedded };
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

function SyncStatus({ subs, lang, enabled, listening }: { subs: SubtitleState; lang: Lang; enabled: boolean; listening: boolean }) {
  const info = subs.loaded[lang]?.info;
  const auto = subs.autoSynced[lang];
  let text: string;
  let tone = 'text-ink-400';
  if (info?.provider === 'embedded') { text = 'From the video file: always in sync.'; tone = 'text-hd'; }
  else if (subs.manual.has(lang)) text = 'Synced by hand.';
  else if (auto) {
    const s = auto.offsetMs / 1000;
    text = `Auto-synced to the audio (${s > 0 ? '+' : ''}${s.toFixed(1)} s${auto.scale !== 1 ? ', frame rate corrected' : ''}).`;
    tone = 'text-hd';
  } else if (info?.hashMatch) { text = 'Made for this exact file: in sync.'; tone = 'text-hd'; }
  else if (!enabled) text = 'Auto-sync is off.';
  else if (listening) text = 'Listening to the dialogue to check the timing (about a minute)…';
  else text = 'Auto-sync starts once the video plays with sound (not available for every stream).';
  return <p className={`text-xs ${tone}`}>{text}</p>;
}

const COLORS = ['#ffffff', '#ffe066', '#9be9a8', '#8bd3ff', '#ffb3c7'];

export function SubtitlePanel({ subs, onClose, hidden, onHiddenChange, listening }: { subs: SubtitleState; onClose: () => void; hidden: boolean; onHiddenChange: (h: boolean) => void; listening?: boolean }) {
  const style = useApp((s) => s.settings.subtitle);
  const update = useApp((s) => s.updateSubtitleStyle);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadLang, setUploadLang] = useState<Lang>('ar');

  return (
    <div className="flex max-h-full flex-col gap-4 overflow-y-auto p-4 text-sm scrollbar-thin" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Subtitles</h3>
        <label className="ml-auto mr-2 flex items-center gap-2 text-xs text-ink-400">
          <input type="checkbox" checked={!hidden} onChange={(e) => onHiddenChange(!e.target.checked)} /> Show
        </label>
        <button className="btn-ghost p-1" onClick={onClose} aria-label="Close subtitle settings"><IconX size={18} /></button>
      </div>

      {subs.loading && <p className="animate-pulse text-xs text-ink-400">Searching OpenSubtitles / SubDL…</p>}
      {subs.errors.map((e) => <p key={e} className="text-xs text-red-300/80">{e}</p>)}

      {LANGS.map((lang) => {
        const list = subs.tracks.filter((t) => t.lang === lang);
        const cur = subs.loaded[lang];
        return (
          <fieldset key={lang} className="card space-y-3 p-3">
            <legend className="px-1 text-xs font-semibold text-ink-200" dir="auto">{LANG_NAME[lang]}</legend>
            <select className="input text-sm" value={cur?.info.id ?? ''} onChange={(e) => subs.select(lang, list.find((t) => t.id === e.target.value) ?? null)} aria-label={`${lang} subtitle track`}>
              <option value="">Off</option>
              {list.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.score != null && t.score > 0.5 ? '★ ' : ''}{t.releaseName ?? t.label}{t.hearingImpaired ? ' [HI]' : ''} · {t.provider}
                </option>
              ))}
            </select>
            {cur && !cur.cues.length && <p className="animate-pulse text-xs text-ink-400">Downloading…</p>}
            {cur && cur.cues.length > 0 && <SyncStatus subs={subs} lang={lang} enabled={style.autoSync} listening={!!listening} />}
            <div>
              <div className="flex items-center justify-between">
                <span className="label mb-0">Sync delay</span>
                <span className="tabular-nums text-accent">{subs.offsets[lang] > 0 ? '+' : ''}{subs.offsets[lang]} ms</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button className="btn-ghost border border-ink-600 px-2 py-1" onClick={() => subs.setOffset(lang, subs.offsets[lang] - 100)} aria-label="Earlier 100ms">−100</button>
                <input type="range" min={-10000} max={10000} step={50} value={subs.offsets[lang]} onChange={(e) => subs.setOffset(lang, +e.target.value)} className="flex-1" aria-label={`${lang} subtitle delay`} />
                <button className="btn-ghost border border-ink-600 px-2 py-1" onClick={() => subs.setOffset(lang, subs.offsets[lang] + 100)} aria-label="Later 100ms">+100</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => subs.setOffset(lang, 0)}>Reset</button>
              </div>
            </div>
          </fieldset>
        );
      })}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <span className="label">Load local file (.srt / .vtt)</span>
          <select className="input text-sm" value={uploadLang} onChange={(e) => setUploadLang(e.target.value as Lang)} aria-label="Language of uploaded file">
            <option value="ar">Arabic</option>
            <option value="en">English</option>
          </select>
        </div>
        <button className="btn-ghost border border-ink-600" onClick={() => fileRef.current?.click()}><IconUpload size={16} /> Upload</button>
        <input ref={fileRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) subs.loadFile(f, uploadLang); e.target.value = ''; }} />
      </div>

      <fieldset className="card grid gap-3 p-3">
        <legend className="px-1 text-xs font-semibold text-ink-200">Appearance</legend>
        <div className="flex items-center gap-3">
          <span className="label mb-0 w-24">Primary</span>
          <div className="flex gap-1">
            {LANGS.map((l) => <button key={l} className={`pill ${style.primaryLang === l ? 'border-accent text-accent' : 'border-ink-600 text-ink-400'}`} onClick={() => update({ primaryLang: l })}>{l.toUpperCase()}</button>)}
          </div>
          <label className="ml-auto flex items-center gap-2 text-xs"><input type="checkbox" checked={style.dual} onChange={(e) => update({ dual: e.target.checked })} /> Dual (AR + EN)</label>
        </div>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={style.autoSync} onChange={(e) => update({ autoSync: e.target.checked })} />
          <span><span className="text-ink-200">Auto-sync to the audio</span><span className="block text-ink-400">Listens to the dialogue and lines subtitles up with it, including frame-rate differences. Moving the delay slider takes over by hand.</span></span>
        </label>
        <label className="flex items-center gap-3"><span className="label mb-0 w-24">Size</span><input type="range" min={0.6} max={2} step={0.05} value={style.scale} onChange={(e) => update({ scale: +e.target.value })} className="flex-1" /><span className="w-10 text-right tabular-nums">{Math.round(style.scale * 100)}%</span></label>
        <label className="flex items-center gap-3"><span className="label mb-0 w-24">Background</span><input type="range" min={0} max={1} step={0.05} value={style.bgOpacity} onChange={(e) => update({ bgOpacity: +e.target.value })} className="flex-1" /><span className="w-10 text-right tabular-nums">{Math.round(style.bgOpacity * 100)}%</span></label>
        <label className="flex items-center gap-3"><span className="label mb-0 w-24">Position</span><input type="range" min={2} max={40} step={1} value={style.position} onChange={(e) => update({ position: +e.target.value })} className="flex-1" /><span className="w-10 text-right tabular-nums">{style.position}%</span></label>
        <div className="flex items-center gap-3">
          <span className="label mb-0 w-24">Colour</span>
          {COLORS.map((c) => <button key={c} className={`h-6 w-6 rounded-full border-2 ${style.color === c ? 'border-accent' : 'border-ink-600'}`} style={{ background: c }} onClick={() => update({ color: c })} aria-label={`Colour ${c}`} />)}
          <input type="color" value={style.color} onChange={(e) => update({ color: e.target.value })} className="h-6 w-8 cursor-pointer bg-transparent" aria-label="Custom colour" />
        </div>
        <div className="flex items-center gap-3">
          <span className="label mb-0 w-24">Arabic font</span>
          {(['Cairo', 'Tajawal'] as const).map((f) => (
            <button key={f} className={`pill ${style.arabicFont === f ? 'border-accent text-accent' : 'border-ink-600 text-ink-400'}`} style={{ fontFamily: f }} onClick={() => update({ arabicFont: f })}>{f} · ترجمة</button>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-ink-400">Shortcuts: <kbd>C</kbd> toggle · <kbd>[</kbd>/<kbd>]</kbd> primary delay ∓100 ms</p>
    </div>
  );
}
