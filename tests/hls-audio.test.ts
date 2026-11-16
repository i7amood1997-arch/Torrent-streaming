import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openHls, parseMediaPlaylist, pickAudioPlaylist, tsToAdts } from '@/lib/speech/hls-audio';
import { planWindows } from '@/lib/presync';

const ts = new Uint8Array(readFileSync('tests/fixtures/h264-aac.mpegts'));

/** Count ADTS frames (sync word 0xFFF + frame length) — proof the AAC audio came out whole. */
function adtsFrames(b: Uint8Array): number {
  let n = 0;
  for (let o = 0; o + 7 <= b.length;) {
    if (b[o] !== 0xff || (b[o + 1] & 0xf0) !== 0xf0) return -1;
    const len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5);
    o += len;
    n++;
  }
  return n;
}

describe('HLS audio for subtitle sync (Real-Debrid on iPhone)', () => {
  it('pulls the AAC audio out of an MPEG-TS segment (video skipped)', () => {
    const aac = tsToAdts(ts);
    expect(aac.length).toBeLessThan(ts.length / 2);
    expect(adtsFrames(aac)).toBeGreaterThan(160); // 4 s at 44.1 kHz ≈ 172 frames
  });

  it('chooses the lightest stream, or a separate audio rendition', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nhi/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlo/index.m3u8\n';
    expect(pickAudioPlaylist(master, 'https://h/x/master.m3u8')).toBe('https://h/x/lo/index.m3u8');
    const withAudio = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"\nlo.m3u8\n';
    expect(pickAudioPlaylist(withAudio, 'https://h/x/master.m3u8')).toBe('https://h/x/audio/en.m3u8');
  });

  it('knows when each segment starts, and refuses encrypted streams clearly', () => {
    const segs = parseMediaPlaylist('#EXTM3U\n#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\nb.ts\n#EXTINF:4.5,\nc.ts\n#EXT-X-ENDLIST', 'https://h/p/');
    expect(segs.map((s) => [s.uri.split('/').pop(), s.start])).toEqual([['a.ts', 0], ['b.ts', 6], ['c.ts', 12]]);
    expect(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts', 'https://h/')).toThrow(/encrypted/);
  });

  it('reads a time range by fetching only the segments that cover it', async () => {
    const fetched: string[] = [];
    const files: Record<string, string | Uint8Array> = {
      'https://h/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlo.m3u8\n',
      'https://h/lo.m3u8': '#EXTM3U\n#EXTINF:4.0,\ns0.ts\n#EXTINF:4.0,\ns1.ts\n#EXTINF:4.0,\ns2.ts\n#EXTINF:4.0,\ns3.ts\n#EXT-X-ENDLIST',
      'https://h/s0.ts': ts, 'https://h/s1.ts': ts, 'https://h/s2.ts': ts, 'https://h/s3.ts': ts,
    };
    const fetchFn = (async (u: string) => { fetched.push(String(u)); const f = files[String(u)]; return new Response(f as BodyInit, { status: f ? 200 : 404 }); }) as unknown as typeof fetch;
    const src = await openHls('https://h/master.m3u8', undefined, fetchFn);
    expect(src.duration).toBe(16);
    const clip = await src.read(5, 9);
    expect(fetched.filter((u) => u.endsWith('.ts'))).toEqual(['https://h/s1.ts', 'https://h/s2.ts']);
    expect(clip.start).toBe(4);
    expect(clip.mime).toBe('audio/aac');
    expect(adtsFrames(clip.bytes)).toBeGreaterThan(300);
  });
});

describe('sync stretches for relay torrents', () => {
  it('stay within the start of the film when asked to', () => {
    const cues = Array.from({ length: 600 }, (_, i) => ({ start: 30 + i * 10, end: 33 + i * 10, text: 'x' }));
    const starts = planWindows(cues, 30 + 20 * 60, 4, 25);
    expect(starts.length).toBe(4);
    for (const s of starts) expect(s + 25).toBeLessThanOrEqual(30 + 20 * 60);
  });
});
