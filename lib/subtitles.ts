/**
 * Subtitle providers (server side): OpenSubtitles REST API + SubDL.
 * Search by IMDB id / TMDB id / release title, Arabic + English first.
 */
import { unzipSync } from 'fflate';
import { cinemeta } from './cinemeta';
import { parseRelease, titleFromRelease } from './release-parser';
import { describeError, serverOnlyHeaders } from './runtime';
import { decodeSubtitleBytes, parseSubtitles, releaseSimilarity } from './subtitle-parser';
import type { SubtitleCue, SubtitleTrackInfo } from './types';

export interface SubtitleSearch {
  imdbId?: string;
  tmdbId?: number;
  type?: 'movie' | 'series';
  season?: number;
  episode?: number;
  /** Playing release / file name — used as a text query fallback and for ranking. */
  releaseName?: string;
  query?: string;
  langs?: string[];
}

export interface SubtitleKeys {
  openSubtitles?: string;
  subdl?: string;
  /** OpenSubtitles requires an identifying User-Agent. */
  userAgent?: string;
}

const OS_API = 'https://api.opensubtitles.com/api/v1';
const DEFAULT_UA = 'TorrentStreamingPWA v0.1';
const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';
const SUBDL_DL = 'https://dl.subdl.com';

type Token =
  | { p: 'opensubtitles'; fileId: number; lang: string }
  | { p: 'subdl'; url: string; lang: string; season?: number; episode?: number }
  | { p: 'stremio'; url: string; lang: string };

/** Keyless OpenSubtitles feed published as a Stremio add-on (lookup by IMDB id). */
const STREMIO_SUBS = 'https://opensubtitles-v3.strem.io';
const isStremioUrl = (u: string) => {
  try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'strem.io' || x.hostname.endsWith('.strem.io')); } catch { return false; }
};

// base64url without Node's Buffer (runs in Workers and browsers)
const b64urlEncode = (s: string) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export const encodeToken = (t: Token) => b64urlEncode(JSON.stringify(t));
export function decodeToken(s: string): Token {
  const t = JSON.parse(b64urlDecode(s));
  if (t?.p === 'opensubtitles' && Number.isInteger(t.fileId)) return t;
  if (t?.p === 'subdl' && typeof t.url === 'string' && /^\/subtitle\/[\w.-]+\.zip$/.test(t.url)) return t;
  if (t?.p === 'stremio' && typeof t.url === 'string' && isStremioUrl(t.url)) return t;
  throw new Error('Invalid subtitle token');
}

const normLang = (l: string) => {
  const s = l.toLowerCase();
  if (s.startsWith('ar') || s === 'arabic') return 'ar';
  if (s.startsWith('en') || s === 'english') return 'en';
  return s.slice(0, 2);
};

async function searchOpenSubtitles(q: SubtitleSearch, key: string, ua: string): Promise<SubtitleTrackInfo[]> {
  const p = new URLSearchParams({ languages: (q.langs ?? ['ar', 'en']).join(','), order_by: 'download_count' });
  const imdbNum = q.imdbId?.replace(/^tt0*/, '');
  if (q.type === 'series' && imdbNum) {
    p.set('parent_imdb_id', imdbNum);
    if (q.season != null) p.set('season_number', String(q.season));
    if (q.episode != null) p.set('episode_number', String(q.episode));
  } else if (imdbNum) p.set('imdb_id', imdbNum);
  else if (q.tmdbId) p.set(q.type === 'series' ? 'parent_tmdb_id' : 'tmdb_id', String(q.tmdbId));
  else if (q.query || q.releaseName) p.set('query', (q.query || q.releaseName)!);
  else return [];

  const res = await fetch(`${OS_API}/subtitles?${p}`, {
    headers: { 'Api-Key': key, ...serverOnlyHeaders({ 'User-Agent': ua }), Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`OpenSubtitles ${res.status}`);
  const data = (await res.json()) as { data: any[] };
  return data.data.flatMap((d) => {
    const a = d.attributes;
    const file = a.files?.[0];
    if (!file) return [];
    const lang = normLang(a.language);
    const releaseName = a.release || file.file_name;
    return [{
      id: `os-${file.file_id}`,
      provider: 'opensubtitles' as const,
      lang,
      label: `${lang.toUpperCase()} · ${releaseName}`,
      releaseName,
      downloads: a.download_count,
      hearingImpaired: a.hearing_impaired,
      score: releaseSimilarity(releaseName, q.releaseName),
      token: encodeToken({ p: 'opensubtitles', fileId: file.file_id, lang }),
    }];
  });
}

async function searchSubDL(q: SubtitleSearch, key: string): Promise<SubtitleTrackInfo[]> {
  const p = new URLSearchParams({
    api_key: key,
    languages: (q.langs ?? ['ar', 'en']).map((l) => l.toUpperCase()).join(','),
    subs_per_page: '30',
  });
  if (q.imdbId) p.set('imdb_id', q.imdbId);
  else if (q.tmdbId) p.set('tmdb_id', String(q.tmdbId));
  else if (q.query || q.releaseName) p.set('film_name', (q.query || q.releaseName)!);
  else return [];
  if (q.type) p.set('type', q.type === 'series' ? 'tv' : 'movie');
  if (q.season != null) p.set('season_number', String(q.season));
  if (q.episode != null) p.set('episode_number', String(q.episode));

  const res = await fetch(`${SUBDL_API}?${p}`, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`SubDL ${res.status}`);
  const data = (await res.json()) as { status: boolean; subtitles?: any[]; error?: string };
  if (!data.status) return [];
  return (data.subtitles ?? []).map((s, i) => {
    const lang = normLang(s.lang ?? s.language ?? '');
    const releaseName: string = s.release_name ?? s.name;
    return {
      id: `subdl-${i}-${s.url}`,
      provider: 'subdl' as const,
      lang,
      label: `${lang.toUpperCase()} · ${releaseName}`,
      releaseName,
      hearingImpaired: !!s.hi,
      score: releaseSimilarity(releaseName, q.releaseName),
      token: encodeToken({ p: 'subdl', url: s.url, lang, season: q.season, episode: q.episode }),
    };
  });
}

const LANG3: Record<string, string> = { ara: 'ar', eng: 'en', ar: 'ar', en: 'en' };

async function searchStremio(q: SubtitleSearch): Promise<SubtitleTrackInfo[]> {
  if (!q.imdbId) return [];
  const series = q.type === 'series' && q.season != null && q.episode != null;
  const id = series ? `${q.imdbId}:${q.season}:${q.episode}` : q.imdbId;
  const res = await fetch(`${STREMIO_SUBS}/subtitles/${series ? 'series' : 'movie'}/${id}.json`, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`OpenSubtitles feed ${res.status}`);
  const data = (await res.json()) as { subtitles?: { id?: string; url?: string; lang?: string }[] };
  const wanted = q.langs ?? ['ar', 'en'];
  const perLang: Record<string, number> = {};
  const out: SubtitleTrackInfo[] = [];
  for (const s of data.subtitles ?? []) {
    const lang = LANG3[(s.lang ?? '').toLowerCase()];
    if (!lang || !wanted.includes(lang) || !s.url || !isStremioUrl(s.url)) continue;
    const n = (perLang[lang] = (perLang[lang] ?? 0) + 1);
    if (n > 8) continue; // the feed is ordered best-first; a handful per language is plenty
    out.push({
      id: `st-${s.id ?? `${lang}${n}`}`,
      provider: 'opensubtitles',
      lang,
      label: `${lang.toUpperCase()} · OpenSubtitles #${n}`,
      releaseName: `OpenSubtitles #${n}`,
      // No release names in this feed: keep the feed's own order via a tiny descending score.
      score: 0.01 / n,
      token: encodeToken({ p: 'stremio', url: s.url, lang }),
    });
  }
  return out;
}

export async function searchSubtitles(q: SubtitleSearch, keys: SubtitleKeys) {
  // No IMDB id (raw torrent result)? Look the title up in the keyless catalog.
  if (!q.imdbId && !q.tmdbId) {
    const parsed = q.releaseName ? parseRelease(q.releaseName) : undefined;
    const title = q.releaseName ? titleFromRelease(q.releaseName) : q.query;
    const type = q.type ?? (parsed?.season != null ? 'series' : 'movie');
    if (title) {
      const imdbId = await cinemeta.findImdbId(title, type, type === 'movie' ? parsed?.year : undefined).catch(() => undefined);
      if (imdbId) q = { ...q, imdbId, type, season: q.season ?? parsed?.season, episode: q.episode ?? parsed?.episode };
    }
  }
  const jobs: [string, Promise<SubtitleTrackInfo[]>][] = [['opensubtitles-feed', searchStremio(q)]];
  if (keys.openSubtitles) jobs.push(['opensubtitles', searchOpenSubtitles(q, keys.openSubtitles, keys.userAgent || DEFAULT_UA)]);
  if (keys.subdl) jobs.push(['subdl', searchSubDL(q, keys.subdl)]);
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const tracks: SubtitleTrackInfo[] = [];
  const errors: { provider: string; message: string }[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') tracks.push(...s.value);
    else errors.push({ provider: jobs[i][0], message: describeError(s.reason) });
  });
  if (!tracks.length && !errors.length) errors.push({ provider: 'subtitles', message: q.imdbId ? 'No Arabic or English subtitles found for this title.' : 'Could not identify this title to look up subtitles.' });
  tracks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.downloads ?? 0) - (a.downloads ?? 0));
  return { tracks, errors };
}

/** Download + decode + parse a subtitle file into cues. */
export async function fetchSubtitleCues(tokenStr: string, keys: SubtitleKeys): Promise<SubtitleCue[]> {
  const token = decodeToken(tokenStr);
  let bytes: Uint8Array;

  if (token.p === 'stremio') {
    const res = await fetch(token.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Subtitle download ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } else if (token.p === 'opensubtitles') {
    if (!keys.openSubtitles) throw new Error('OpenSubtitles key missing');
    const dl = await fetch(`${OS_API}/download`, {
      method: 'POST',
      headers: { 'Api-Key': keys.openSubtitles, ...serverOnlyHeaders({ 'User-Agent': keys.userAgent || DEFAULT_UA }), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ file_id: token.fileId, sub_format: 'srt' }),
      signal: AbortSignal.timeout(9000),
    });
    if (!dl.ok) throw new Error(`OpenSubtitles download ${dl.status}`);
    const { link } = (await dl.json()) as { link: string };
    bytes = new Uint8Array(await (await fetch(link, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
  } else {
    const zip = new Uint8Array(await (await fetch(SUBDL_DL + token.url, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
    const files = Object.entries(unzipSync(zip)).filter(([n]) => /\.(srt|vtt)$/i.test(n));
    if (!files.length) throw new Error('No .srt in archive');
    let pick = files[0];
    if (token.season != null && token.episode != null) {
      const re = new RegExp(`s0?${token.season}[ ._-]?e0?${token.episode}(?!\\d)|\\b${token.season}x0?${token.episode}(?!\\d)`, 'i');
      pick = files.find(([n]) => re.test(n)) ?? pick;
    }
    bytes = pick[1];
  }
  return parseSubtitles(decodeSubtitleBytes(bytes, token.lang));
}
