/**
 * Intro / recap / credits times from TheIntroDB (shared by the relay and the app: when the relay
 * is turned away, the app asks TheIntroDB itself from the viewer's own connection).
 */
export const INTRODB = 'https://api.theintrodb.org/v4/media';

export interface Segments {
  intro?: { start: number; end: number };
  recap?: { start: number; end: number };
  /** Where the end credits start (seconds); the next episode is offered from here. */
  credits?: { start: number; end?: number };
  /** The relay was turned away: the TheIntroDB query for the app to send itself. */
  ask?: string;
}

/** TheIntroDB's answer (lists of {start_ms, end_ms}) → seconds; 0/0 means "confirmed none". */
export function parseSegments(body: unknown): Segments {
  const b = (body ?? {}) as Record<string, { start_ms?: number | null; end_ms?: number | null }[] | undefined>;
  const first = (k: string) => (Array.isArray(b[k]) ? b[k]![0] : undefined);
  const out: Segments = {};
  for (const k of ['intro', 'recap'] as const) {
    const s = first(k);
    // Intro/recap: the end is required, the start may be omitted (= from the beginning).
    if (s && typeof s.end_ms === 'number' && s.end_ms > (s.start_ms ?? 0)) out[k] = { start: (s.start_ms ?? 0) / 1000, end: s.end_ms / 1000 };
  }
  const c = first('credits');
  // Credits: the start is required, the end may be omitted (= to the end).
  if (c && typeof c.start_ms === 'number' && c.start_ms > 0 && (c.end_ms == null || c.end_ms > c.start_ms)) {
    out.credits = { start: c.start_ms / 1000, ...(typeof c.end_ms === 'number' ? { end: c.end_ms / 1000 } : {}) };
  }
  return out;
}
