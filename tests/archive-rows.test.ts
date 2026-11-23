import { describe, expect, it } from 'vitest';
import { handleApi } from '@/lib/server/handlers';

const fake = (routes: Record<string, unknown>, asked: string[] = []) => (async (u: string) => {
  asked.push(u);
  const k = Object.keys(routes).find((x) => u.includes(x));
  return k ? new Response(JSON.stringify(routes[k])) : new Response('nope', { status: 404 });
}) as unknown as typeof fetch;

describe('free library rows (Internet Archive)', () => {
  it('lists a collection, most watched first, with posters', async () => {
    const asked: string[] = [];
    const archiveFetch = fake({ advancedsearch: { response: { docs: [{ identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: '1968' }, { identifier: 'no_title' }] } } }, asked);
    const r = await handleApi(new Request('https://relay.test/api/archive?collection=SciFi_Horror'), {}, { archiveFetch });
    expect(await r.json()).toEqual({ results: [{ id: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: 1968, poster: 'https://archive.org/services/img/night_of_the_living_dead' }] });
    expect(decodeURIComponent(asked[0])).toContain('collection:(SciFi_Horror) AND mediatype:(movies)');
    expect(decodeURIComponent(asked[0])).toContain('sort[]=downloads+desc');
  });

  it('only the offered collections', async () => {
    const r = await handleApi(new Request('https://relay.test/api/archive?collection=anything'), {}, { archiveFetch: fake({}) });
    expect(r.status).toBe(400);
  });

  it('plays the best MP4 (a short cartoon counts too), never a trailer', async () => {
    const archiveFetch = fake({ metadata: { metadata: { title: 'Popeye' }, files: [
      { name: 'popeye_trailer.mp4', length: '60', height: '1080' },
      { name: 'popeye_512kb.mp4', length: '06:10', height: '360', size: '20000000' },
      { name: 'popeye.ogv', length: '370' },
      { name: 'popeye HD.mp4', length: '370', height: '720', size: '90000000' },
    ] } });
    const r = await handleApi(new Request('https://relay.test/api/archive/play?id=popeye_cartoon'), {}, { archiveFetch });
    expect(await r.json()).toEqual({ url: 'https://archive.org/download/popeye_cartoon/popeye%20HD.mp4', title: 'Popeye', fileName: 'popeye HD.mp4' });
    expect((await handleApi(new Request('https://relay.test/api/archive/play?id=../etc'), {}, { archiveFetch })).status).toBe(400);
  });
});
