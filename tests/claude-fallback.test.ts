import { describe, expect, it } from 'vitest';
import { handleApi } from '@/lib/server/handlers';

const req = (body: object) => new Request('https://api.example/api/translate-ai', { method: 'POST', body: JSON.stringify(body) });
const lines = ['Hello.', 'Goodbye.'];

/** A stand-in Claude client that answers in the numbered format and records calls. */
function fakeClaude() {
  const calls: { model: string; system: string }[] = [];
  return {
    calls,
    client: { messages: { create: async (p: { model: string; system: string; messages: { content: string }[] }) => {
      calls.push({ model: p.model, system: p.system });
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '1. مرحبا.\n2. وداعا.' }] };
    } } } as never,
  };
}
const quotaAI = { run: async () => { throw new Error('4006: daily neuron allocation exceeded'); } };
const okAI = { run: async () => ({ response: '1. AI-1\n2. AI-2' }) };

describe('Claude as the last-resort translator', () => {
  it('is used when Google refused and the relay AI allowance is used up', async () => {
    const c = fakeClaude();
    const res = await handleApi(req({ lines, to: 'ar', lastResort: true }), {}, { AI: quotaAI, claude: c.client });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.lines).toEqual(['مرحبا.', 'وداعا.']);
    expect(c.calls[0].model).toBe('claude-haiku-5-5');
  });

  it('is never used for ordinary AI requests (Google still working)', async () => {
    const c = fakeClaude();
    const res = await handleApi(req({ lines, to: 'ar' }), {}, { AI: quotaAI, claude: c.client });
    expect(res.status).toBe(429);
    expect(c.calls).toHaveLength(0);
  });

  it('comes after the relay’s free AI, which is tried first', async () => {
    const c = fakeClaude();
    const res = await handleApi(req({ lines, to: 'ar', lastResort: true }), {}, { AI: okAI, claude: c.client });
    expect((await res.json()).lines).toEqual(['AI-1', 'AI-2']);
    expect(c.calls).toHaveLength(0);
  });

  it('works on a relay with a Claude key but no Workers AI', async () => {
    const c = fakeClaude();
    const res = await handleApi(req({ lines, to: 'ar', lastResort: true }), {}, { claude: c.client });
    expect(res.status).toBe(200);
    expect(c.calls).toHaveLength(1);
  });

  it('reports Claude as available in the relay config only when the Worker made a client', async () => {
    expect((await (await handleApi(new Request('https://api.example/api/config'), {}, { claude: fakeClaude().client })).json()).claude).toBe(true);
    expect((await (await handleApi(new Request('https://api.example/api/config'), {})).json()).claude).toBe(false);
  });
});

describe('Claude errors', () => {
  it('turns a rejected key into a clear, final message', async () => {
    const bad = { messages: { create: async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); } } } as never;
    const res = await handleApi(req({ lines, to: 'ar', lastResort: true }), {}, { AI: quotaAI, claude: bad });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/key on your relay was rejected/);
  });
});
