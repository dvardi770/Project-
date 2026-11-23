import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
// @ts-expect-error plain JavaScript module without type declarations
import { decodeMesh, encodeMesh } from '../src/meshData.mjs';

/** A rounded shape with real normals, standing in for a ring part (about 20 mm across). */
function sample() {
  const g = new THREE.TorusGeometry(9, 1.6, 24, 96);
  const P = g.attributes.position!.array as Float32Array;
  const N = g.attributes.normal!.array as Float32Array;
  const I = Uint32Array.from(g.index!.array as ArrayLike<number>);
  const ao = Float32Array.from({ length: P.length / 3 }, (_, i) => (i % 17) / 16);
  return { P, N, I, ao };
}

async function roundTrip() {
  const { P, N, I, ao } = sample();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    const at = offset;
    chunks.push(new Uint8Array(bytes));
    offset += bytes.length;
    return at;
  };
  const rec = await encodeMesh({ P, N, I }, ao, push);
  const all = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return { P, N, I, ao, rec, bytes: offset, out: await decodeMesh(rec, all.buffer) };
}

/** For each decoded vertex, the index of the nearest original vertex and how far away it is. */
function matchVertices(P: Float32Array, positions: Float32Array) {
  const n = P.length / 3;
  return Array.from({ length: positions.length / 3 }, (_, i) => {
    let best = -1, dist = Infinity;
    for (let j = 0; j < n; j++) {
      const d = Math.hypot(positions[i * 3]! - P[j * 3]!, positions[i * 3 + 1]! - P[j * 3 + 1]!, positions[i * 3 + 2]! - P[j * 3 + 2]!);
      if (d < dist) { dist = d; best = j; }
    }
    return { at: best, dist };
  });
}
/** Triangles as sorted corner lists, independent of vertex and triangle order. */
const triangles = (index: ArrayLike<number>, map: (v: number) => number = (v) => v) => {
  const out: string[] = [];
  for (let t = 0; t < index.length; t += 3) out.push([map(index[t]!), map(index[t + 1]!), map(index[t + 2]!)].sort((a, b) => a - b).join(','));
  return out.sort();
};

describe('compressed mesh data', () => {
  it('keeps every vertex and triangle', async () => {
    const { P, I, out } = await roundTrip();
    const match = matchVertices(P, out.positions);
    expect(Math.max(...match.map((m) => m.dist))).toBeLessThan(0.0005); // mm: well under a micron
    expect(out.index.length).toBe(I.length);
    // The torus has duplicate vertices on its seam; compare triangles by position, not by original index.
    const canonical = matchVertices(P, P).map((m) => m.at);
    expect(triangles(out.index, (v) => canonical[match[v]!.at]!)).toEqual(triangles(I, (v) => canonical[v]!));
  });

  it('keeps normals and occlusion close', async () => {
    const { P, N, ao, out } = await roundTrip();
    const match = matchVertices(P, out.positions);
    let worstAngle = 0, worstAo = 0;
    match.forEach(({ at }, i) => {
      const dot = out.normals[i * 3]! * N[at * 3]! + out.normals[i * 3 + 1]! * N[at * 3 + 1]! + out.normals[i * 3 + 2]! * N[at * 3 + 2]!;
      worstAngle = Math.max(worstAngle, Math.acos(Math.min(1, dot)));
      worstAo = Math.max(worstAo, Math.abs(out.ao[i]! / 255 - ao[at]!));
    });
    expect(worstAngle).toBeLessThan(0.001); // radians
    expect(worstAo).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
  });

  it('is much smaller than plain float data', async () => {
    const { P, N, I, bytes } = await roundTrip();
    expect(bytes).toBeLessThan((P.byteLength + N.byteLength + I.byteLength) / 2.5);
  });
});
