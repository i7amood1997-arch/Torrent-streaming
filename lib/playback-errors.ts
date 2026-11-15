/**
 * The <video> element reports "source not supported" (code 4) both when the format can't be
 * decoded and when the link itself is dead (404, expired debrid link). Asking the server tells
 * the two apart, so the user isn't told to pick another format when the link just expired.
 * Returns a message for a dead link, or undefined when the link answers (or can't be checked).
 */
export async function deadLinkMessage(url: string, fetchFn: typeof fetch = fetch, timeoutMs = 6000): Promise<string | undefined> {
  if (!/^https?:/i.test(url)) return undefined; // blob:/data: — nothing to ask
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { headers: { Range: 'bytes=0-0' }, signal: ctl.signal });
    r.body?.cancel().catch(() => {});
    if (r.ok || r.type === 'opaque' || r.status === 0) return undefined;
    if (r.status === 404 || r.status === 410) return `This video link no longer exists (HTTP ${r.status}). Go back and pick another stream.`;
    if (r.status === 401 || r.status === 403) return `The host refused this video link (HTTP ${r.status}). It may have expired — go back and pick the stream again.`;
    return `The video host answered with an error (HTTP ${r.status}). Try again in a moment or pick another stream.`;
  } catch {
    return undefined; // network/CORS: can't tell, keep the browser's own reason
  } finally {
    clearTimeout(timer);
  }
}
