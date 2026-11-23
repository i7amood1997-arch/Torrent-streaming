import { expect, it } from 'vitest';
import { buildIdIn } from '@/lib/update-check';

it('reads the build id from the page', () => {
  expect(buildIdIn('<html><head><meta name="streamdeck-build" content="d6e5f44"/><title>x</title>')).toBe('d6e5f44');
  expect(buildIdIn('<html><head></head>')).toBeUndefined();
});
