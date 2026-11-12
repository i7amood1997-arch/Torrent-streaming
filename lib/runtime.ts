/**
 * The API code (lib/server/handlers.ts and the libs it uses) runs in two places:
 *  - "Direct mode": inside the browser on GitHub Pages, calling services directly
 *  - Optional backend: a Cloudflare Worker, for services that block browser requests
 */
export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * Headers only a server should send. In the browser a custom User-Agent would
 * force a CORS preflight that many APIs reject, and the browser sends its own anyway.
 */
export function serverOnlyHeaders(h: Record<string, string>): Record<string, string> {
  return isBrowser ? {} : h;
}

/** Human-readable error; explains browser CORS blocks (fetch throws a bare TypeError). */
export function describeError(e: unknown): string {
  if (isBrowser && e instanceof TypeError) {
    return "blocked by the browser — this service doesn't allow direct access from websites";
  }
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message;
  return String(e);
}
