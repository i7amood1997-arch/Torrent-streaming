import { describe, expect, it } from 'vitest';
import { base32ToHex, parseMagnet } from '@/lib/magnet';

const HEX = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';

describe('parseMagnet', () => {
  it('accepts bare hex hash', () => {
    expect(parseMagnet(HEX.toUpperCase())?.infoHash).toBe(HEX);
  });
  it('parses magnet with name and trackers', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexample.org%3A80`);
    expect(m?.infoHash).toBe(HEX);
    expect(m?.name).toBe('Big Buck Bunny');
    expect(m?.trackers).toContain('udp://example.org:80');
  });
  it('decodes base32 btih', () => {
    // base32 of 20 zero bytes
    expect(base32ToHex('A'.repeat(32))).toBe('0'.repeat(40));
    expect(parseMagnet(`magnet:?xt=urn:btih:${'A'.repeat(32)}`)?.infoHash).toBe('0'.repeat(40));
  });
  it('rejects junk', () => {
    expect(parseMagnet('hello world')).toBeNull();
    expect(parseMagnet('magnet:?xt=urn:btih:xyz')).toBeNull();
  });
});
