import { describe, expect, it } from 'vitest';
import { shownCues } from '@/lib/subtitle-parser';

const cue = (start: number, end: number, text: string) => ({ start, end, text });
// From Breaking Bad S1E1's English file: "Skyler." ends 0.26 s before the next line starts.
const cues = [cue(155.9, 157.84, 'Skyler.'), cue(158.1, 159.8, 'You are the love of my life.'), cue(165, 167, 'Later.')];

describe('subtitles: short gaps between lines', () => {
  it('keeps the line on screen through a short gap, so it doesn’t blink off and on', () => {
    expect(shownCues(cues, 157.95).map((c) => c.text)).toEqual(['Skyler.']);
  });
  it('the next line replaces it as soon as it starts', () => {
    expect(shownCues(cues, 158.1).map((c) => c.text)).toEqual(['You are the love of my life.']);
  });
  it('a real pause in the dialogue still clears the screen', () => {
    expect(shownCues(cues, 161)).toEqual([]);
  });
  it('nothing before the first line, nothing after the last', () => {
    expect(shownCues(cues, 100)).toEqual([]);
    expect(shownCues(cues, 167.2)).toEqual([]);
  });
});
