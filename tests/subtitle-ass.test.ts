import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseSubtitles } from '@/lib/subtitle-parser';
import { encodeToken, fetchSubtitleCues } from '@/lib/subtitles';

const ASS = `[Script Info]
Title: test

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8}مرحبا، يا صديقي\\Nكيف حالك؟
Dialogue: 1,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8}مرحبا، يا صديقي\\Nكيف حالك؟
Dialogue: 0,0:01:02.25,0:01:04.00,Default,,0,0,0,,Line, with, commas
Dialogue: 0,0:00:05.00,0:00:06.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}
`;

afterEach(() => vi.unstubAllGlobals());

describe('ASS/SSA subtitles (usual for anime)', () => {
  it('reads dialogue lines with times, line breaks and commas in the text', () => {
    expect(parseSubtitles(ASS)).toEqual([
      { start: 1.5, end: 3, text: 'مرحبا، يا صديقي\nكيف حالك؟' },
      { start: 62.25, end: 64, text: 'Line, with, commas' },
    ]);
  });

  const token = (url: string) => encodeToken({ p: 'subdl', url, lang: 'ar', season: 4, episode: 6 });

  it('opens a SubDL archive that holds an .ass file', async () => {
    const zip = zipSync({ 'Shingeki no Kyojin - 65.ass': strToU8(ASS) });
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) }));
    const cues = await fetchSubtitleCues(token('/subtitle/123-456.zip'), {});
    expect(cues).toHaveLength(2);
  });

  it('explains a RAR archive and a failed download instead of a confusing error', async () => {
    const rar = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => rar.buffer }));
    await expect(fetchSubtitleCues(token('/subtitle/1-2.zip'), {})).rejects.toThrow(/RAR/);
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(fetchSubtitleCues(token('/subtitle/1-2.zip'), {})).rejects.toThrow('SubDL download 404');
  });
});
