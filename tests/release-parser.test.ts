import { describe, expect, it } from 'vitest';
import { formatBytes, parseRelease, parseSize } from '@/lib/release-parser';

describe('parseRelease', () => {
  it('parses a 4K remux', () => {
    const r = parseRelease('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-FGT');
    expect(r.quality).toBe('4K');
    expect(r.remux).toBe(true);
    expect(r.hdr).toEqual(expect.arrayContaining(['DV', 'HDR10']));
    expect(r.videoCodec).toBe('HEVC');
    expect(r.audio).toEqual(expect.arrayContaining(['TrueHD', 'Atmos']));
    expect(r.channels).toBe('7.1');
    expect(r.releaseGroup).toBe('FGT');
    expect(r.year).toBe(2024);
  });
  it('parses 1080p web with DDP5.1', () => {
    const r = parseRelease('The.Bear.S03E04.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv');
    expect(r.quality).toBe('1080p');
    expect(r.source).toBe('WEB-DL');
    expect(r.audio).toContain('DDP');
    expect(r.channels).toBe('5.1');
    expect(r.season).toBe(3);
    expect(r.episode).toBe(4);
    expect(r.releaseGroup).toBe('NTb');
  });
  it('parses 720p and AAC', () => {
    const r = parseRelease('Movie 2019 720p BRRip x264 AAC-YTS');
    expect(r.quality).toBe('720p');
    expect(r.audio).toContain('AAC');
    expect(r.source).toBe('BluRay');
  });
  it('detects CAM as SD', () => {
    expect(parseRelease('Film.2025.HDCAM.x264').quality).toBe('SD');
    expect(parseRelease('Film.2025.HDCAM.x264').source).toBe('CAM');
  });
});

describe('sizes', () => {
  it('parses and formats', () => {
    expect(parseSize('1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('700MiB')).toBe(700 * 1024 ** 2);
    expect(parseSize('2,3 GB')).toBe(Math.round(2.3 * 1024 ** 3));
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
    expect(formatBytes(undefined)).toBe('—');
  });
});
