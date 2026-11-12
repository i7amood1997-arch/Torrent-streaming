'use client';
/**
 * Browser WebTorrent engine (desktop Chromium/Firefox). Streams pieces from
 * WebRTC peers and serves them to <video> through the service worker
 * (/sw.js imports WebTorrent's sw.min.js which proxies /webtorrent/* URLs).
 *
 * Only peers that speak WebRTC (WebTorrent desktop, other browsers, hybrid
 * clients) are reachable — plain TCP/UDP BitTorrent swarms are not.
 */
import { asset, BASE_PATH } from './config';
import { pickFileForPlayback } from './webtorrent-pick';

const VENDOR = asset('/vendor/webtorrent/webtorrent.min.js');

export interface WebTorrentStats {
  progress: number; // 0..1
  downloadSpeed: number; // bytes/s
  uploadSpeed: number;
  numPeers: number;
}

export interface WebTorrentSession {
  url: string;
  fileName: string;
  destroy: () => void;
}

let clientPromise: Promise<any> | null = null;

async function getClient(): Promise<any> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const mod = await import(/* webpackIgnore: true */ VENDOR as string);
    const WebTorrent = mod.default;
    const client = new WebTorrent();
    const reg = await navigator.serviceWorker.register(asset('/sw.js'), { scope: `${BASE_PATH}/` });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // First install: wait until the SW claims this page.
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    }
    client.createServer({ controller: reg });
    client.on('error', (e: Error) => console.warn('[webtorrent]', e));
    return client;
  })();
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

export async function startWebTorrent(
  magnet: string,
  opts: { fileIdx?: number; season?: number; episode?: number; onStats?: (s: WebTorrentStats) => void; signal?: AbortSignal },
): Promise<WebTorrentSession> {
  const client = await getClient();
  const existing = await client.get(magnet);
  const torrent: any = existing ?? client.add(magnet, { destroyStoreOnDestroy: true });

  await new Promise<void>((resolve, reject) => {
    if (torrent.ready) return resolve();
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    torrent.once('ready', () => { opts.signal?.removeEventListener('abort', onAbort); resolve(); });
    torrent.once('error', reject);
  });

  const files: any[] = torrent.files;
  const file = pickFileForPlayback(files.map((f, index) => ({ index, name: f.name, size: f.length })), opts.fileIdx, opts.season, opts.episode);
  const target = files[file?.index ?? 0];
  // Prioritise only the file we play.
  files.forEach((f) => (f === target ? f.select() : f.deselect()));

  const timer = setInterval(() => {
    opts.onStats?.({ progress: target.progress, downloadSpeed: torrent.downloadSpeed, uploadSpeed: torrent.uploadSpeed, numPeers: torrent.numPeers });
  }, 1000);

  return {
    url: target.streamURL,
    fileName: target.name,
    destroy: () => {
      clearInterval(timer);
      try { torrent.destroy(); } catch { /* already gone */ }
    },
  };
}
