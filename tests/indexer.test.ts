import { describe, expect, it } from 'vitest';
import { mergeResults, parseTorrentioStream, parseTorznabXml, sortBySeeders, textQueryFor } from '@/lib/torrent-indexer';
import { applyFilters, DEFAULT_FILTERS } from '@/lib/result-filters';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

describe('torrentio', () => {
  it('parses stats from the title', () => {
    const r = parseTorrentioStream({
      name: 'Torrentio\n1080p',
      title: 'Show.S01.1080p.WEB-DL.DDP5.1-GRP\nShow.S01E03.1080p.WEB-DL.DDP5.1-GRP.mkv\n👤 152 💾 1.43 GB ⚙️ 1337x\nMulti Audio',
      infoHash: H1,
      fileIdx: 2,
    })!;
    expect(r.seeders).toBe(152);
    expect(r.sizeBytes).toBe(Math.round(1.43 * 1024 ** 3));
    expect(r.tracker).toBe('1337x');
    expect(r.quality).toBe('1080p');
    expect(r.fileName).toContain('S01E03');
    expect(r.id).toBe(`${H1}:2`);
    expect(r.magnet).toContain(`btih:${H1}`);
  });
});

describe('torznab', () => {
  it('parses RSS items with torznab attrs', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
      <item><title>Movie.2023.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos-FLUX</title><size>15000000000</size>
        <jackettindexer id="tgx">TorrentGalaxy</jackettindexer>
        <torznab:attr name="seeders" value="321"/><torznab:attr name="peers" value="400"/>
        <torznab:attr name="infohash" value="${H2.toUpperCase()}"/></item>
      <item><title>No hash item</title><link>http://x/y.torrent</link></item>
    </channel></rss>`;
    const res = parseTorznabXml(xml);
    expect(res).toHaveLength(1);
    expect(res[0].infoHash).toBe(H2);
    expect(res[0].seeders).toBe(321);
    expect(res[0].leechers).toBe(79);
    expect(res[0].quality).toBe('4K');
    expect(res[0].tracker).toBe('TorrentGalaxy');
  });
  it('throws on torznab error', () => {
    expect(() => parseTorznabXml('<error code="100" description="Invalid API Key"/>')).toThrow(/Invalid API Key/);
  });
});

describe('merge/sort/filter', () => {
  const base = { title: 'X 1080p', magnet: '', leechers: 0, quality: '1080p' as const, hdr: [], remux: false, audio: [] };
  it('merges duplicates keeping max seeders and fileIdx', () => {
    const merged = mergeResults([
      { ...base, id: H1, infoHash: H1, seeders: 5, indexer: 'yts', tracker: 'YTS' },
      { ...base, id: `${H1}:1`, infoHash: H1, seeders: 9, fileIdx: 1, indexer: 'torrentio', tracker: '1337x' },
      { ...base, id: H2, infoHash: H2, seeders: 50, indexer: 'apibay' },
    ]);
    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.infoHash === H1)!;
    expect(a.seeders).toBe(9);
    expect(a.fileIdx).toBe(1);
    expect(a.tracker).toBe('YTS, 1337x');
    expect(sortBySeeders(merged)[0].infoHash).toBe(H2);
  });
  it('filters by quality and min seeders', () => {
    const list = [
      { ...base, id: '1', infoHash: H1, seeders: 3, indexer: 'x' },
      { ...base, id: '2', infoHash: H2, seeders: 30, indexer: 'x', quality: '4K' as const },
    ];
    expect(applyFilters(list, { ...DEFAULT_FILTERS, qualities: ['4K'] }).map((r) => r.id)).toEqual(['2']);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, minSeeders: 10 }).map((r) => r.id)).toEqual(['2']);
  });
  it('builds text queries for id searches', () => {
    expect(textQueryFor({ title: 'Breaking Bad', type: 'series', season: 1, episode: 2 })).toBe('Breaking Bad S01E02');
    expect(textQueryFor({ title: 'Dune', year: 2021 })).toBe('Dune 2021');
  });
});
