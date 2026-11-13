/**
 * Debrid resolver: magnet / info-hash → direct HTTPS video URL.
 *
 * This is the primary engine for iOS Safari, which cannot do WebRTC torrenting
 * and needs plain HTTP(S) progressive MP4 or HLS. Each provider:
 *   1. adds the magnet to the user's cloud,
 *   2. picks the requested file (fileIdx) or the largest video file,
 *   3. returns an unrestricted direct link once the torrent is cached.
 *
 * If the torrent isn't cached yet, we return { status: 'queued', progress }
 * and the client polls /api/debrid/resolve again.
 *
 * SERVER ONLY (Cloudflare Worker) — API keys are passed per request (from the user's
 * Settings, via the `x-debrid-key` header) or fall back to Worker secrets.
 */
import type { DebridProvider, ResolvedStream } from './types';

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|wmv)$/i;
const SAMPLE = /\bsample\b|\btrailer\b/i;

export interface ResolveInput {
  provider: DebridProvider;
  apiKey: string;
  magnet: string;
  infoHash: string;
  /** Index into the torrent's file list (Torrentio fileIdx), if known. */
  fileIdx?: number;
  /** Season/episode used to pick a file from season packs when fileIdx is unknown. */
  season?: number;
  episode?: number;
}

export function envDebridKey(p: DebridProvider, env: Record<string, string | undefined>): string | undefined {
  return { realdebrid: env.REALDEBRID_API_KEY, torbox: env.TORBOX_API_KEY, debridlink: env.DEBRIDLINK_API_KEY }[p];
}

export function mimeFromName(name?: string): string | undefined {
  const ext = name?.split('.').pop()?.toLowerCase();
  return ext
    ? ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', avi: 'video/x-msvideo' } as Record<string, string>)[ext]
    : undefined;
}

interface FileLike {
  index: number;
  id: number | string;
  name: string;
  size: number;
}

/** Pick the file to play: explicit fileIdx → episode match → largest non-sample video. */
export function pickFile<T extends FileLike>(files: T[], fileIdx?: number, season?: number, episode?: number): T | undefined {
  const videos = files.filter((f) => VIDEO_EXT.test(f.name) && !SAMPLE.test(f.name));
  if (fileIdx != null) {
    const exact = files.find((f) => f.index === fileIdx);
    if (exact) return exact;
  }
  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const re = new RegExp(`(s${s}[ ._-]?e${e}|\\b${season}x${e})(?!\\d)`, 'i');
    const ep = videos.find((f) => re.test(f.name));
    if (ep) return ep;
  }
  return [...(videos.length ? videos : files)].sort((a, b) => b.size - a.size)[0];
}

async function http<T>(url: string, init: RequestInit & { timeout?: number } = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? 15000) });
  const text = await res.text();
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error ?? body?.detail ?? body?.message ?? (typeof body === 'string' ? body.slice(0, 200) : `HTTP ${res.status}`);
    throw new DebridError(explainDebridError(String(msg)), res.status);
  }
  return body as T;
}

/** Human-readable text for common Debrid API error codes. */
export function explainDebridError(code: string): string {
  const known: Record<string, string> = {
    infringing_file: 'Real-Debrid has blocked this file after a copyright complaint, so it won’t stream it.',
    bad_token: 'Your Debrid API key isn’t valid. Copy it again from the provider’s website into Settings.',
    permission_denied: 'Your Debrid account can’t do this. Check that your subscription is active.',
    ip_not_allowed: 'Real-Debrid refused this connection (VPN or server address). Try without a VPN.',
    too_many_requests: 'The Debrid service is rate-limiting requests. Wait a minute and try again.',
    torrent_too_big: 'This torrent is too big for your Debrid account.',
  };
  return known[code] ?? code;
}

export class DebridError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

// ─── Real-Debrid ────────────────────────────────────────────────────────────
// https://api.real-debrid.com/

const RD = 'https://api.real-debrid.com/rest/1.0';

async function resolveRealDebrid(i: ResolveInput): Promise<ResolvedStream> {
  const auth = { Authorization: `Bearer ${i.apiKey}` };
  const formHeaders = { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' };

  // Reuse an existing torrent with the same hash to avoid piling duplicates in the user's account.
  const existing = await http<any[]>(`${RD}/torrents?limit=100`, { headers: auth }).catch(() => []);
  let id: string | undefined = existing?.find?.((t) => t.hash?.toLowerCase() === i.infoHash)?.id;
  if (!id) {
    const added = await http<{ id: string }>(`${RD}/torrents/addMagnet`, {
      method: 'POST', headers: formHeaders, body: new URLSearchParams({ magnet: i.magnet }),
    });
    id = added.id;
  }

  let info = await http<any>(`${RD}/torrents/info/${id}`, { headers: auth });
  if (info.status === 'waiting_files_selection') {
    const files: FileLike[] = info.files.map((f: any, idx: number) => ({ index: idx, id: f.id, name: f.path, size: f.bytes }));
    const chosen = pickFile(files, i.fileIdx, i.season, i.episode);
    await http(`${RD}/torrents/selectFiles/${id}`, {
      method: 'POST', headers: formHeaders, body: new URLSearchParams({ files: chosen ? String(chosen.id) : 'all' }),
    });
    info = await http<any>(`${RD}/torrents/info/${id}`, { headers: auth });
  }

  if (info.status !== 'downloaded') {
    if (['error', 'magnet_error', 'virus', 'dead'].includes(info.status)) return { status: 'error', message: `Real-Debrid: ${info.status}`, provider: 'realdebrid' };
    return { status: 'queued', progress: info.progress ?? 0, message: `Real-Debrid: ${info.status}`, provider: 'realdebrid' };
  }

  // `links` only lists selected files, in order. Map the chosen selected file to its link.
  const selected = (info.files as any[]).filter((f) => f.selected === 1);
  const files: FileLike[] = selected.map((f, idx) => ({ index: info.files.indexOf(f), id: idx, name: f.path, size: f.bytes }));
  const chosen = pickFile(files, i.fileIdx, i.season, i.episode);
  const link = info.links[chosen ? Number(chosen.id) : 0] ?? info.links[0];
  const un = await http<{ id: string; download: string; filename: string; mimeType?: string; streamable?: number }>(`${RD}/unrestrict/link`, {
    method: 'POST', headers: formHeaders, body: new URLSearchParams({ link }),
  });
  // Real-Debrid can transcode streamable files to HLS — this is what makes MKV/HEVC playable on iOS Safari.
  let hlsUrl: string | undefined;
  if (un.streamable) {
    const tc = await http<{ apple?: { full?: string } }>(`${RD}/streaming/transcode/${un.id}`, { headers: auth }).catch(() => undefined);
    hlsUrl = tc?.apple?.full;
  }
  return { status: 'ready', url: un.download, hlsUrl, fileName: un.filename, mimeType: un.mimeType ?? mimeFromName(un.filename), provider: 'realdebrid' };
}

// ─── TorBox ─────────────────────────────────────────────────────────────────
// https://api-docs.torbox.app/

const TB = 'https://api.torbox.app/v1/api';

async function resolveTorBox(i: ResolveInput): Promise<ResolvedStream> {
  const auth = { Authorization: `Bearer ${i.apiKey}` };
  const list = await http<{ data?: any[] }>(`${TB}/torrents/mylist?bypass_cache=true`, { headers: auth }).catch(() => ({ data: [] as any[] }));
  let torrent = list.data?.find((t) => t.hash?.toLowerCase() === i.infoHash);

  if (!torrent) {
    const fd = new FormData();
    fd.set('magnet', i.magnet);
    fd.set('seed', '3');
    fd.set('allow_zip', 'false');
    const created = await http<{ data?: { torrent_id?: number } }>(`${TB}/torrents/createtorrent`, { method: 'POST', headers: auth, body: fd });
    const tid = created.data?.torrent_id;
    if (!tid) return { status: 'queued', progress: 0, message: 'TorBox: queued', provider: 'torbox' };
    torrent = (await http<{ data: any }>(`${TB}/torrents/mylist?id=${tid}&bypass_cache=true`, { headers: auth })).data;
  }

  const ready = torrent?.download_finished || torrent?.download_present;
  if (!ready) {
    return { status: 'queued', progress: Math.round((torrent?.progress ?? 0) * 100), message: `TorBox: ${torrent?.download_state ?? 'downloading'}`, provider: 'torbox' };
  }
  const files: FileLike[] = (torrent.files ?? []).map((f: any, idx: number) => ({ index: idx, id: f.id, name: f.short_name ?? f.name, size: f.size }));
  const chosen = pickFile(files, i.fileIdx, i.season, i.episode);
  const q = new URLSearchParams({ token: i.apiKey, torrent_id: String(torrent.id), file_id: String(chosen?.id ?? 0) });
  const dl = await http<{ data: string }>(`${TB}/torrents/requestdl?${q}`, { headers: auth });
  return { status: 'ready', url: dl.data, fileName: chosen?.name, mimeType: mimeFromName(chosen?.name), provider: 'torbox' };
}

// ─── Debrid-Link ────────────────────────────────────────────────────────────
// https://debrid-link.com/api_doc/v2

const DL = 'https://debrid-link.com/api/v2';

async function resolveDebridLink(i: ResolveInput): Promise<ResolvedStream> {
  const res = await http<{ success: boolean; value?: any; error?: string }>(`${DL}/seedbox/add`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${i.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: i.magnet, async: true }),
  });
  if (!res.success || !res.value) throw new DebridError(res.error ?? 'Debrid-Link error');
  const v = res.value;
  if ((v.downloadPercent ?? 0) < 100) return { status: 'queued', progress: Math.round(v.downloadPercent ?? 0), message: 'Debrid-Link: caching', provider: 'debridlink' };
  const files: (FileLike & { downloadUrl: string })[] = (v.files ?? []).map((f: any, idx: number) => ({ index: idx, id: f.id, name: f.name, size: f.size, downloadUrl: f.downloadUrl }));
  const chosen = pickFile(files, i.fileIdx, i.season, i.episode);
  if (!chosen) throw new DebridError('No playable file in torrent', 404);
  return { status: 'ready', url: chosen.downloadUrl, fileName: chosen.name, mimeType: mimeFromName(chosen.name), provider: 'debridlink' };
}

// ─── Entry point ────────────────────────────────────────────────────────────

const RESOLVERS: Record<DebridProvider, (i: ResolveInput) => Promise<ResolvedStream>> = {
  realdebrid: resolveRealDebrid,
  torbox: resolveTorBox,
  debridlink: resolveDebridLink,
};

export async function resolveDebridStream(input: ResolveInput): Promise<ResolvedStream> {
  if (!input.apiKey) throw new DebridError(`No API key configured for ${input.provider}`, 401);
  const r = await RESOLVERS[input.provider](input);
  if (r.status === 'ready' && r.mimeType === 'video/x-matroska' && !r.hlsUrl) {
    r.message = 'MKV container: iOS Safari cannot play MKV directly. Prefer an MP4 release on iPhone/iPad.';
  }
  return r;
}
