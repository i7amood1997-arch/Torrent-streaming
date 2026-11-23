/**
 * What to tell people when a request fails. Browsers word a lost connection differently
 * ("Failed to fetch", "Load failed", "NetworkError…"), and none of it means much to anyone.
 */
export function friendlyError(e: unknown): string {
  const err = e as { name?: string; message?: string } | undefined;
  if (err?.name === 'TimeoutError') return 'It took too long to answer. Try again in a moment.';
  if (err?.name === 'TypeError' && /failed to fetch|load failed|networkerror|network request failed/i.test(err.message ?? '')) {
    return 'No internet connection, or the relay can’t be reached.';
  }
  return err?.message || String(e);
}
