import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
// @ts-expect-error plain JavaScript module without type declarations
import { checkAll } from '../src/fitCheck.mjs';

/** A box from min to max corner, subdivided so the joint has enough sample points. */
function box(min: [number, number, number], max: [number, number, number]) {
  const size = max.map((v, i) => v - min[i]);
  const g = new THREE.BoxGeometry(size[0], size[1], size[2], Math.ceil(size[0] * 2), Math.ceil(size[1] * 2), Math.ceil(size[2] * 2));
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return { positions: g.attributes.position!.array as Float32Array, index: g.index!.array as Uint16Array };
}

// Shanks are two arms rising to z = 10 on either side of the centre; heads sit across the arm ends.
const wideArms = [box([-6, -1.5, 0], [-3, 1.5, 10]), box([3, -1.5, 0], [6, 1.5, 10])];
const rings = [
  // Ring A: a wide head joined over both arm ends.
  { shankTop: 10, shank: wideArms, head: [box([-6.5, -1.6, 9.5], [6.5, 1.6, 13])] },
  // Ring B: same arms, a different (taller) head built to the same joint, so heads A and B interchange.
  { shankTop: 10, shank: wideArms, head: [box([-6.5, -1.6, 9.5], [6.5, 1.6, 15])] },
  // Ring C: narrow arms close to the centre with a small head that only reaches |x| <= 3.
  { shankTop: 10, shank: [box([-2.5, -1.5, 0], [-1, 1.5, 10]), box([1, -1.5, 0], [2.5, 1.5, 10])], head: [box([-3, -1.6, 9.5], [3, 1.6, 12])] },
];

describe('fit check', () => {
  const fit = checkAll(rings);

  it('accepts each ring as its designer made it', () => {
    for (const i of [0, 1, 2]) {
      expect(fit[`${i}-${i}`].verdict).toBe('fits');
      expect(fit[`${i}-${i}`].shift).toBe(0);
    }
  });

  it('accepts heads built to the same joint', () => {
    expect(fit['0-1'].verdict).toBe('fits');
    expect(fit['1-0'].verdict).toBe('fits');
  });

  it('rejects a small head that leaves the arm ends of a wide shank uncovered', () => {
    expect(fit['2-0'].verdict).toBe('no');
    expect(Math.min(fit['2-0'].armLeft, fit['2-0'].armRight)).toBeLessThan(0.6);
  });

  it('rejects a wide head whose joint has nothing to rest on', () => {
    expect(fit['0-2'].verdict).toBe('no');
    expect(fit['0-2'].headSupported).toBeLessThan(0.6);
  });
});
