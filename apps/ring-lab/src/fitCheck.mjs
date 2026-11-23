/**
 * Fit check: decides which heads may be combined with which shanks.
 *
 * Every uploaded ring is a known-good pair: its designer joined that head to that shank.
 * From the original pair we learn the joint: the band surface the original head covers,
 * and the head surface the original band supports. Another head fits a shank when, after
 * seating it, it covers the shank's joint on both arms and its own joint rests on the band.
 *
 * Units are millimetres. Rings are Z-up (Rhino); the arms of a shank lie on either side of x = 0.
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const DEFAULTS = {
  touch: 0.2,      // closer than this counts as touching
  maxClash: 1.0,   // a head buried deeper than this in the band would clash
  search: 1.5,     // how far the head may be moved up or down to seat it
  fits: 0.85,      // coverage needed to offer the mix
  review: 0.6,     // coverage above which a person should look at it
  samples: 240,    // joint points kept per part
};

/** @param {{ positions: Float32Array, index: Uint32Array | Uint16Array }} piece */
function prepare(piece) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(piece.positions), 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(piece.index), 1));
  return { pos: g.attributes.position.array, bvh: new MeshBVH(g), box: new THREE.Box3().setFromBufferAttribute(g.attributes.position) };
}

const ray = new THREE.Ray();
const hit = {};
const tmp = new THREE.Vector3();

function insidePiece(pc, p) {
  if (!pc.box.containsPoint(p)) return false;
  ray.origin.copy(p);
  ray.direction.set(0.0123, 0.0071, 1).normalize();
  return pc.bvh.raycast(ray, THREE.DoubleSide).length % 2 === 1;
}
/** 0 when the point is inside a piece, otherwise the distance to the nearest surface (capped). */
function gap(pieces, p, cap = 1) {
  let best = cap;
  for (const pc of pieces) {
    if (pc.box.distanceToPoint(p) > best) continue;
    if (insidePiece(pc, p)) return 0;
    const r = pc.bvh.closestPointToPoint(p, hit, 0, best);
    if (r && r.distance < best) best = r.distance;
  }
  return best;
}
function depthInside(pieces, p) {
  let depth = 0;
  for (const pc of pieces) if (insidePiece(pc, p)) {
    const r = pc.bvh.closestPointToPoint(p, hit, 0, 3);
    depth = Math.max(depth, r ? r.distance : 3);
  }
  return depth;
}
function points(pieces, keep) {
  const out = [];
  for (const pc of pieces) for (let i = 0; i < pc.pos.length; i += 3) {
    const p = new THREE.Vector3(pc.pos[i], pc.pos[i + 1], pc.pos[i + 2]);
    if (keep(p)) out.push(p);
  }
  return out;
}
const thin = (pts, n) => (pts.length <= n ? pts : pts.filter((_, i) => i % Math.ceil(pts.length / n) === 0));
const bounds = (pieces) => pieces.reduce((b, pc) => b.union(pc.box), new THREE.Box3());

/**
 * Prepares rings for checking and learns each ring's joint from its own head and shank.
 * @param {Array<{ shankTop: number, head: Array<{positions: Float32Array, index: Uint32Array|Uint16Array}>, shank: Array<{positions: Float32Array, index: Uint32Array|Uint16Array}> }>} rings
 */
export function learnJoints(rings, options = {}) {
  const o = { ...DEFAULTS, ...options };
  return rings.map((ring) => {
    const head = ring.head.map(prepare);
    const shank = ring.shank.map(prepare);
    const headBox = bounds(head).expandByScalar(1);
    const shankBox = bounds(shank).expandByScalar(1);
    return {
      shankTop: ring.shankTop, head, shank,
      shankJoint: thin(points(shank, (p) => headBox.containsPoint(p) && gap(head, p) <= o.touch), o.samples),
      headJoint: thin(points(head, (p) => shankBox.containsPoint(p) && gap(shank, p) <= o.touch), o.samples),
    };
  });
}

/**
 * Seats head `hi` on shank `si` and measures the joint.
 * @returns {{ verdict: 'fits'|'review'|'no', shift: number, armLeft: number, armRight: number, headSupported: number, clash: number }}
 */
export function checkPair(learned, hi, si, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { head } = learned[hi];
  const { shank, shankJoint } = learned[si];
  const headJoint = learned[hi].headJoint;
  const base = learned[si].shankTop - learned[hi].shankTop;
  const headBottom = Math.min(...head.map((pc) => pc.box.min.z));
  const step = 0.05;
  const limit = Math.round(o.search / step);
  let best = null;
  const tried = new Set();
  const tryStep = (k) => {
    if (tried.has(k) || Math.abs(k) > limit) return;
    tried.add(k);
    const dz = base + k * step;
    const side = [[0, 0], [0, 0]];
    for (const p of shankJoint) {
      const s = p.x < 0 ? 0 : 1;
      side[s][1]++;
      if (gap(head, tmp.set(p.x, p.y, p.z - dz)) <= o.touch) side[s][0]++;
    }
    let resting = 0;
    for (const p of headJoint) if (gap(shank, tmp.set(p.x, p.y, p.z + dz)) <= o.touch) resting++;
    let clash = 0;
    for (const pc of head) for (let i = 0; i < pc.pos.length; i += 15) {
      if (pc.pos[i + 2] > headBottom + 2.5) continue;
      clash = Math.max(clash, depthInside(shank, tmp.set(pc.pos[i], pc.pos[i + 1], pc.pos[i + 2] + dz)));
    }
    const left = side[0][1] ? side[0][0] / side[0][1] : 0;
    const right = side[1][1] ? side[1][0] / side[1][1] : 0;
    const supported = headJoint.length ? resting / headJoint.length : 0;
    const score = clash > o.maxClash ? -1 : Math.min(left, right, supported);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && Math.abs(k) < Math.abs(best.k))) {
      best = { k, dz, score, left, right, supported, clash };
    }
  };
  // Coarse search in 0.25 mm steps, then refine around the best position in 0.05 mm steps.
  for (let k = -limit; k <= limit; k += 5) tryStep(k);
  const c = best.k;
  for (let k = c - 4; k <= c + 4; k++) tryStep(k);
  const round = (x) => Math.round(x * 100) / 100;
  return {
    verdict: best.score >= o.fits ? 'fits' : best.score >= o.review ? 'review' : 'no',
    shift: round(best.dz - base),
    armLeft: round(best.left), armRight: round(best.right),
    headSupported: round(best.supported), clash: round(best.clash),
  };
}

/** Checks every head against every shank. Keys are "head-shank" indexes. */
export function checkAll(rings, options = {}) {
  const learned = learnJoints(rings, options);
  const result = {};
  learned.forEach((_, hi) => learned.forEach((__, si) => { result[`${hi}-${si}`] = checkPair(learned, hi, si, options); }));
  return result;
}

// Command line: node src/fitCheck.mjs <out-dir>   (reads what convert.mjs wrote, writes fit.json)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node src/fitCheck.mjs <out-dir>'); process.exit(1); }
  const data = JSON.parse(readFileSync(`${dir}/rings.json`, 'utf8'));
  const raw = Buffer.from(readFileSync(`${dir}/rings.b64.txt`, 'utf8'), 'base64');
  const bin = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
  const piece = (m) => ({
    positions: new Float32Array(bin, m.pos, m.nPos),
    index: m.idx32 ? new Uint32Array(bin, m.idx, m.nIdx) : new Uint16Array(bin, m.idx, m.nIdx),
  });
  const rings = data.rings.map((ring) => ({
    shankTop: ring.shankTop,
    head: ring.items.filter((i) => i.part === 'head' && i.kind === 'metal' && i.mesh).map((i) => piece(i.mesh)),
    shank: ring.items.filter((i) => i.part === 'shank' && i.kind === 'metal' && i.mesh).map((i) => piece(i.mesh)),
  }));
  const started = Date.now();
  const fit = checkAll(rings);
  for (const [key, f] of Object.entries(fit)) {
    const [h, s] = key.split('-').map(Number);
    console.log(`${data.rings[h].headLabel} on ${data.rings[s].shankLabel}: ${f.verdict} (arms ${f.armLeft}/${f.armRight}, head resting ${f.headSupported}, shift ${f.shift} mm)`);
  }
  console.log(`${Object.keys(fit).length} pairs in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  writeFileSync(`${dir}/fit.json`, JSON.stringify(fit));
}
