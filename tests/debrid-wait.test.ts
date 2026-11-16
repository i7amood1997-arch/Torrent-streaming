import { describe, expect, it } from 'vitest';
import { debridStalled } from '@/lib/debrid-wait';

const at = (s: number, progress: number, seeders?: number, speed?: number) => ({ at: s * 1000, progress, seeders, speed });

describe('waiting for Real-Debrid to fetch an uncached torrent', () => {
  it('says so after 45 s at 0% with nobody sharing it', () => {
    const h = [at(0, 0, 0), at(20, 0, 0), at(40, 0, 0)];
    expect(debridStalled(h, 'Real-Debrid')).toBeUndefined();
    expect(debridStalled([...h, at(46, 0, 0)], 'Real-Debrid')).toMatch(/nobody is sharing it/);
  });

  it('keeps waiting while it downloads, even slowly', () => {
    expect(debridStalled([at(0, 0, 3, 50000), at(30, 1, 3, 50000), at(60, 2, 3, 50000), at(130, 5, 3, 50000)], 'Real-Debrid')).toBeUndefined();
    expect(debridStalled([at(0, 0, 0), at(50, 0, 0, 20000)], 'Real-Debrid')).toBeUndefined(); // bytes arriving
  });

  it('without peer numbers, gives up after 2 minutes with no progress', () => {
    expect(debridStalled([at(0, 12), at(60, 12)], 'TorBox')).toBeUndefined();
    expect(debridStalled([at(0, 12), at(60, 12), at(121, 12)], 'TorBox')).toMatch(/stuck at 12%/);
  });
});
