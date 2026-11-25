/**
 * Poses for product photos and the 360° turntable. A design stands upright as built (finger
 * along z, head up, band on the floor). Lying down, a ring rests on its side, tipped until both
 * the band's edge and the head touch the table, as it would on a jeweller's table.
 */

const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
/** Column-major 4×4 product a × b. */
export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
const transform = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

/** Sample points of a design: metal vertices and the corners of every stone. */
export function samplePoints(design, step = 7) {
  const pts = [];
  for (const g of design.groups) {
    const gm = g.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const p of g.parts) {
      const P = p.geometry.positions;
      for (let i = 0; i < P.length; i += 3 * step) pts.push(transform(gm, [P[i], P[i + 1], P[i + 2]]));
    }
    for (const s of g.stones) for (const m of s.matrices) {
      // The girdle's extent and the table and culet are enough to bound a stone.
      for (const c of [[0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.7], [0, 0, -0.7], [0, 0.17, 0], [0, -0.45, 0]]) pts.push(transform(multiply(gm, m), c));
    }
  }
  return pts;
}

/**
 * The matrix that lays an upright design on its side, resting on the floor (y = 0) on both its
 * band and its head. `headAbove`: points higher than this (upright) count as the head.
 */
export function restingPose(design, headAbove) {
  const pts = samplePoints(design);
  const head = pts.filter((p) => p[1] > headAbove), band = pts.filter((p) => p[1] <= headAbove);
  // Finger axis up: the head now points along −z. Tipping by a about x lowers or raises it.
  const posed = (a) => multiply(rotX(a), rotX(-Math.PI / 2));
  const lowest = (list, m) => list.reduce((lo, p) => Math.min(lo, transform(m, p)[1]), Infinity);
  const gap = (a) => { const m = posed(a); return lowest(head, m) - lowest(band, m); };
  let lo = -Math.PI / 4, hi = Math.PI / 4;
  // The head must come down to the table: find the tilt where head and band touch together.
  if (head.length && gap(lo) * gap(hi) < 0) {
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (gap(lo) * gap(mid) <= 0) hi = mid; else lo = mid; }
  } else lo = hi = 0;
  const m = posed((lo + hi) / 2);
  // Stand it on the floor, centred over the turntable's axis.
  const moved = pts.map((p) => transform(m, p));
  const minY = Math.min(...moved.map((p) => p[1]));
  const cx = (Math.min(...moved.map((p) => p[0])) + Math.max(...moved.map((p) => p[0]))) / 2;
  const cz = (Math.min(...moved.map((p) => p[2])) + Math.max(...moved.map((p) => p[2]))) / 2;
  m[12] -= cx; m[13] -= minY; m[14] -= cz;
  return m;
}

/** Moves an upright design so its band stands on the floor (y = 0), centred on the axis. */
export function standingPose(design) {
  const pts = samplePoints(design);
  const minY = Math.min(...pts.map((p) => p[1]));
  const cx = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
  const cz = (Math.min(...pts.map((p) => p[2])) + Math.max(...pts.map((p) => p[2]))) / 2;
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -cx, -minY, -cz, 1];
}

/** Applies a pose matrix to a design (to every group) and moves its frame to match. */
export function posed(design, pose) {
  const groups = design.groups.map((g) => ({ ...g, matrix: multiply(pose, g.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }));
  const f = design.frame ?? {};
  const frame = { ...f, floor: 0 };
  if (f.head) frame.head = transform(pose, f.head);
  if (f.headBox) {
    // The head box's corners, moved, and boxed again.
    const corners = [];
    for (const x of [f.headBox.min[0], f.headBox.max[0]]) for (const y of [f.headBox.min[1], f.headBox.max[1]]) for (const z of [f.headBox.min[2], f.headBox.max[2]]) corners.push(transform(pose, [x, y, z]));
    frame.headBox = { min: [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))), max: [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) };
  }
  return { ...design, groups, frame };
}
