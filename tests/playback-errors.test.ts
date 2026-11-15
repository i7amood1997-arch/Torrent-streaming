import { describe, expect, it } from 'vitest';
import { deadLinkMessage } from '../lib/playback-errors';

const res = (status: number, type: ResponseType = 'basic') => (async () => ({ ok: status >= 200 && status < 300, status, type, body: null }) as unknown as Response) as typeof fetch;

describe('dead link vs unsupported format', () => {
  it('names a 404 link as gone instead of blaming the format', async () => {
    expect(await deadLinkMessage('https://h/x.mp4', res(404))).toMatch(/no longer exists/);
  });
  it('names an expired/refused link', async () => {
    expect(await deadLinkMessage('https://h/x.mp4', res(403))).toMatch(/refused/);
  });
  it('keeps the format message when the link answers', async () => {
    expect(await deadLinkMessage('https://h/x.mp4', res(206))).toBeUndefined();
    expect(await deadLinkMessage('https://h/x.mp4', res(0, 'opaque'))).toBeUndefined();
  });
  it('keeps the format message when the link cannot be checked', async () => {
    expect(await deadLinkMessage('https://h/x.mp4', (async () => { throw new TypeError('cors'); }) as typeof fetch)).toBeUndefined();
    expect(await deadLinkMessage('blob:abc', res(404))).toBeUndefined();
  });
});
