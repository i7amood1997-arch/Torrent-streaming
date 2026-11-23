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

  it('without a key it says so instead of finding nothing', async () => {
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ results: [{ title: 'x', torrents: [{ rawTitle: 'no hash' }] }] }))) as unknown as typeof fetch);
    const res = await searchTorrents({ q: 'x' }, configFromEnv({ INDEXERS: 'torrentclaw' }));
    expect(res.errors[0].message).toMatch(/API key/);
  });

  it('with a key it sends it', async () => {
    let auth = '';
    vi.stubGlobal('fetch', (async (_u: string, init: RequestInit) => { auth = (init.headers as Record<string, string>).Authorization; return new Response(JSON.stringify({ results: [{ title: 'x', torrents: [{ infoHash: H1, rawTitle: 'X.2024.1080p', seeders: 5 }] }] })); }) as unknown as typeof fetch);
    const res = await searchTorrents({ q: 'x' }, configFromEnv({ INDEXERS: 'torrentclaw', TORRENTCLAW_API_KEY: 'k1' }));
    expect(auth).toBe('Bearer k1');
    expect(res.results).toHaveLength(1);
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

describe('Kickass Torrents', () => {
  it('lists rows, then opens only the most seeded result pages for their magnets', async () => {
    const { parseKickassList } = await import('@/lib/torrent-indexer');
    const row = (n: number, seeds: number) => `<tr class="${n % 2 ? 'odd' : 'even'}"><td><div class="torrentname"><a href="/movie-${n}-tt${n}.html" class="cellMainLink">Movie <strong class="red">${n}</strong> 1080p</a></div></td><td class="nobr center">1.4 GB</td><td class="center">x</td><td class="green center">${seeds}</td><td class="red lasttd center">2</td></tr>`;
    const list = `<table>${Array.from({ length: 8 }, (_, i) => row(i, (i + 1) * 7)).join('')}</table>`;
    expect(parseKickassList(list, 'https://kat.test')[0]).toMatchObject({ title: 'Movie 0 1080p', page: 'https://kat.test/movie-0-tt0.html', seeders: 7, leechers: 2 });
    const opened: string[] = [];
    vi.stubGlobal('fetch', (async (u: string) => {
      if (u.includes('/search/')) return new Response(list);
      opened.push(u);
      return new Response(`<a class="kaGiantButton" href="magnet:?xt=urn:btih:${'c'.repeat(39)}${opened.length}&amp;dn=m">`);
    }) as unknown as typeof fetch);
    const res = await searchTorrents({ q: 'movie' }, configFromEnv({ INDEXERS: 'kickass', KICKASS_URL: 'https://kat.test' }));
    expect(opened).toHaveLength(6);
    expect(res.results.map((r) => r.seeders)).toEqual([56, 49, 42, 35, 28, 21]);
  });
});

describe('LimeTorrents and GloTorrents', () => {
  it('LimeTorrents: rows with the hash in their .torrent link need no extra page', async () => {
    const { parseLimeTorrentsList } = await import('@/lib/torrent-indexer');
    const html = `<table class="table2"><tr><th>Name</th></tr><tr bgcolor="#F4F4F4"><td class="tdleft"><div class="tt-name"><a href="http://itorrents.org/torrent/${H1.toUpperCase()}.torrent?title=x" rel="nofollow" class="csprite_dl14"></a><a href="/Severance-S02E01-1080p-torrent-1.html">Severance S02E01 1080p</a></div></td><td class="tdnormal">2 days ago</td><td class="tdnormal">1.9 GB</td><td class="tdseed">1,234</td><td class="tdleech">56</td></tr></table>`;
    expect(parseLimeTorrentsList(html, 'https://lime.test')).toEqual([{ title: 'Severance S02E01 1080p', page: 'https://lime.test/Severance-S02E01-1080p-torrent-1.html', hash: H1, size: expect.any(Number), seeders: 1234, leechers: 56 }]);
  });
  it('GloTorrents: magnet, size and swarm from each row', async () => {
    const { parseGloTorrentsHtml } = await import('@/lib/torrent-indexer');
    const html = `<tr class='t-row'><td class='ttable_col1'><a title="Dune Part Two 2024 1080p WEB" href="/x.html"><b>Dune</b></a></td><td class='ttable_col1' align='center'><a href="magnet:?xt=urn:btih:${H2}&amp;dn=Dune"><img></a></td><td class='ttable_col1' align='center'>6.2 GB</td><td align='center'><font color='green'><b>321</b></font></td><td align='center'><font color='#ff0000'><b>12</b></font></td></tr>`;
    expect(parseGloTorrentsHtml(html)).toEqual([expect.objectContaining({ infoHash: H2, title: 'Dune Part Two 2024 1080p WEB', seeders: 321, leechers: 12 })]);
  });
});
