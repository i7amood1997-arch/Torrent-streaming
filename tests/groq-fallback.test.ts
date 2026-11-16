import { describe, expect, it } from 'vitest';
import { handleApi } from '@/lib/server/handlers';

const quotaAI = { run: async () => { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } };
const okAI = { run: async () => ({ transcription_info: { language: 'en' }, segments: [{ start: 0, end: 2, text: 'From Cloudflare.', words: [{ word: 'From', start: 0, end: 0.5 }] }] }) };
const req = () => new Request('https://api.example/api/transcribe?lang=en', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]) });

/** A stand-in for Groq's OpenAI-style transcription API; records what was sent. */
function fakeGroq(reply: { status?: number; body: unknown }) {
  const sent: { url: string; auth: string | null; fields: Record<string, string[]>; fileName?: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const fields: Record<string, string[]> = {};
    let fileName: string | undefined;
    for (const [k, v] of form.entries()) { if (typeof v === 'string') (fields[k] ??= []).push(v); else fileName = (v as File).name; }
    sent.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), fields, fileName });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

const groqReply = {
  language: 'English', text: 'Hello there. General Kenobi.',
  segments: [{ start: 0, end: 1.2, text: ' Hello there.', no_speech_prob: 0.01, avg_logprob: -0.2 }, { start: 1.5, end: 3, text: ' General Kenobi.', no_speech_prob: 0.01, avg_logprob: -0.2 }],
  words: [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'there.', start: 0.4, end: 1.2 }, { word: 'General', start: 1.5, end: 2.1 }, { word: 'Kenobi.', start: 2.1, end: 3 }],
};

describe('speech recognition: Groq when the free Cloudflare allowance is used up', () => {
  it('switches to Groq and returns the same transcript shape', async () => {
    const g = fakeGroq({ body: groqReply });
    const res = await handleApi(req(), { GROQ_API_KEY: 'gsk_test' }, { AI: quotaAI, groqFetch: g.fetchFn });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.language).toBe('en'); // "English" → "en", as the app compares codes
    expect(body.segments.map((s: any) => [s.text, s.words.map((w: any) => w.word)])).toEqual([['Hello there.', ['Hello', 'there.']], ['General Kenobi.', ['General', 'Kenobi.']]]);
    expect(g.sent[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(g.sent[0].auth).toBe('Bearer gsk_test');
    expect(g.sent[0].fields.model).toEqual(['whisper-large-v3-turbo']);
    expect(g.sent[0].fields.response_format).toEqual(['verbose_json']);
    expect(g.sent[0].fields['timestamp_granularities[]']).toEqual(['word', 'segment']);
    expect(g.sent[0].fields.language).toEqual(['en']);
    expect(g.sent[0].fileName).toBe('audio.wav');
  });

  it('is not used while Cloudflare still answers', async () => {
    const g = fakeGroq({ body: groqReply });
    const body = await (await handleApi(req(), { GROQ_API_KEY: 'gsk_test' }, { AI: okAI, groqFetch: g.fetchFn })).json();
    expect(body.segments[0].text).toBe('From Cloudflare.');
    expect(g.sent).toHaveLength(0);
  });

  it('without a Groq key, the allowance message stays', async () => {
    const res = await handleApi(req(), {}, { AI: quotaAI });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/allowance on your relay is used up/);
  });

  it('when Groq is out too, or the key is wrong, says so clearly', async () => {
    const busy = await handleApi(req(), { GROQ_API_KEY: 'k' }, { AI: quotaAI, groqFetch: fakeGroq({ status: 429, body: { error: { message: 'rate limit' } } }).fetchFn });
    expect(busy.status).toBe(429);
    expect((await busy.json()).error).toMatch(/Cloudflare and Groq/);
    const bad = await handleApi(req(), { GROQ_API_KEY: 'k' }, { AI: quotaAI, groqFetch: fakeGroq({ status: 401, body: { error: { message: 'Invalid API Key' } } }).fetchFn });
    expect((await bad.json()).error).toMatch(/Groq key on your relay was rejected/);
  });
});
