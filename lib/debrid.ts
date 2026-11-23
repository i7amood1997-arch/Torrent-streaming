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
  return { realdebrid: env.REALDEBRID_API_KEY, torbox: env.TORBOX_API_KEY, debridlink: env.DEBRIDLINK_API_KEY, premiumize: env.PREMIUMIZE_API_KEY, alldebrid: env.ALLDEBRID_API_KEY }[p];
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
    throw new DebridError(explainDebridError(String(msg)), res.status, String(msg));
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
  /** The provider's own error code (e.g. `infringing_file`), when it sent one. */
  constructor(message: string, public status = 502, public code?: string) {
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

  try {
    return await finishRealDebrid(i, id, auth, formHeaders);
  } catch (e) {
    // A torrent Real-Debrid will never serve (copyright block, dead/broken torrent): remove it from
    // the account so the torrent list doesn't fill up with failures. Best effort; the original error wins.
    if (e instanceof DebridError && (e.code === 'infringing_file' || e.status === 451 || e.code === 'dead_torrent')) {
      await fetch(`${RD}/torrents/delete/${id}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
    throw e;
  }
}

async function finishRealDebrid(i: ResolveInput, id: string, auth: Record<string, string>, formHeaders: Record<string, string>): Promise<ResolvedStream> {
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
    if (['error', 'magnet_error', 'virus', 'dead'].includes(info.status)) throw new DebridError(`Real-Debrid: ${info.status}`, 502, 'dead_torrent');
    const seeders = typeof info.seeders === 'number' ? info.seeders : undefined;
    const speed = typeof info.speed === 'number' ? info.speed : undefined;
    const detail = info.status === 'downloading' ? ` ${Math.round(info.progress ?? 0)}%${seeders !== undefined ? ` · ${seeders} seeder${seeders === 1 ? '' : 's'}` : ''}${speed ? ` · ${(speed / 1048576).toFixed(1)} MB/s` : ''}` : '';
    return { status: 'queued', progress: info.progress ?? 0, seeders, speed, message: `Real-Debrid: ${info.status}${detail}`, provider: 'realdebrid' };
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

// ─── Premiumize ─────────────────────────────────────────────────────────────
// https://www.premiumize.me/api — the account's API key goes in ?apikey=.

const PM = 'https://www.premiumize.me/api/';

async function pm<T>(endpoint: string, apiKey: string, params: Record<string, string> = {}, form?: Record<string, string>): Promise<T> {
  const u = new URL(PM + endpoint);
  for (const [k, v] of Object.entries({ ...params, apikey: apiKey })) u.searchParams.append(k, v);
  const body = await http<any>(u.toString(), form ? { method: 'POST', body: new URLSearchParams(form) } : {});
  if (body?.status === 'error') throw new DebridError(explainDebridError(String(body.message ?? 'Premiumize error')), 400, body.message);
  return body as T;
}

async function resolvePremiumize(i: ResolveInput): Promise<ResolvedStream> {
  // Cached: the files' direct links at once.
  const dl = await pm<{ content?: { path?: string; size?: number; link?: string; stream_link?: string }[] }>('transfer/directdl', i.apiKey, {}, { src: i.magnet })
    .catch((e) => { if (e instanceof DebridError && (e.status === 401 || /api ?key|auth|customer/i.test(e.message))) throw e; return undefined; });
  const content = dl?.content?.filter((c) => c.link) ?? [];
  if (content.length) {
    const files = content.map((c, idx) => ({ index: idx, id: idx, name: (c.path ?? '').split('/').pop() || `file${idx}`, size: c.size ?? 0, link: c.link!, stream: c.stream_link }));
    const chosen = pickFile(files, undefined, i.season, i.episode);
    if (!chosen) throw new DebridError('No playable file in torrent', 404);
    return { status: 'ready', url: chosen.link, fileName: chosen.name, mimeType: mimeFromName(chosen.name), provider: 'premiumize' };
  }
  // Not cached: download it to the cloud and report progress (the app asks again).
  const list = await pm<{ transfers?: { id: string; name?: string; src?: string; status?: string; progress?: number; message?: string }[] }>('transfer/list', i.apiKey);
  const t = list.transfers?.find((x) => (x.src ?? '').toLowerCase().includes(i.infoHash));
  if (!t) {
    await pm('transfer/create', i.apiKey, {}, { src: i.magnet });
    return { status: 'queued', progress: 0, message: 'Premiumize: added to your cloud', provider: 'premiumize' };
  }
  if (t.status === 'error' || t.status === 'deleted') throw new DebridError(t.message || 'Premiumize couldn’t download this torrent.');
  return { status: 'queued', progress: Math.round((t.progress ?? 0) * 100), message: `Premiumize: ${t.message || t.status || 'downloading'}`, provider: 'premiumize' };
}

// ─── AllDebrid ──────────────────────────────────────────────────────────────
// https://docs.alldebrid.com — key as a Bearer token; every call names the app (agent).

const AD = 'https://api.alldebrid.com';
const AD_AGENT = 'streamdeck';

async function ad<T>(path: string, apiKey: string, params: Record<string, string> = {}, form?: Record<string, string>): Promise<T> {
  const u = new URL(AD + path);
  for (const [k, v] of Object.entries({ ...params, agent: AD_AGENT })) u.searchParams.append(k, v);
  const body = await http<any>(u.toString(), { method: form ? 'POST' : 'GET', headers: { Authorization: `Bearer ${apiKey}` }, body: form ? new URLSearchParams(form) : undefined });
  if (body?.status === 'error') {
    const code = String(body.error?.code ?? 'ERROR');
    throw new DebridError(explainDebridError(ALLDEBRID_ERRORS[code] ?? body.error?.message ?? code), /AUTH/.test(code) ? 401 : 400, code);
  }
  return body?.data as T;
}

const ALLDEBRID_ERRORS: Record<string, string> = {
  AUTH_BAD_APIKEY: 'bad_token',
  AUTH_MISSING_APIKEY: 'bad_token',
  AUTH_BLOCKED: 'AllDebrid blocked this connection (VPN or server address). Try without a VPN, or unblock it in your AllDebrid account.',
  MUST_BE_PREMIUM: 'permission_denied',
  MAGNET_TOO_MANY_ACTIVE: 'too_many_requests',
};

interface AdNode { n: string; s?: number; l?: string; e?: AdNode[] }

/** AllDebrid lists files as a tree (folders hold `e`): flatten it in order. */
export function flattenAllDebrid(nodes: AdNode[] | undefined, prefix = ''): { name: string; size: number; link: string }[] {
  const out: { name: string; size: number; link: string }[] = [];
  for (const n of nodes ?? []) {
    if (n.e) out.push(...flattenAllDebrid(n.e, `${prefix}${n.n}/`));
    else if (n.l) out.push({ name: n.n, size: n.s ?? 0, link: n.l });
  }
  return out;
}

async function resolveAllDebrid(i: ResolveInput): Promise<ResolvedStream> {
  const up = await ad<{ magnets?: { id?: number; ready?: boolean; error?: { code?: string; message?: string } }[] }>('/v4/magnet/upload', i.apiKey, {}, { 'magnets[]': i.magnet });
  const m = up?.magnets?.[0];
  if (!m || m.error || m.id == null) throw new DebridError(m?.error?.message ?? 'AllDebrid couldn’t add this torrent.', 400, m?.error?.code);
  if (!m.ready) {
    const st = await ad<{ magnets?: { status?: string; statusCode?: number; size?: number; downloaded?: number } }>('/v4.1/magnet/status', i.apiKey, { id: String(m.id) }).catch(() => undefined);
    const s = st?.magnets;
    if (s?.statusCode != null && s.statusCode > 4) throw new DebridError(`AllDebrid: ${s.status ?? 'error'}`);
    if (s?.statusCode !== 4) return { status: 'queued', progress: s?.size ? Math.round(((s.downloaded ?? 0) / s.size) * 100) : 0, message: `AllDebrid: ${s?.status ?? 'downloading'}`, provider: 'alldebrid' };
  }
  const f = await ad<{ magnets?: { files?: AdNode[] }[] }>('/v4/magnet/files', i.apiKey, { 'id[]': String(m.id) });
  const files = flattenAllDebrid(f?.magnets?.[0]?.files).map((x, idx) => ({ ...x, index: idx, id: idx }));
  const chosen = pickFile(files, undefined, i.season, i.episode);
  if (!chosen) throw new DebridError('No playable file in torrent', 404);
  const un = await ad<{ link?: string; filename?: string }>('/v4/link/unlock', i.apiKey, { link: chosen.link });
  if (!un?.link) throw new DebridError('AllDebrid didn’t return a link for this file.');
  const name = un.filename ?? chosen.name;
  return { status: 'ready', url: un.link, fileName: name, mimeType: mimeFromName(name), provider: 'alldebrid' };
}

// ─── Entry point ────────────────────────────────────────────────────────────

const RESOLVERS: Record<DebridProvider, (i: ResolveInput) => Promise<ResolvedStream>> = {
  realdebrid: resolveRealDebrid,
  torbox: resolveTorBox,
  debridlink: resolveDebridLink,
  premiumize: resolvePremiumize,
  alldebrid: resolveAllDebrid,
};

export async function resolveDebridStream(input: ResolveInput): Promise<ResolvedStream> {
  if (!input.apiKey) throw new DebridError(`No API key configured for ${input.provider}`, 401);
  const r = await RESOLVERS[input.provider](input);
  if (r.status === 'ready' && r.mimeType === 'video/x-matroska' && !r.hlsUrl) {
    r.message = 'MKV container: iOS Safari cannot play MKV directly. Prefer an MP4 release on iPhone/iPad.';
  }
  return r;
}

// ─── "Will it start instantly?" ─────────────────────────────────────────────

export interface CacheCheckItem { infoHash: string; magnet: string; fileIdx?: number; season?: number; episode?: number }
export type CacheState = 'instant' | 'not' | 'unknown';

/**
 * Real-Debrid no longer answers "is this cached?" directly (instantAvailability was removed in
 * 2024). The usual check: add the torrent, choose the file, and see if it is ready at once. Ready
 * ones stay in the account (Play then reuses them); the others are deleted straight away.
 */
export async function checkRealDebridCache(apiKey: string, items: CacheCheckItem[]): Promise<Record<string, CacheState>> {
  const auth = { Authorization: `Bearer ${apiKey}` };
  const formHeaders = { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' };
  const out: Record<string, CacheState> = {};
  const existing = await http<any[]>(`${RD}/torrents?limit=100`, { headers: auth }).catch(() => [] as any[]);
  const byHash = new Map<string, any>((existing ?? []).map((t: any) => [String(t.hash ?? '').toLowerCase(), t]));
  await Promise.all(items.slice(0, 6).map(async (it) => {
    const hash = it.infoHash.toLowerCase();
    const known = byHash.get(hash);
    if (known) { out[hash] = known.status === 'downloaded' ? 'instant' : 'not'; return; }
    let id: string | undefined;
    try {
      id = (await http<{ id: string }>(`${RD}/torrents/addMagnet`, { method: 'POST', headers: formHeaders, body: new URLSearchParams({ magnet: it.magnet }) })).id;
      let info = await http<any>(`${RD}/torrents/info/${id}`, { headers: auth });
      if (info.status === 'magnet_conversion') { await new Promise((r) => setTimeout(r, 1500)); info = await http<any>(`${RD}/torrents/info/${id}`, { headers: auth }); }
      if (info.status === 'waiting_files_selection') {
        const files: FileLike[] = (info.files ?? []).map((f: any, idx: number) => ({ index: idx, id: f.id, name: f.path, size: f.bytes }));
        const chosen = pickFile(files, it.fileIdx, it.season, it.episode);
        await http(`${RD}/torrents/selectFiles/${id}`, { method: 'POST', headers: formHeaders, body: new URLSearchParams({ files: chosen ? String(chosen.id) : 'all' }) });
        info = await http<any>(`${RD}/torrents/info/${id}`, { headers: auth });
      }
      out[hash] = info.status === 'downloaded' ? 'instant' : 'not';
    } catch {
      out[hash] = 'unknown';
    }
    if (id && out[hash] !== 'instant') await fetch(`${RD}/torrents/delete/${id}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }));
  return out;
}
