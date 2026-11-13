'use client';
/**
 * Up-front subtitle sync (see lib/presync.ts): as soon as a video starts, fetch short
 * stretches of its audio from across the file, fit each loaded subtitle against them and
 * set its timing. If the chosen subtitle doesn't fit (made for a different cut), try the
 * next ones. Falls back to recognised words (relay) and to the other language as a reference.
 */
import { useEffect, useRef } from 'react';
import { api } from '@/lib/client-api';
import { analyseClip, canAnalyseAudio } from '@/lib/audio-energy';
import type { Alignment, SpeechSample } from '@/lib/autosync';
import { confident } from '@/lib/autosync';
import { alignToReference, anchorOffset, betterFit, fitTrack, fits, planWindows, type Fit } from '@/lib/presync';
import { openAudioSource, type AudioClip } from '@/lib/speech/audio-source';
import type { SubtitleCue, SubtitleTrackInfo } from '@/lib/types';
import { LANGS, type Lang, type SubtitleState } from './subtitles';

const MKV_BUDGET = 28 << 20; // bytes per stretch when the whole stream must be read
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((res) => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });

const downloadable = (t?: SubtitleTrackInfo) => !!t && (t.provider === 'opensubtitles' || t.provider === 'subdl' || t.provider === 'local' || t.provider === 'translated');
const exact = (t?: SubtitleTrackInfo) => !!t && (t.provider === 'embedded' || t.provider === 'generated');

export interface PresyncApplied { track: string; offset: number; scale: number }

export function usePresync(opts: {
  /** Changes for every new video. */
  playKey: string;
  urls?: string[];
  enabled: boolean;
  /** Relay offers speech recognition. */
  ai: boolean;
  subsRef: React.MutableRefObject<SubtitleState | null>;
  getTime: () => number;
  /** Tells the live listener what was applied (media-time shift in seconds). */
  onApplied: (lang: Lang, a: PresyncApplied) => void;
}) {
  const o = useRef(opts);
  o.current = opts;
  const urlKey = opts.urls?.join('|') ?? '';

  useEffect(() => {
    if (!opts.enabled || !opts.playKey) return;
    const ac = new AbortController();
    const signal = ac.signal;
    const subs = () => o.current.subsRef.current!;
    const done = new Map<Lang, string>(); // language → track id already handled
    const windows: SpeechSample[][] = [];
    let firstClip: AudioClip | undefined;
    let audio: 'pending' | 'ready' | 'none' = opts.urls?.length && canAnalyseAudio() ? 'pending' : 'none';
    let words: { language?: string; list: { word: string; start: number }[] } | undefined | null;

    const apply = (lang: Lang, track: string, a: Alignment, method: 'audio' | 'reference' | 'words', fileTime: boolean) => {
      const s = subs();
      if (s.loaded[lang]?.info.id !== track || s.manual.has(lang)) return;
      // Audio stretches are in file time; the player's timeline may be shifted (MKV converter).
      const offsetMs = a.offset * 1000 - (fileTime ? 0 : s.baseShiftMs);
      s.applyAutoSync(lang, offsetMs, a.scale, method);
      s.setSyncPhase(lang, undefined);
      o.current.onApplied(lang, { track, offset: (offsetMs + s.baseShiftMs) / 1000, scale: a.scale });
      done.set(lang, track);
    };

    /** Subtitles needing a check right now. */
    const pending = () => LANGS.flatMap((lang) => {
      const s = subs();
      const tr = s.loaded[lang];
      if (!tr?.cues.length || !downloadable(tr.info) || s.manual.has(lang) || done.get(lang) === tr.info.id) return [];
      if (tr.info.provider === 'translated' && s.auto[lang]?.status === 'working') return []; // wait for all lines
      return [{ lang, info: tr.info, cues: tr.cues }];
    });

    /** Use the other language (already right) as the reference. */
    const byReference = (lang: Lang, info: SubtitleTrackInfo, cues: SubtitleCue[]) => {
      const s = subs();
      for (const other of LANGS) {
        if (other === lang) continue;
        const ref = s.loaded[other];
        if (!ref?.cues.length) continue;
        const trusted = exact(ref.info) || (done.get(other) === ref.info.id && !!s.autoSynced[other]);
        if (!trusted) continue;
        const { shiftMs, scale } = s.timing(other);
        const refCues = ref.cues.map((c) => ({ ...c, start: c.start * scale + shiftMs / 1000, end: c.end * scale + shiftMs / 1000 }));
        const a = alignToReference(refCues, cues);
        if (confident(a)) { apply(lang, info.id, a!, 'reference', false); return true; }
      }
      return false;
    };

    const byWords = async (lang: Lang, info: SubtitleTrackInfo, cues: SubtitleCue[]) => {
      if (!o.current.ai || !firstClip || words === null) return false;
      if (words === undefined) {
        try {
          const tr = await api.transcribe(firstClip, {}, signal);
          const t0 = firstClip.start;
          words = { language: tr.language, list: tr.segments.flatMap((sg) => sg.words?.length ? sg.words.map((w) => ({ word: w.word, start: w.start + t0 })) : sg.text.split(/\s+/).map((w, i, all) => ({ word: w, start: t0 + sg.start + ((i + 0.5) / all.length) * (sg.end - sg.start) }))) };
        } catch { words = null; return false; }
      }
      if (!words || words.language !== info.lang || info.provider === 'translated') return false;
      const a = anchorOffset(words.list, cues);
      if (!a || a.ratio < 2) return false;
      apply(lang, info.id, { offset: a.offset, scale: 1, z: a.votes, ratio: a.ratio, seconds: 0 }, 'words', true);
      return true;
    };

    /** Fit one language; when `final`, also try other subtitles and the fallbacks. */
    const check = async (lang: Lang, info: SubtitleTrackInfo, cues: SubtitleCue[], final: boolean) => {
      let fit: Fit | undefined = windows.length ? fitTrack(windows, cues) : undefined;
      if (fits(fit) && (windows.length >= 2 || final)) { apply(lang, info.id, fit, 'audio', true); return; }
      if (!final) return;
      if (byReference(lang, info, cues)) return;

      // The chosen subtitle doesn't fit this video: try the next best ones.
      if (windows.length && info.provider !== 'local' && info.provider !== 'translated') {
        const s = subs();
        const others = s.tracks.filter((t) => t.lang === lang && t.id !== info.id && t.token && (t.provider === 'opensubtitles' || t.provider === 'subdl')).slice(0, 3);
        let best: { info: SubtitleTrackInfo; cues: SubtitleCue[]; fit: Fit } | undefined;
        for (const t of others) {
          try {
            const alt = (await api.subtitleCues(t.token, signal)).cues;
            const f = fitTrack(windows, alt);
            if (f && betterFit(f, best?.fit)) best = { info: t, cues: alt, fit: f };
            if (fits(f)) break;
          } catch { /* next */ }
          if (signal.aborted) return;
        }
        if (best && fits(best.fit) && subs().loaded[lang]?.info.id === info.id) {
          subs().autoSwitch(lang, best.info, best.cues);
          await wait(60, signal);
          apply(lang, best.info.id, best.fit, 'audio', true);
          return;
        }
      }
      if (await byWords(lang, info, cues)) return;

      // Clear overall match but the stretches disagree (different cut): use the stretch nearest the playhead.
      if (fit && confident(fit) && fit.local.length) {
        const now = o.current.getTime();
        const near = fit.local.reduce((a, b) => (Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a));
        apply(lang, info.id, { ...fit, offset: near.offset }, 'audio', true);
        return;
      }
      done.set(lang, info.id);
      subs().setSyncPhase(lang, 'unsure');
    };

    (async () => {
      // Wait for the first subtitle to be ready.
      while (!signal.aborted && !pending().length) await wait(700, signal);
      if (signal.aborted) return;
      for (const p of pending()) subs().setSyncPhase(p.lang, 'checking');

      if (audio === 'pending') {
        try {
          const src = await openAudioSource(o.current.urls!, signal);
          const cheap = src.costPerSecond < 100_000; // MP4: audio only
          const length = cheap ? 60 : Math.floor(Math.min(60, MKV_BUDGET / src.costPerSecond));
          if (length < 30) throw new Error('bitrate too high to sample');
          const first = pending()[0];
          const starts = planWindows(first.cues, src.duration, cheap ? 4 : 3, length);
          for (const start of starts) {
            const clip = await src.read(start, start + length, signal);
            firstClip ??= clip;
            windows.push(await analyseClip(clip));
            if (signal.aborted) return;
            if (windows.length >= 2) for (const p of pending()) await check(p.lang, p.info, p.cues, false);
          }
          audio = 'ready';
        } catch {
          if (signal.aborted) return;
          audio = windows.length ? 'ready' : 'none';
        }
      }

      // Final pass now, and again whenever a subtitle changes (picked by hand, translation finished…).
      while (!signal.aborted) {
        for (const p of pending()) {
          subs().setSyncPhase(p.lang, 'checking');
          await check(p.lang, p.info, p.cues, true);
          if (signal.aborted) return;
        }
        // A language left unsure may be fixed later, once the other one is synced or embedded lines arrive.
        for (const lang of LANGS) {
          const s = subs();
          const tr = s.loaded[lang];
          if (tr?.cues.length && downloadable(tr.info) && s.syncPhase[lang] === 'unsure' && !s.manual.has(lang)) byReference(lang, tr.info, tr.cues);
        }
        await wait(2500, signal);
      }
    })().catch(() => undefined);

    return () => ac.abort();
  }, [opts.playKey, urlKey, opts.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
