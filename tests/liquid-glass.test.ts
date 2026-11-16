import { describe, expect, it } from 'vitest';
import { glassMap, lensFor, refractionShift } from '@/lib/liquid-glass';

/** The shift (in pixels) the map asks for at (x, y), decoded the way feDisplacementMap does. */
function shiftAt(m: ReturnType<typeof glassMap>, x: number, y: number) {
  const i = (y * m.width + x) * 4;
  return { dx: m.scale * (m.data[i] / 255 - 0.5), dy: m.scale * (m.data[i + 1] / 255 - 0.5) };
}

describe('Liquid Glass lens', () => {
  it('bends light most at the very rim and not at all where the glass is flat', () => {
    expect(refractionShift(0)).toBeGreaterThan(0.5); // the steep outer lip bends hardest
    expect(refractionShift(0.2)).toBeLessThan(refractionShift(0.05));
    expect(refractionShift(0.6)).toBeLessThan(refractionShift(0.2));
    expect(refractionShift(1)).toBe(0);
    expect(refractionShift(0.999)).toBeLessThan(0.01);
    // A broad band, not a one-pixel line: still bending noticeably halfway across the rim.
    expect(refractionShift(0.5) / refractionShift(0)).toBeGreaterThan(0.4);
  });

  it('a capsule bar: flat middle, rim pulls the backdrop inward, mirrored on each side', () => {
    const w = 240, h = 62;
    const { bezel, strength } = lensFor(w, h);
    const m = glassMap(w, h, h / 2, bezel, strength);
    // Middle of the bar: no displacement (encoded as 128).
    const mid = shiftAt(m, 120, 31);
    expect(Math.abs(mid.dx)).toBeLessThan(0.2);
    expect(Math.abs(mid.dy)).toBeLessThan(0.2);
    // Top edge looks downward (inward), bottom edge upward, by about the same amount.
    const top = shiftAt(m, 120, 0);
    const bottom = shiftAt(m, 120, 61);
    expect(top.dy).toBeGreaterThan(strength * 0.5);
    expect(bottom.dy).toBeLessThan(-strength * 0.5);
    expect(Math.abs(top.dy + bottom.dy)).toBeLessThan(0.5);
    // Left cap looks right (inward), right cap looks left.
    expect(shiftAt(m, 0, 31).dx).toBeGreaterThan(strength * 0.5);
    expect(shiftAt(m, 239, 31).dx).toBeLessThan(-strength * 0.5);
    // Weaker as you move in from the rim.
    expect(shiftAt(m, 120, 6).dy).toBeLessThan(top.dy);
    expect(shiftAt(m, 120, 6).dy).toBeGreaterThan(0);
  });

  it('a round button gets a narrower rim than a wide bar', () => {
    expect(lensFor(32, 32).bezel).toBeLessThan(lensFor(300, 62).bezel);
    const m = glassMap(48, 48, 24, lensFor(48, 48).bezel, lensFor(48, 48).strength);
    expect(m.data.length).toBe(48 * 48 * 4);
    // Diagonal rim points inward along the diagonal.
    const d = shiftAt(m, 8, 8);
    expect(d.dx).toBeGreaterThan(0);
    expect(d.dy).toBeGreaterThan(0);
    expect(Math.abs(d.dx - d.dy)).toBeLessThan(0.6);
  });
});
