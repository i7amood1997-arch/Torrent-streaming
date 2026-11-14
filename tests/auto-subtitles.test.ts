import { describe, expect, it, vi } from 'vitest';
import { batches, upgradeLines, buildSubtitlePrompt, parseGoogle, parseNumberedLines, plainLine, readLlmText, sentenceGroups, splitTranslation, translateLines, type TranslateFn } from '@/lib/translate';
import { segmentsToCues } from '@/lib/speech/generate';
import { adts, adtsParams, buildAudioFile, oggPage, xiphHeaders } from '@/lib/speech/elementary';
import { handleApi } from '@/lib/server/handlers';

describe('translation', () => {
  it('cleans cue text into one line', () => {
    expect(plainLine('<i>Hello</i>\n{\\an8}there  you')).toBe('Hello there you');
  });

  it('batches by size', () => {
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(99)); // 100 chars each with the newline
    expect(batches(lines, 350)).toEqual([[0, 3], [3, 6], [6, 9], [9, 10]]);
  });

  it('parses the Google reply', () => {
    expect(parseGoogle([[['مرحبا\n', 'Hello\n'], ['عالم', 'world']], null, 'en'])).toEqual({ text: 'مرحبا\nعالم', detected: 'en' });
  });

  it('keeps a 1:1 mapping, skipping empty lines', async () => {
    const t: TranslateFn = async (text) => text.split('\n').map((l) => `AR(${l})`).join('\n');
    expect(await translateLines(['a', '', 'b'], 'en', 'ar', { translate: t })).toEqual(['AR(a)', '', 'AR(b)']);
  });

  it('splits a batch when the translator merges lines', async () => {
    const t = vi.fn<TranslateFn>(async (text) => {
      const lines = text.split('\n');
      // Merges lines when given more than two at once.
      return lines.length > 2 ? lines.slice(0, -1).map((l) => `T(${l})`).join('\n') : lines.map((l) => `T(${l})`).join('\n');
    });
    const out = await translateLines(['1.', '2.', '3.', '4.', '5.'], 'fr', 'en', { translate: t });
    expect(out).toEqual(['T(1.)', 'T(2.)', 'T(3.)', 'T(4.)', 'T(5.)']);
  });

  it('reports progress in order', async () => {
    const seen: number[] = [];
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} `.repeat(4));
    await translateLines(lines, 'en', 'ar', { translate: async (x) => x, onBatch: (done) => seen.push(done) });
    expect(seen[seen.length - 1]).toBe(200);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe('better translation', () => {
  it('groups a sentence split over lines, but not separate speakers', () => {
    const lines = ['I told you', 'not to come here.', '- Why?', '- Because', 'it is dangerous.', 'Fine.'];
    expect(sentenceGroups(lines)).toEqual([[0, 2], [2, 3], [3, 5], [5, 6]]);
  });

  it('splits a translated sentence back over its lines by length', () => {
    expect(splitTranslation('قلت لك ألا تأتي إلى هنا', ['I told you', 'not to come here.'])).toEqual(['قلت لك', 'ألا تأتي إلى هنا']);
  });

  it('translates whole sentences with Google', async () => {
    const seen: string[] = [];
    const t: TranslateFn = async (text) => { seen.push(text); return text.split('\n').map((l) => l.toUpperCase()).join('\n'); };
    const out = await translateLines(['I told you', 'not to come here.', 'Fine.'], 'en', 'ar', { translate: t });
    expect(seen[0]).toBe('I told you not to come here.\nFine.');
    expect(out).toEqual(['I TOLD YOU', 'NOT TO COME HERE.', 'FINE.']);
  });

  it('uses the AI translator with context, filling gaps with Google', async () => {
    const calls: { lines: string[]; context: string[] }[] = [];
    const ai = async (lines: string[], context: string[]) => { calls.push({ lines, context }); return lines.map((l, i) => (i === 1 ? undefined : `AI:${l}`)); };
    const lines = Array.from({ length: 45 }, (_, i) => `Line ${i}.`);
    const out = await translateLines(lines, 'en', 'ar', { ai, translate: async (x) => x.split('\n').map((l) => `G:${l}`).join('\n') });
    expect(calls.length).toBe(2);
    expect(calls[1].context).toEqual(['Line 36.', 'Line 37.', 'Line 38.', 'Line 39.']);
    expect(out[0]).toBe('AI:Line 0.');
    expect(out[1]).toBe('G:Line 1.');
    expect(out[44]).toBe('AI:Line 44.');
  });

  it('falls back to Google for the rest when the AI fails', async () => {
    let failed = '';
    const ai = async () => { throw new Error('allowance used up'); };
    const out = await translateLines(['A.', 'B.'], 'en', 'ar', { ai, translate: async (x) => x.split('\n').map((l) => `G:${l}`).join('\n'), onAiFailed: (e) => { failed = e.message; } });
    expect(out).toEqual(['G:A.', 'G:B.']);
    expect(failed).toBe('allowance used up');
  });

  it('builds a numbered prompt and reads numbered answers in any shape', () => {
    const [sys, user] = buildSubtitlePrompt(['Hi.', 'Bye.'], { from: 'en', to: 'ar', context: ['Hello?'], title: 'Dexter' });
    expect(sys.content).toContain('Arabic');
    expect(user.content).toContain('1|Hi.\n2|Bye.');
    expect(user.content).toContain('Title: Dexter');
    expect(parseNumberedLines('<think>x</think>\n1| مرحبا\n2. وداعا\nnote', 2)).toEqual(['مرحبا', 'وداعا']);
    expect(readLlmText({ response: 'a' })).toBe('a');
    expect(readLlmText({ choices: [{ message: { content: 'b' } }] })).toBe('b');
    expect(readLlmText({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'r' }] }, { type: 'message', content: [{ type: 'output_text', text: 'c' }] }] })).toBe('c');
  });
});

describe('AI upgrade', () => {
  it('starts at the scene being watched and spreads outwards', async () => {
    const order: number[] = [];
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}.`);
    const cur = lines.map((l) => `G:${l}`);
    const ok = await upgradeLines(lines, cur, async (ls) => { order.push(Number(ls[0].slice(1, -1))); return ls.map((l) => `AI:${l}`); }, { startAt: () => 52, batchSize: 10, parallel: 1 });
    expect(ok).toBe(true);
    expect(order.slice(0, 3)).toEqual([50, 60, 70]); // the scene being watched, then what comes next
    expect(order.indexOf(90)).toBeLessThan(order.indexOf(20)); // ahead before far behind
    expect(order[order.length - 1]).toBe(0); // the start of the film last
    expect(cur.every((x) => x.startsWith('AI:'))).toBe(true);
  });

  it('keeps the first translation where the AI stops', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i}.`);
    const cur = lines.map((l) => `G:${l}`);
    let calls = 0;
    const ok = await upgradeLines(lines, cur, async (ls) => { if (++calls > 1) throw new Error('allowance'); return ls.map((l) => `AI:${l}`); }, { batchSize: 10, parallel: 1 });
    expect(ok).toBe(false);
    expect(cur[0]).toBe('AI:L0.');
    expect(cur[29]).toBe('G:L29.');
  });

  it('runs several batches at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}.`);
    await upgradeLines(lines, [...lines], async (ls) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return ls; }, { batchSize: 10, parallel: 4 });
    expect(peak).toBe(4);
  });
});

describe('speech → cues', () => {
  it('keeps short segments and shifts them to media time', () => {
    const cues = segmentsToCues([{ start: 1, end: 2.5, text: ' Hello there. ' }], 600);
    expect(cues).toEqual([{ start: 601, end: 602.5, text: 'Hello there.' }]);
  });

  it('splits long segments by word timing into ≤ 6 s, two-line cues', () => {
    const words = 'This is a long sentence that keeps going. And then another one starts here and continues for a while longer than fits'.split(' ')
      .map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const cues = segmentsToCues([{ start: 0, end: 12, text: words.map((w) => w.word).join(' '), words }]);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.end - c.start).toBeLessThanOrEqual(6.5);
      expect(c.text.split('\n').length).toBeLessThanOrEqual(2);
      for (const line of c.text.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    }
    expect(cues[0].text.replace('\n', ' ')).toBe('This is a long sentence that keeps going.');
  });

  it('drops typical hallucinations', () => {
    expect(segmentsToCues([{ start: 0, end: 2, text: 'Thanks for watching!' }, { start: 3, end: 4, text: '♪♪' }])).toEqual([]);
  });
});

describe('audio packaging', () => {
  it('reads AAC-LC 48 kHz stereo from an AudioSpecificConfig', () => {
    expect(adtsParams(Uint8Array.of(0x11, 0x90), 48000, 2)).toEqual({ profile: 1, sfi: 3, ch: 2 });
  });

  it('treats HE-AAC as LC with the core rate', () => {
    // AOT 5 (SBR), sfi 6 (24 kHz), 2 channels, extension rate 48 kHz, core AOT 2.
    expect(adtsParams(Uint8Array.of(0x2b, 0x11, 0x88, 0x00), 48000, 2).profile).toBe(1);
  });

  it('writes ADTS headers with the right frame length', () => {
    const out = adts([new Uint8Array(100), new Uint8Array(50)], { profile: 1, sfi: 3, ch: 2 });
    expect(out.length).toBe(150 + 14);
    expect([out[0], out[1] & 0xf6]).toEqual([0xff, 0xf0]);
    const len = ((out[3] & 3) << 11) | (out[4] << 3) | (out[5] >> 5);
    expect(len).toBe(107);
  });

  it('builds Ogg pages with a valid CRC layout', () => {
    const page = oggPage([new Uint8Array(300)], 960, 1, 0, 2);
    expect(String.fromCharCode(...page.subarray(0, 4))).toBe('OggS');
    expect(page[26]).toBe(2); // 300 = 255 + 45
    expect(page.length).toBe(27 + 2 + 300);
  });

  it('splits Xiph-laced Vorbis headers', () => {
    const cp = Uint8Array.of(2, 3, 2, 1, 1, 1, 2, 2, 3, 3, 3);
    expect(xiphHeaders(cp).map((h) => h.length)).toEqual([3, 2, 3]);
  });

  it('passes self-synchronising codecs through', () => {
    const f = buildAudioFile({ codec: 'eac3', sampleRate: 48000, channels: 6 }, [{ t: 0, data: Uint8Array.of(0x0b, 0x77, 1) }, { t: 0.032, data: Uint8Array.of(0x0b, 0x77, 2) }]);
    expect(Array.from(f.bytes)).toEqual([0x0b, 0x77, 1, 0x0b, 0x77, 2]);
  });
});

describe('relay routes', () => {
  const req = (path: string, init?: RequestInit) => new Request(`https://api.example${path}`, init);

  it('reports speech recognition only with the AI binding', async () => {
    expect((await (await handleApi(req('/api/config'), {})).json()).ai).toBe(false);
    expect((await (await handleApi(req('/api/config'), {}, { AI: { run: async () => ({}) } })).json()).ai).toBe(true);
  });

  it('transcribes with Whisper and filters silence', async () => {
    const run = vi.fn(async () => ({
      transcription_info: { language: 'en' },
      segments: [
        { start: 0, end: 2, text: ' Hello. ', no_speech_prob: 0.1, avg_logprob: -0.2, words: [{ word: 'Hello.', start: 0, end: 1 }] },
        { start: 3, end: 5, text: 'noise', no_speech_prob: 0.95, avg_logprob: -0.3 },
      ],
    }));
    const res = await handleApi(req('/api/transcribe?lang=en', { method: 'POST', body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'audio/aac' } }), {}, { AI: { run } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.language).toBe('en');
    expect(body.segments).toEqual([{ start: 0, end: 2, text: 'Hello.', words: [{ word: 'Hello.', start: 0, end: 1 }] }]);
    const input = (run.mock.calls[0] as unknown as [string, { language?: string; vad_filter?: boolean }])[1];
    expect(input.language).toBe('en');
    expect(input.vad_filter).toBe(true);
  });

  it('falls back to base64 audio and explains an exhausted allowance', async () => {
    let calls = 0;
    const run = async (_m: string, input: unknown) => {
      calls++;
      if (typeof (input as { audio: unknown }).audio !== 'string') throw new Error('Type mismatch');
      throw new Error('4006: you have used up your daily free allocation of 10,000 neurons');
    };
    const res = await handleApi(req('/api/transcribe', { method: 'POST', body: new Uint8Array([1]) }), {}, { AI: { run } });
    expect(calls).toBe(2);
    expect(res.status).toBe(429);
    expect((await res.json()).fatal).toBe(true);
  });

  it('translates with the first model that answers completely', async () => {
    const models: string[] = [];
    const run = async (model: string) => { models.push(model); return model.includes('gpt-oss') ? { choices: [{ message: { content: '1|نعم' } }] } : { response: '1|نعم\n2|لا' }; };
    const res = await handleApi(req('/api/translate-ai', { method: 'POST', body: JSON.stringify({ lines: ['Yes.', 'No.'], to: 'ar' }) }), {}, { AI: { run } });
    const body = await res.json();
    expect(body.lines).toEqual(['نعم', 'لا']);
    expect(models).toEqual(['@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct']);
  });

  it('needs the binding for transcription and validates translation input', async () => {
    expect((await handleApi(req('/api/transcribe', { method: 'POST', body: new Uint8Array([1]) }), {})).status).toBe(501);
    expect((await handleApi(req('/api/translate', { method: 'POST', body: JSON.stringify({ text: 'hi' }) }), {})).status).toBe(400);
  });
});
