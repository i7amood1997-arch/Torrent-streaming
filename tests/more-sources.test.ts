import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import { parseTheRarbgList, parseTorrentClaw, parseTorrentDownloadHtml, parseTorrentGalaxyHtml, searchTorrents, configFromEnv } from '@/lib/torrent-indexer';

const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40);

describe('TorrentClaw', () => {
  it('reads its JSON (every release of every title)', () => {
    const r = parseTorrentClaw({ results: [{ title: 'Dune: Part Two', torrents: [
      { infoHash: H1.toUpperCase(), rawTitle: 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264', sizeBytes: 6e9, seeders: 812, leechers: 40 },
      { infoHash: 'nothash', rawTitle: 'broken' },
    ] }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ infoHash: H1, seeders: 812, leechers: 40, quality: '1080p', indexer: 'torrentclaw' });
    expect(r[0].magnet).toContain(H1);
  });
});

describe('TorrentDownload', () => {
  it('reads the hash, name, size and swarm from each row', () => {
    const html = `<table><tr><td class="tdleft"><div class="tt-name"><a href="/${H1.toUpperCase()}/Severance-S02E01-1080p">Severance <b>S02E01</b> 1080p WEB H264</a> <span class="smallish">&raquo; TV</span></div></td>
      <td class="tdnormal">2 days</td> <td class="tdnormal">1.9 GB</td> <td class="tdseed">1,204</td> <td class="tdleech">88</td></tr></table>`;
    const r = parseTorrentDownloadHtml(html);
    expect(r).toEqual([expect.objectContaining({ infoHash: H1, title: 'Severance S02E01 1080p WEB H264', seeders: 1204, leechers: 88, indexer: 'torrentdownload' })]);
    expect(r[0].sizeBytes).toBeGreaterThan(1.8e9);
  });
});

describe('TorrentGalaxy', () => {
  it('reads magnet, title, size, seeders and leechers from each row', () => {
    const html = `<div class="tgxtable"><div class="tgxtablerow txlight"><div class="tgxtablecell"><a class="txlight" title="The Bear S03 1080p WEB h264-ETHEL" href="/torrent/1/x"><b>The Bear</b></a></div>
      <div class="tgxtablecell"><a role="button" href="magnet:?xt=urn:btih:${H2}&amp;dn=The.Bear&amp;tr=udp%3A%2F%2Ft"><i></i></a></div>
      <div class="tgxtablecell"><span class="badge badge-secondary txlight">14.6 GB</span></div>
      <div class="tgxtablecell"><span><font color='green'><b>2,311</b></font>/<font color='#ff0000'><b>97</b></font></span></div></div></div>`;
    expect(parseTorrentGalaxyHtml(html)).toEqual([expect.objectContaining({ infoHash: H2, title: 'The Bear S03 1080p WEB h264-ETHEL', seeders: 2311, leechers: 97, indexer: 'torrentgalaxy' })]);
  });
});

describe('TheRARBG', () => {
  it('lists results with their pages; only the best few pages are opened for magnets', async () => {
    const row = (n: number, seeds: number) => `<tr><td><img></td><td><a href="post-detail/${n}/Movie.${n}.1080p/">Movie ${n} 1080p</a></td><td><a>Movies</a></td><td>x</td><td>y</td><td>1.5 GB</td><td>${seeds}</td><td>3</td></tr>`;
    const list = `<title>Search for x</title><table><tbody>${Array.from({ length: 10 }, (_, i) => row(i, (i + 1) * 10)).join('')}</tbody></table>`;
    expect(parseTheRarbgList(list, 'https://therarbg.test')[0]).toMatchObject({ title: 'Movie 0 1080p', page: 'https://therarbg.test/post-detail/0/Movie.0.1080p/', seeders: 10 });
    const opened: string[] = [];
    const fetchImpl = (async (u: string) => {
      if (u.includes('/get-posts/')) return new Response(list);
      opened.push(u);
      return new Response(`<a href="magnet:?xt=urn:btih:${String(opened.length).repeat(40).slice(0, 40)}&amp;dn=x">Magnet</a>`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const res = await searchTorrents({ q: 'movie' }, configFromEnv({ INDEXERS: 'therarbg', THERARBG_URL: 'https://therarbg.test' }));
    expect(opened).toHaveLength(6); // the six most seeded
    expect(res.results.map((r) => r.seeders)).toEqual([100, 90, 80, 70, 60, 50]);
  });
});
