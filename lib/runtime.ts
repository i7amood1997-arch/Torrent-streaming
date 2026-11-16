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

/**
 * `AbortSignal.timeout()` is missing in Safari before 16 (iOS 15: iPhone 6s/7, older iPads) and
 * every request with a time limit threw there, so the app couldn't even reach its relay. Give
 * those browsers the same behaviour. Called once when this module loads.
 */
export function ensureAbortTimeout(target: { timeout?: (ms: number) => AbortSignal } | undefined = typeof AbortSignal !== 'undefined' ? (AbortSignal as never) : undefined): void {
  if (!target || typeof target.timeout === 'function') return;
  target.timeout = (ms: number) => {
    const ctl = new AbortController();
    setTimeout(() => {
      let reason: unknown;
      try { reason = new DOMException('The operation timed out.', 'TimeoutError'); } catch { reason = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }); }
      ctl.abort(reason);
    }, ms);
    return ctl.signal;
  };
}
ensureAbortTimeout();
