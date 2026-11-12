/**
 * SRT / WebVTT parsing and charset handling (isomorphic — used by the server
 * subtitle proxy and by the client for user-uploaded subtitle files).
 */
import type { SubtitleCue, SubtitleTrackInfo } from './types';

const TS = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

export function parseTimestamp(s: string): number {
  const m = s.trim().match(TS);
  if (!m) return NaN;
  const [, h = '0', mi, se, ms] = m;
  return +h * 3600 + +mi * 60 + +se + +ms.padEnd(3, '0') / 1000;
}

/** Strip formatting tags but keep line breaks. ASS-style {\an8} overrides are removed too. */
export function cleanCueText(t: string): string {
  return t
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?(?:i|b|u|font|c|v|ruby|rt|lang)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[‎‏‪-‮]/g, '') // stray bidi marks from Arabic subs; we handle direction ourselves
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Parses both SRT and WebVTT (they share the cue grammar closely enough). */
export function parseSubtitles(input: string): SubtitleCue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const body = cleanCueText(lines.slice(idx + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/**
 * Decode subtitle bytes. Arabic subtitles are very often Windows-1256 rather
 * than UTF-8; English ones are often Windows-1252.
 */
export function decodeSubtitleBytes(bytes: Uint8Array, lang?: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const fallback = lang?.startsWith('ar') ? 'windows-1256' : 'windows-1252';
    try {
      return new TextDecoder(fallback).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/**
 * Cues active at time t. Cues are sorted by start; binary-search the last cue
 * starting at or before t, then walk back a bounded window to catch overlaps.
 */
export function activeCues(cues: SubtitleCue[], t: number): SubtitleCue[] {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const out: SubtitleCue[] = [];
  for (let i = last; i >= 0 && i > last - 20; i--) if (cues[i].end > t) out.unshift(cues[i]);
  return out;
}

const RTL_LANGS = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'ku', 'yi']);
export const isRtlLang = (lang?: string) => !!lang && RTL_LANGS.has(lang.slice(0, 2).toLowerCase());
export const hasRtlChars = (s: string) => /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(s);

// ─── Release-name similarity for auto-selection ─────────────────────────────

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/\.(srt|vtt|ass|sub|mkv|mp4)$/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );

/** Jaccard similarity between release names, with a bonus for matching release group. */
export function releaseSimilarity(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const grpA = a.match(/-([a-z0-9]+)(?:\.\w{2,4})?$/i)?.[1]?.toLowerCase();
  const grpB = b.match(/-([a-z0-9]+)(?:\.\w{2,4})?$/i)?.[1]?.toLowerCase();
  return Math.min(1, jaccard + (grpA && grpA === grpB ? 0.25 : 0));
}

/** Pick the best track for each preferred language (Arabic + English by default). */
export function autoSelectTracks(tracks: SubtitleTrackInfo[], langs: string[] = ['ar', 'en']): Record<string, SubtitleTrackInfo | undefined> {
  const out: Record<string, SubtitleTrackInfo | undefined> = {};
  for (const lang of langs) {
    out[lang] = tracks
      .filter((t) => t.lang === lang)
      .sort((x, y) => (y.score ?? 0) - (x.score ?? 0) || Number(!!x.hearingImpaired) - Number(!!y.hearingImpaired) || (y.downloads ?? 0) - (x.downloads ?? 0))[0];
  }
  return out;
}

const vttTime = (s: number) => {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = (t % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
};

/** Serialise cues to WebVTT (used for native <track> in iOS fullscreen). Offset in seconds. */
export function toVtt(cues: SubtitleCue[], offset = 0, rtl = false): string {
  const lines = ['WEBVTT', ''];
  for (const c of cues) {
    const start = c.start + offset;
    const end = c.end + offset;
    if (end <= 0) continue;
    lines.push(`${vttTime(start)} --> ${vttTime(end)}${rtl ? ' align:center' : ''}`);
    // U+202B RLE … U+202C PDF keeps punctuation on the correct side in native renderers
    lines.push(rtl ? c.text.split('\n').map((l) => `‫${l}‬`).join('\n') : c.text, '');
  }
  return lines.join('\n');
}
