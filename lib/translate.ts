/**
 * Machine translation of subtitle lines (portable: browser and Worker).
 *
 * Uses Google Translate's free web endpoint (the one browser extensions use): no key,
 * readable from any web page (it sends `Access-Control-Allow-Origin: *`). Lines are sent
 * in batches joined by newlines, which the endpoint keeps; if a batch comes back with a
 * different number of lines, it is split in half and retried, down to single lines.
 */

const GOOGLE = 'https://translate.googleapis.com/translate_a/single';
const MAX_CHARS = 3500;

/** ISO 639-2 (OpenSubtitles feed) → the 2-letter codes translators use. */
export const ISO2: Record<string, string> = {
  ara: 'ar', eng: 'en', fre: 'fr', fra: 'fr', spa: 'es', spn: 'es', ger: 'de', deu: 'de', por: 'pt', pob: 'pt', pom: 'pt', ita: 'it',
  tur: 'tr', rus: 'ru', dut: 'nl', nld: 'nl', pol: 'pl', per: 'fa', fas: 'fa', heb: 'he', chi: 'zh', zho: 'zh', zht: 'zh', zhe: 'zh', jpn: 'ja',
  kor: 'ko', rum: 'ro', ron: 'ro', gre: 'el', ell: 'el', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', cze: 'cs', ces: 'cs', hun: 'hu',
  bul: 'bg', hrv: 'hr', scc: 'sr', srp: 'sr', ind: 'id', may: 'ms', msa: 'ms', tha: 'th', vie: 'vi', hin: 'hi', ukr: 'uk', slv: 'sl',
  slo: 'sk', slk: 'sk', est: 'et', lav: 'lv', lit: 'lt', ben: 'bn', urd: 'ur', tam: 'ta', tel: 'te', mal: 'ml', kur: 'ku', alb: 'sq',
  sqi: 'sq', mac: 'mk', mkd: 'mk', bos: 'bs', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', ice: 'is', isl: 'is', geo: 'ka', kat: 'ka',
  arm: 'hy', hye: 'hy', aze: 'az', kaz: 'kk', uzb: 'uz', tgl: 'tl', fil: 'tl', khm: 'km', bur: 'my', mya: 'my', sin: 'si', nep: 'ne',
  mon: 'mn', afr: 'af', swa: 'sw', amh: 'am', som: 'so', pus: 'ps', tat: 'tt', bel: 'be', ltz: 'lb', wel: 'cy', cym: 'cy', gle: 'ga',
};

export const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic', en: 'English', fr: 'French', es: 'Spanish', de: 'German', pt: 'Portuguese', it: 'Italian', tr: 'Turkish', ru: 'Russian',
  nl: 'Dutch', pl: 'Polish', fa: 'Persian', he: 'Hebrew', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ro: 'Romanian', el: 'Greek',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech', hu: 'Hungarian', bg: 'Bulgarian', hr: 'Croatian',
  sr: 'Serbian', id: 'Indonesian', ms: 'Malay', th: 'Thai', vi: 'Vietnamese', hi: 'Hindi', uk: 'Ukrainian', ur: 'Urdu', ku: 'Kurdish',
};
export const languageName = (code?: string) => (code ? LANGUAGE_NAMES[code] ?? code.toUpperCase() : 'another language');

/** A subtitle line as plain text on one line (tags removed, line breaks become spaces). */
export function plainLine(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Group lines into batches of at most `max` characters (a longer single line is its own batch). */
export function batches(lines: string[], max = MAX_CHARS): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const n = lines[i].length + 1;
    if (i > start && size + n > max) { out.push([start, i]); start = i; size = 0; }
    size += n;
  }
  if (start < lines.length) out.push([start, lines.length]);
  return out;
}

/** Parse the endpoint's reply: [[["translated","original",…],…],…,"detected"]. */
export function parseGoogle(data: unknown): { text: string; detected?: string } {
  const d = data as [Array<[string, ...unknown[]]> | null, unknown, string?];
  const text = (d?.[0] ?? []).map((seg) => (typeof seg?.[0] === 'string' ? seg[0] : '')).join('');
  return { text, detected: typeof d?.[2] === 'string' ? d[2] : undefined };
}

export type TranslateFn = (text: string, from: string, to: string, signal?: AbortSignal) => Promise<string>;

export const googleTranslate: TranslateFn = async (text, from, to, signal) => {
  const res = await fetch(`${GOOGLE}?client=gtx&dt=t&sl=${encodeURIComponent(from || 'auto')}&tl=${encodeURIComponent(to)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q: text }).toString(),
    signal,
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'translator busy (429)' : `translator HTTP ${res.status}`);
  return parseGoogle(await res.json()).text;
};

/**
 * Translate lines, keeping a 1:1 mapping. `onBatch` reports progress as batches finish
 * (in order), so callers can show the first minutes while the rest is translated.
 */
export async function translateLines(
  lines: string[],
  from: string,
  to: string,
  opts: { translate?: TranslateFn; signal?: AbortSignal; onBatch?: (done: number, out: (string | undefined)[]) => void } = {},
): Promise<string[]> {
  const translate = opts.translate ?? googleTranslate;
  const out: (string | undefined)[] = new Array(lines.length);
  const run = async (a: number, b: number): Promise<void> => {
    const chunk = lines.slice(a, b);
    // Empty lines can be dropped or merged by the translator: keep them out of the request.
    const idx = chunk.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) { for (let i = a; i < b; i++) out[i] = ''; return; }
    const translated = (await translate(idx.map((i) => chunk[i]).join('\n'), from, to, opts.signal)).replace(/\r/g, '').replace(/\n+$/, '').split('\n');
    if (translated.length === idx.length) {
      for (let i = a; i < b; i++) out[i] = '';
      idx.forEach((i, k) => { out[a + i] = translated[k].trim(); });
      return;
    }
    if (b - a === 1) { out[a] = translated.join(' ').trim(); return; }
    const mid = (a + b) >> 1;
    await run(a, mid);
    await run(mid, b);
  };
  const plan = batches(lines);
  let done = 0;
  // Two requests in flight: fast, and gentle enough not to be rate-limited.
  for (let i = 0; i < plan.length; i += 2) {
    await Promise.all(plan.slice(i, i + 2).map(([a, b]) => run(a, b)));
    done = plan.slice(0, i + 2).reduce((n, [, b]) => Math.max(n, b), done);
    opts.onBatch?.(done, out);
  }
  return out.map((s) => s ?? '');
}
