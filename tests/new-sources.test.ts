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

describe('Bitsearch: current page layout', () => {
  const card = (name: string, hash: string, size: string, seeders: string, leechers: string) => `
<div class="torrent-result-card bg-white rounded-lg p-6">
  <div class="flex-1 min-w-0">
    <h3 class="text-base font-medium"><a href="/torrent/662056817a868426ce3c2153">
        ${name}
    </a></h3>
    <div class="torrent-result-meta flex">
      <span class="inline-flex"><i class="fas fa-file text-gray-500"></i><span>Movies/WEB-DL/WebRip</span></span>
      <span class="inline-flex items-center space-x-1">
        <i class="fas fa-download"></i>
        <span>${size}</span>
      </span>
    </div>
    <div class="torrent-result-meta flex">
      <span class="inline-flex text-green-600"><i class="fas fa-arrow-up"></i>
        <span class="font-medium">${seeders}</span>
        <span>seeders</span></span>
      <span class="inline-flex text-red-600"><i class="fas fa-arrow-down"></i>
        <span class="font-medium">${leechers}</span>
        <span>leechers</span></span>
      <span class="inline-flex text-blue-600"><i class="fas fa-download"></i><span class="font-medium">1184</span><span>downloads</span></span>
    </div>
  </div>
  <a href="/download/torrent/${hash}?title=x" class="btn">Download</a>
</div>`;

  it('reads results and treats wrapped counts (4294967xxx) as unknown', () => {
    const html = card('Dune.Part.Two.2024.1080p.WEB-DL.H264.AAC-InMemoryOfEVO', 'C4B1E1C30F31673B4F93BC426080A7DAE5465F97', '6.59 GB', '2528', '3586')
      + card('Dune.Part.Two.2024.2160p.WEB-DL', 'D'.repeat(40), '20.36 GB', '4294967231', '4294967246')
      + card('Dune.Part.Two.2024.1080p.x264', 'E'.repeat(40), '1.57 GB', '779', '4294967715');
    const r = parseBitsearchHtml(html);
    expect(r.map((x) => [x.title, x.infoHash, x.seeders, x.leechers])).toEqual([
      ['Dune.Part.Two.2024.1080p.WEB-DL.H264.AAC-InMemoryOfEVO', 'c4b1e1c30f31673b4f93bc426080a7dae5465f97', 2528, 3586],
      ['Dune.Part.Two.2024.1080p.x264', 'e'.repeat(40), 779, 0],
    ]);
    expect(r[0].sizeBytes).toBeGreaterThan(6.5e9);
    expect(r[0].magnet).toContain('xt=urn:btih:c4b1e1c30f31673b4f93bc426080a7dae5465f97');
  });
});
