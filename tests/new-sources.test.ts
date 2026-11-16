import { describe, expect, it } from 'vitest';
import { parseBitsearchHtml } from '@/lib/torrent-indexer';

const card = (name: string, hash: string, size: string, seeders: number, leechers: number) => `
<li class="card search-result my-2">
  <div class="info px-3 pt-2 pb-3">
    <h5 class="title w-100 truncate"><a href="/torrent/x">${name}</a></h5>
    <div class="stats">
      <div><img src="/icons/download.svg" alt="Download">2.1K</div>
      <div><img src="/icons/size.svg" alt="Size">${size}</div>
      <div><img src="/icons/seed.svg" alt="Seeder"><font color="#0AB49A">${seeders}</font></div>
      <div><img src="/icons/leech.svg" alt="Leecher"><font color="#C35257">${leechers}</font></div>
    </div>
  </div>
  <div class="links"><a class="dl-magnet" href="magnet:?xt=urn:btih:${hash}&amp;dn=${encodeURIComponent(name)}&amp;tr=udp%3A%2F%2Ft"></a></div>
</li>`;

describe('Bitsearch results page', () => {
  it('reads title, magnet, size, seeders and leechers from each result', () => {
    const html = `<ul>${card('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', 'a'.repeat(40), '6.2 GB', 812, 33)}${card('Dune &amp; Friends 720p', 'b'.repeat(40), '900 MB', 0, 1)}</ul>`;
    const r = parseBitsearchHtml(html);
    expect(r).toHaveLength(1); // 0 seeders dropped
    expect(r[0]).toMatchObject({ title: 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', infoHash: 'a'.repeat(40), seeders: 812, leechers: 33, quality: '1080p', indexer: 'bitsearch' });
    expect(r[0].sizeBytes).toBeGreaterThan(6e9);
    expect(r[0].magnet).toContain('xt=urn:btih:' + 'a'.repeat(40));
  });

  it('copes with nothing found or a changed page', () => {
    expect(parseBitsearchHtml('<html><body>No results found</body></html>')).toEqual([]);
  });
});
