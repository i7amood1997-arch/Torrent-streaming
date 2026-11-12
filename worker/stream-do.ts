/**
 * Built-in cloud streaming: one Durable Object per torrent (named by info-hash)
 * runs a download-only BitTorrent session (lib/bt) over Cloudflare's outbound TCP
 * sockets and serves the chosen file as a normal HTTP video with Range support.
 *
 *   POST /api/stream/<hash>/prepare  { trackers, fileIdx?, season?, episode? }
 *        → { status: 'ready', fileIdx, fileName, size, mime, path } | { status: 'pending', stats }
 *   GET  /api/stream/<hash>/file/<idx>/<name>   (Range supported) → video bytes
 *   GET  /api/stream/<hash>/status → stats (the app pings this while playing; every
 *        incoming request refills the session's connection budget)
 *
 * Nothing is written to disk; pieces live in memory only while they're being watched.
 */
import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { mimeFor, parseRange } from '../lib/bt/http';
import { TorrentSession } from '../lib/bt/session';
import { trackerList } from '../lib/bt/tracker';
import type { TorrentFile, TorrentInfo } from '../lib/bt/bencode';
import { pickFileForPlayback } from '../lib/webtorrent-pick';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

interface StreamEnv {
  BT_TRACKERS?: string;
}

export class TorrentStream extends DurableObject<StreamEnv> {
  private session?: TorrentSession;
  private loading?: Promise<TorrentSession>;

  private getSession(hash: string, magnetTrackers: string[] = []): Promise<TorrentSession> {
    if (this.session) {
      if (magnetTrackers.length) this.session.addTrackers(trackerList(magnetTrackers));
      return Promise.resolve(this.session);
    }
    this.loading ??= (async () => {
      // Restore what an earlier (evicted) instance learned, so playback can resume quickly.
      const stored = await this.ctx.storage.get<{ trackers: string[]; info?: Uint8Array }>('torrent').catch(() => undefined);
      const extra = (this.env.BT_TRACKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const trackers = trackerList([...magnetTrackers, ...(stored?.trackers ?? [])], extra);
      const save = (info?: Uint8Array) =>
        this.ctx.storage.put('torrent', { trackers: [...magnetTrackers, ...(stored?.trackers ?? [])].slice(0, 40), info }).catch(() => undefined);
      if (magnetTrackers.length && !stored) save();
      this.session = new TorrentSession({
        infoHash: hash,
        trackers,
        connect: (host, port) => connect({ hostname: host, port }),
        infoBytes: stored?.info,
        onInfo: (raw) => { if (raw.length < 1_900_000) save(raw); },
      });
      return this.session;
    })();
    return this.loading;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'stream', hash, action, ...]
    const hash = parts[2];
    const action = parts[3];
    try {
      if (action === 'prepare' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { trackers?: string[]; fileIdx?: number; season?: number; episode?: number };
        const trackers = Array.isArray(body.trackers) ? body.trackers.filter((t) => typeof t === 'string').slice(0, 40) : [];
        const session = await this.getSession(hash, trackers);
        session.touch();
        const info = await session.waitForInfo(20_000);
        if (!info) return json({ status: 'pending', stats: session.stats() });
        const file = chooseFile(info, body.fileIdx, body.season, body.episode);
        if (!file) return json({ status: 'error', message: 'No video file found in this torrent.' });
        return json({
          status: 'ready',
          fileIdx: file.index,
          fileName: file.name,
          size: file.length,
          mime: mimeFor(file.name),
          path: `/api/stream/${hash}/file/${file.index}/${encodeURIComponent(file.name)}`,
          stats: session.stats(),
        });
      }

      const session = await this.getSession(hash);
      session.touch();

      if (action === 'status') return json(session.stats());

      if (action === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
        const info = await session.waitForInfo(20_000);
        if (!info) return json({ error: 'Torrent metadata not available yet. Start playback from the app again.' }, 503);
        const file = info.files[Number(parts[4])];
        if (!file) return json({ error: 'No such file' }, 404);
        const range = parseRange(req.headers.get('range'), file.length);
        const headers: Record<string, string> = {
          'Content-Type': mimeFor(file.name),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        };
        if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${file.length}` } });
        const start = range?.start ?? 0;
        const end = range?.end ?? file.length - 1;
        headers['Content-Length'] = String(end - start + 1);
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.length}`;
        const status = range ? 206 : 200;
        if (req.method === 'HEAD' || file.length === 0) return new Response(null, { status, headers });
        return new Response(session.createStream(file, start, end), { status, headers });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: (e as Error).message ?? 'stream error' }, 500);
    }
  }
}

function chooseFile(info: TorrentInfo, fileIdx?: number, season?: number, episode?: number): TorrentFile | undefined {
  const picked = pickFileForPlayback(
    info.files.map((f) => ({ index: f.index, name: f.name, size: f.length })),
    Number.isInteger(fileIdx) ? fileIdx : undefined,
    Number.isInteger(season) ? season : undefined,
    Number.isInteger(episode) ? episode : undefined,
  );
  return picked ? info.files[picked.index] : undefined;
}
