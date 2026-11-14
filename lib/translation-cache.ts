'use client';
/**
 * Finished AI translations, kept on this device so reopening an episode or film is instant.
 * localStorage, newest 24 entries (a translated episode is ~40 KB); failures are ignored.
 */
const KEY = 'ts-translations';
const MAX = 24;

interface Entry { k: string; at: number; lines: string[] }

function readAll(): Entry[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') as Entry[]; } catch { return []; }
}

export function getTranslation(key: string, count: number): string[] | undefined {
  const e = readAll().find((x) => x.k === key);
  return e && e.lines.length === count ? e.lines : undefined;
}

export function putTranslation(key: string, lines: string[]) {
  let all = [{ k: key, at: Date.now(), lines }, ...readAll().filter((x) => x.k !== key)].slice(0, MAX);
  for (;;) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); return; } catch {
      if (all.length <= 1) return; // storage full or blocked
      all = all.slice(0, Math.ceil(all.length / 2));
    }
  }
}
