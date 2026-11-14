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

// ─── Sentences split across subtitle lines ──────────────────────────────────

const ENDS_SENTENCE = /[.!?…:;"'”»)\]♪]$/;

/**
 * Group consecutive lines that form one sentence ("I told you" / "not to come here.")
 * so the translator sees whole sentences. A new speaker ("- ...") always starts a group.
 */
export function sentenceGroups(lines: string[], max = 3): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && j - i < max && lines[j - 1].trim() && !ENDS_SENTENCE.test(lines[j - 1].trim()) && lines[j].trim() && !/^[-–—]/.test(lines[j].trim())) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

/** Split a translated sentence back over `parts` lines, in proportion to the source lines' lengths. */
export function splitTranslation(text: string, sources: string[]): string[] {
  if (sources.length === 1) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const total = sources.reduce((n, x) => n + Math.max(1, x.length), 0);
  const out: string[] = [];
  let w = 0;
  let acc = 0;
  for (let k = 0; k < sources.length; k++) {
    acc += Math.max(1, sources[k].length);
    const end = k === sources.length - 1 ? words.length : Math.max(w + 1, Math.min(words.length - (sources.length - 1 - k), Math.round((acc / total) * words.length)));
    out.push(words.slice(w, end).join(' '));
    w = end;
  }
  return out;
}

// ─── LLM translation (relay) ────────────────────────────────────────────────

const LANG_STYLE: Record<string, string> = {
  ar: 'natural Modern Standard Arabic as used in professional Arabic subtitles (short, clear and conversational; correct gender and number; right-to-left punctuation)',
  en: 'natural, idiomatic English as used in professional subtitles',
};

/** Chat messages asking a model to translate numbered subtitle lines, one output line per input line. */
export function buildSubtitlePrompt(lines: string[], o: { from?: string; to: string; context?: string[]; title?: string }) {
  const target = LANGUAGE_NAMES[o.to] ?? o.to;
  const system = [
    `You translate film and TV subtitles${o.from ? ` from ${LANGUAGE_NAMES[o.from] ?? o.from}` : ''} into ${target}.`,
    `Write ${LANG_STYLE[o.to] ?? `natural ${target}`}.`,
    'Keep names, keep the tone and register of each speaker, and translate idioms by meaning, not word for word.',
    'A sentence may continue onto the next line: read the lines together for meaning, but keep exactly one output line per input line, with the same number.',
    'Output only the numbered lines, as "N|translation". No notes, no explanations.',
  ].join(' ');
  const user = [
    o.title ? `Title: ${o.title}` : '',
    o.context?.length ? `Previous lines (context only, do not translate):\n${o.context.join('\n')}` : '',
    `Lines:\n${lines.map((l, i) => `${i + 1}|${l}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** The text of a Workers AI answer, whichever shape the model returns. */
export function readLlmText(out: unknown): string {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[]; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  if (typeof out === 'string') return out;
  if (typeof o?.response === 'string') return o.response;
  const c = o?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  const parts = o?.output?.filter((x) => x.type === 'message' || !x.type).flatMap((x) => x.content ?? []).filter((x) => x.type !== 'reasoning_text').map((x) => x.text ?? '');
  return parts?.join('\n') ?? '';
}

/** Parse "N|text" lines into an array of `count` entries (missing ones undefined). */
export function parseNumberedLines(text: string, count: number): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(count);
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  for (const line of clean.split('\n')) {
    const m = line.match(/^\s*(\d{1,3})\s*[|｜:.)\-–]\s*(.*)$/);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    const t = m[2].trim();
    if (i >= 0 && i < count && t && out[i] === undefined) out[i] = t;
  }
  return out;
}

export type BatchTranslateFn = (lines: string[], context: string[], signal?: AbortSignal) => Promise<(string | undefined)[]>;

/**
 * Translate lines, keeping a 1:1 mapping. `onBatch` reports progress as batches finish
 * (in order), so callers can show the first minutes while the rest is translated.
 *
 *  - With `ai` (an LLM on the relay): batches of ~40 lines with the previous lines as
 *    context. Lines it misses fall back to Google; if it fails outright (e.g. the daily
 *    allowance is used up), the rest is done with Google.
 *  - Google: sentences split over several lines are translated whole, then split back.
 */
export async function translateLines(
  lines: string[],
  from: string,
  to: string,
  opts: { translate?: TranslateFn; ai?: BatchTranslateFn; signal?: AbortSignal; onBatch?: (done: number, out: (string | undefined)[]) => void; onAiFailed?: (e: Error) => void } = {},
): Promise<string[]> {
  const out: (string | undefined)[] = new Array(lines.length);
  let ai = opts.ai;
  const google = (idx: number[]) => googleLines(idx.map((i) => lines[i]), from, to, opts).then((t) => idx.forEach((i, k) => { out[i] = t[k]; }));

  const size = ai ? 40 : 0;
  const plan: [number, number][] = ai ? Array.from({ length: Math.ceil(lines.length / size) }, (_, k) => [k * size, Math.min(lines.length, (k + 1) * size)]) : [];
  if (!ai) {
    await googleLines(lines, from, to, { ...opts, onBatch: (done, part) => { part.forEach((t, i) => { if (t !== undefined) out[i] = t; }); opts.onBatch?.(done, out); } }).then((t) => t.forEach((x, i) => { out[i] = x; }));
    return out.map((x) => x ?? '');
  }

  let done = 0;
  const run = async ([a, b]: [number, number]) => {
    const idx = Array.from({ length: b - a }, (_, k) => a + k).filter((i) => lines[i].trim());
    for (let i = a; i < b; i++) if (!lines[i].trim()) out[i] = '';
    if (!idx.length) return;
    if (ai) {
      try {
        const res = await ai(idx.map((i) => lines[i]), lines.slice(Math.max(0, a - 4), a).filter((l) => l.trim()), opts.signal);
        idx.forEach((i, k) => { if (res[k]) out[i] = res[k]; });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        ai = undefined; // stop asking the model; Google does the rest
        opts.onAiFailed?.(e as Error);
      }
    }
    const missing = idx.filter((i) => out[i] === undefined);
    if (missing.length) await google(missing);
  };
  // Two batches in flight, reported in order.
  for (let k = 0; k < plan.length; k += 2) {
    await Promise.all(plan.slice(k, k + 2).map(run));
    done = plan[Math.min(plan.length, k + 2) - 1][1];
    opts.onBatch?.(done, out);
  }
  return out.map((x) => x ?? '');
}

/** Google path: whole sentences in, split back over their lines. */
async function googleLines(
  lines: string[],
  from: string,
  to: string,
  opts: { translate?: TranslateFn; signal?: AbortSignal; onBatch?: (done: number, out: (string | undefined)[]) => void },
): Promise<string[]> {
  const groups = sentenceGroups(lines);
  const units = groups.map(([a, b]) => lines.slice(a, b).join(' '));
  const out: (string | undefined)[] = new Array(lines.length);
  const spread = (unitOut: (string | undefined)[]) => {
    groups.forEach(([a, b], g) => {
      const t = unitOut[g];
      if (t === undefined || out[a] !== undefined) return;
      splitTranslation(t, lines.slice(a, b)).forEach((x, k) => { out[a + k] = x; });
    });
  };
  const unitOut = await translateUnits(units, from, to, {
    translate: opts.translate,
    signal: opts.signal,
    onBatch: (doneUnits, partial) => {
      spread(partial);
      opts.onBatch?.(doneUnits >= groups.length ? lines.length : groups[doneUnits]?.[0] ?? lines.length, out);
    },
  });
  spread(unitOut);
  return out.map((x) => x ?? '');
}

/** Translate independent units with newline-joined batches (1:1 mapping, bisect on mismatch). */
async function translateUnits(
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

/**
 * Improve an existing translation with the AI, in place: small batches, several at once,
 * starting at `startAt` (the scene being watched) and spreading outwards. Each finished
 * batch is reported so the subtitles on screen improve as they arrive. Returns false if
 * the AI stopped (e.g. the daily allowance ran out); the lines it didn't reach keep the
 * first translation.
 */
export async function upgradeLines(
  lines: string[],
  current: (string | undefined)[],
  ai: BatchTranslateFn,
  opts: { startAt?: () => number; batchSize?: number; parallel?: number; signal?: AbortSignal; onBatch?: (done: number, total: number) => void } = {},
): Promise<boolean> {
  const size = opts.batchSize ?? 25;
  const pending = new Set<number>();
  for (let a = 0; a < lines.length; a += size) pending.add(a);
  const total = pending.size;
  let failed = false;
  let finished = 0;
  /** Next batch: the one nearest the viewer, ahead of them first. */
  const next = (): number | undefined => {
    if (!pending.size) return undefined;
    const at = Math.floor((opts.startAt?.() ?? 0) / size) * size;
    let best: number | undefined;
    let bestCost = Infinity;
    for (const a of pending) {
      const cost = a >= at ? a - at : (at - a) * 3; // behind the viewer matters less
      if (cost < bestCost) { bestCost = cost; best = a; }
    }
    pending.delete(best!);
    return best;
  };
  const worker = async () => {
    for (let a = next(); a !== undefined && !failed; a = next()) {
      const b = Math.min(lines.length, a + size);
      const idx = Array.from({ length: b - a }, (_, k) => a + k).filter((i) => lines[i].trim());
      if (idx.length) {
        try {
          const res = await ai(idx.map((i) => lines[i]), lines.slice(Math.max(0, a - 4), a).filter((l) => l.trim()), opts.signal);
          idx.forEach((i, k) => { if (res[k]) current[i] = res[k]; });
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          failed = true;
          return;
        }
      }
      finished++;
      opts.onBatch?.(finished, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel ?? 4, total) }, worker));
  return !failed;
}
