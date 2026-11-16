/**
 * Waiting for a debrid service to fetch a torrent it doesn't have yet. When nobody is sharing the
 * torrent, the service sits at 0% for ever: say so after a short while instead of a spinner that
 * never ends.
 */
export interface DebridProgress { at: number; progress?: number; seeders?: number; speed?: number }

const NO_PEERS_MS = 45_000; // the service reports nobody sharing it and nothing has moved
const NO_PROGRESS_MS = 120_000; // nothing has moved and the service doesn't say why

export function debridStalled(history: DebridProgress[], provider: string): string | undefined {
  if (history.length < 2) return undefined;
  const last = history[history.length - 1];
  const progressed = (since: number) => {
    const span = history.filter((h) => h.at >= since);
    const p = span.map((h) => h.progress ?? 0);
    return Math.max(...p) - Math.min(...p) >= 0.5 || span.some((h) => (h.speed ?? 0) > 0);
  };
  const waited = last.at - history[0].at;
  if (waited >= NO_PEERS_MS && last.seeders === 0 && !progressed(last.at - NO_PEERS_MS)) {
    return `${provider} doesn’t have this file yet, and nobody is sharing it right now (0 seeders), so it can’t download it. Pick another stream — one with more seeders.`;
  }
  if (waited >= NO_PROGRESS_MS && !progressed(last.at - NO_PROGRESS_MS)) {
    return `${provider} hasn’t been able to download this file (stuck at ${Math.round(last.progress ?? 0)}% for 2 minutes). Pick another stream — one with more seeders.`;
  }
  return undefined;
}
