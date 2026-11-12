import { describe, expect, it } from 'vitest';
import { handleApi } from '@/lib/server/handlers';
import { decodeSubtitleBytes } from '@/lib/subtitle-parser';
import { decodeSingleByte } from '@/lib/codepages';

const req = (path: string, init?: RequestInit) => new Request(`https://api.example${path}`, init);

describe('worker API handler', () => {
  it('answers CORS preflight', async () => {
    const res = await handleApi(req('/api/search', { method: 'OPTIONS', headers: { Origin: 'https://u.github.io' } }), {});
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('x-debrid-key');
  });
  it('restricts origins when ALLOWED_ORIGINS is set', async () => {
    const env = { ALLOWED_ORIGINS: 'https://u.github.io' };
    const ok = await handleApi(req('/api/config', { headers: { Origin: 'https://u.github.io' } }), env);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://u.github.io');
    const bad = await handleApi(req('/api/config', { headers: { Origin: 'https://evil.example' } }), env);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('reports config without leaking keys', async () => {
    const res = await handleApi(req('/api/config'), { TMDB_API_KEY: 'secret', INDEXERS: 'yts,apibay' });
    const body = await res.json();
    expect(body.tmdb).toBe(true);
    expect(body.indexers).toEqual(['yts', 'apibay']);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
  it('enforces ACCESS_TOKEN', async () => {
    const env = { ACCESS_TOKEN: 't0k' };
    expect((await handleApi(req('/api/search?q=x'), env)).status).toBe(401);
    expect((await handleApi(req('/api/config'), env)).status).toBe(200);
  });
  it('validates input', async () => {
    expect((await handleApi(req('/api/search'), {})).status).toBe(400);
    const r = await handleApi(req('/api/debrid/resolve', { method: 'POST', body: JSON.stringify({ provider: 'realdebrid', magnet: 'nope' }) }), {});
    expect(r.status).toBe(400);
    const noKey = await handleApi(req('/api/debrid/resolve', { method: 'POST', body: JSON.stringify({ provider: 'torbox', infoHash: 'a'.repeat(40) }) }), {});
    expect(noKey.status).toBe(401);
    expect((await handleApi(req('/nope'), {})).status).toBe(404);
  });
});

describe('codepage fallback', () => {
  it('matches the native windows-1256 decoder', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeSingleByte(bytes, 'windows-1256')).toBe(new TextDecoder('windows-1256').decode(bytes));
    expect(decodeSubtitleBytes(new Uint8Array([0xd3, 0xe1, 0xc7, 0xe3]), 'ar')).toBe('سلام');
  });
});

describe('subtitle VTT for external players', () => {
  it('rejects bad tokens and keeps CORS restricted elsewhere', async () => {
    const env = { ALLOWED_ORIGINS: 'https://u.github.io' };
    const bad = await handleApi(req('/api/subtitles/file?format=vtt&token=bogus', { headers: { Origin: 'https://webtor.io' } }), env);
    expect(bad.status).toBe(502);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect(bad.headers.get('x-public-cors')).toBeNull();
  });
});
