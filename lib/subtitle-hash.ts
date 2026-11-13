/**
 * OpenSubtitles "moviehash": file size + the 64-bit little-endian word sum of the
 * first and last 64 KiB, modulo 2^64, as 16 hex digits. Subtitles found by this
 * hash were timed against the identical file, so they're in sync by construction.
 */

const CHUNK = 65536;

export function openSubtitlesHash(head: Uint8Array, tail: Uint8Array, size: number): string {
  const mask = (1n << 64n) - 1n;
  let sum = BigInt(size) & mask;
  for (const buf of [head, tail]) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const words = Math.floor(buf.byteLength / 8);
    for (let i = 0; i < words; i++) sum = (sum + dv.getBigUint64(i * 8, true)) & mask;
  }
  return sum.toString(16).padStart(16, '0');
}

async function readRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; total?: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (res.status !== 206) {
    res.body?.cancel().catch(() => undefined);
    throw new Error(`no range support (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get('content-range')?.split('/')[1]) || undefined;
  return { bytes: new Uint8Array(await res.arrayBuffer()), total };
}

/**
 * Hash a remote video with two small Range requests. Tries each URL in turn
 * (e.g. the link itself, then the relay copy when the host doesn't allow CORS).
 */
export async function hashRemoteVideo(urls: (string | undefined)[], signal?: AbortSignal): Promise<{ hash: string; size: number } | undefined> {
  for (const url of urls) {
    if (!url) continue;
    try {
      const first = await readRange(url, 0, CHUNK - 1, signal);
      const size = first.total;
      if (!size || size < CHUNK * 2) continue;
      const last = await readRange(url, size - CHUNK, size - 1, signal);
      if (first.bytes.length !== CHUNK || last.bytes.length !== CHUNK) continue;
      return { hash: openSubtitlesHash(first.bytes, last.bytes, size), size };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  return undefined;
}
