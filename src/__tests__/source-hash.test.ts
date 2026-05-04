import { fnv1a32 } from '../tools/structure-map-cache.js';

describe('fnv1a32', () => {
  test.each([
    ['', '811c9dc5'],
    ['a', 'e40c292c'],
    ['hello', '4f9f2cab'],
  ])('hashes %j deterministically', (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });
});
