import { describe, expect, it } from 'vitest';
import { playerBack, rank, topLayer, type Box } from '@/lib/tv';

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });
const at = (items: Record<string, Box>) => Object.entries(items).map(([item, r]) => ({ item, r }));

// A TV home screen at 960×540: rows of posters 150 wide with 22px gaps, rows ~260px apart.
const row = (name: string, top: number, n = 5, w = 150, x0 = 48) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${name}${i}`, box(x0 + i * (w + 22), top, w, 225)]));

describe('TV remote: where a press goes', () => {
  it('Down goes to the next row, to the poster under you, not to a row further down', () => {
    const items = at({ ...row('b', 300), ...row('c', 560) });
    expect(rank(box(392, 40, 150, 225), items, 'down')[0]).toBe('b2');
  });

  it('Down to a row of narrower items picks the nearest row even when nothing sits exactly below', () => {
    // A lone small control off to the left in the next line still beats a perfectly aligned one two lines down.
    const items = at({ near: box(48, 300, 80, 40), far: box(392, 600, 150, 225) });
    expect(rank(box(392, 40, 150, 225), items, 'down')[0]).toBe('near');
  });

  it('Left/Right never jump diagonally to another row', () => {
    // At the end of a row, a poster further right in the next row down must not be taken.
    const items = at({ ...row('b', 300), b5: box(908, 300, 150, 225) });
    expect(rank(box(736, 40, 150, 225), items, 'right')).toEqual([]);
    expect(rank(box(48, 40, 150, 225), items, 'left')).toEqual([]);
  });

  it('Right goes to the next item level with you', () => {
    const items = at({ ...row('a', 40) });
    expect(rank(box(48, 40, 150, 225), items.filter((x) => x.item !== 'a0'), 'right')[0]).toBe('a1');
  });

  it('Up from a lower row goes to the row above, not past it', () => {
    const items = at({ ...row('a', -220), ...row('b', 40) });
    expect(rank(box(220, 300, 150, 225), items, 'up')[0]).toBe('b1');
  });

  it('a wide paragraph leads from its start: Down lands on the first chip, not the middle one', () => {
    const chips = at({ hd: box(309, 330, 90, 32), k4: box(126, 330, 70, 32), all: box(48, 330, 70, 32) });
    expect(rank(box(48, 230, 860, 80), chips, 'down')[0]).toBe('all');
  });

  it('things beside you are not "below" you just because they are taller', () => {
    // A tall poster to the right whose centre is lower must not win Down from a short button.
    const items = at({ tall: box(300, 10, 150, 225), below: box(48, 120, 120, 40) });
    expect(rank(box(48, 40, 120, 40), items, 'down')[0]).toBe('below');
  });
});

describe('TV remote: Back in the player', () => {
  it('paused (controls stay up): Back leaves the player at once, even with a control focused', () => {
    expect(playerBack({ panel: false, playing: false, focusInPlayer: true })).toBe('leave');
  });
  it('playing with a control focused: Back first hides the controls', () => {
    expect(playerBack({ panel: false, playing: true, focusInPlayer: true })).toBe('hide-controls');
  });
  it('playing with the controls already hidden: Back leaves', () => {
    expect(playerBack({ panel: false, playing: true, focusInPlayer: false })).toBe('leave');
  });
  it('a sheet open: Back closes it first', () => {
    expect(playerBack({ panel: true, playing: false, focusInPlayer: true })).toBe('close-panel');
  });
});

describe('TV remote: which window the arrows work in', () => {
  it('a drop-down list opened from a sheet: the list, not the sheet behind it', () => {
    expect(topLayer(['subtitle sheet'], 'drop-down list', 'player')).toBe('drop-down list');
  });
  it('a sheet opened over another one: the newer one', () => {
    expect(topLayer(['sheet', 'sheet on top'], undefined, 'player')).toBe('sheet on top');
  });
  it('no window open: the player', () => {
    expect(topLayer([], undefined, 'player')).toBe('player');
  });
});
