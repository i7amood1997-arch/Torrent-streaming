import { describe, expect, it } from 'vitest';
import { activeCues, autoSelectTracks, decodeSubtitleBytes, parseSubtitles, releaseSimilarity, toVtt } from '@/lib/subtitle-parser';
import { pickFile } from '@/lib/debrid';

const SRT = `1
00:00:01,000 --> 00:00:03,500
<i>مرحبا بالعالم</i>

2
00:00:04,000 --> 00:00:06,000
Second line
two
`;

describe('subtitle parsing', () => {
  it('parses SRT and strips tags', () => {
    const cues = parseSubtitles(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: 'مرحبا بالعالم' });
    expect(cues[1].text).toBe('Second line\ntwo');
  });
  it('finds active cues', () => {
    const cues = parseSubtitles(SRT);
    expect(activeCues(cues, 2)[0].start).toBe(1);
    expect(activeCues(cues, 3.7)).toHaveLength(0);
    expect(activeCues(cues, 5)[0].start).toBe(4);
  });
  it('decodes windows-1256 Arabic', () => {
    // "سلام" in cp1256
    const bytes = new Uint8Array([0xd3, 0xe1, 0xc7, 0xe3]);
    expect(decodeSubtitleBytes(bytes, 'ar')).toBe('سلام');
  });
  it('serialises VTT with offset', () => {
    const vtt = toVtt(parseSubtitles(SRT), 1.5);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:02.500 --> 00:00:05.000');
  });
  it('ranks by release similarity and picks ar+en', () => {
    const rel = 'Movie.2023.1080p.WEB-DL.DDP5.1.H.264-FLUX';
    expect(releaseSimilarity(rel, 'Movie.2023.1080p.WEB-DL.DDP5.1.H.264-FLUX')).toBe(1);
    const t = (id: string, lang: string, name: string) => ({ id, lang, provider: 'subdl' as const, label: id, token: id, releaseName: name, score: releaseSimilarity(name, rel) });
    const best = autoSelectTracks([t('a', 'ar', 'Movie.2023.720p.BluRay-X'), t('b', 'ar', 'Movie.2023.1080p.WEB-DL-FLUX'), t('c', 'en', 'Movie 2023')]);
    expect(best.ar?.id).toBe('b');
    expect(best.en?.id).toBe('c');
  });
});

describe('pickFile', () => {
  const files = [
    { index: 0, id: 1, name: 'Show/Sample.mkv', size: 50 },
    { index: 1, id: 2, name: 'Show/Show.S01E01.mkv', size: 1000 },
    { index: 2, id: 3, name: 'Show/Show.S01E02.mkv', size: 900 },
    { index: 3, id: 4, name: 'Show/info.nfo', size: 1 },
  ];
  it('prefers fileIdx, then episode, then largest', () => {
    expect(pickFile(files, 2)?.id).toBe(3);
    expect(pickFile(files, undefined, 1, 2)?.id).toBe(3);
    expect(pickFile(files)?.id).toBe(2);
  });
});
