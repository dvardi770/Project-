/**
 * Rings from the jeweller's CAD files (what src/convert.mjs writes: rings.json, rings.b64.txt,
 * fit.json) as designs for the stage, so they look exactly like the ring builder's rings.
 *
 * The metal is the CAD metal, as designed. Each stone is replaced by the builder's own cut of the
 * same shape (cuts.mjs), placed in the stone's seat: same position, orientation and size. That
 * makes the stones sparkle as in the builder, and lets a centre stone of another shape sit in the
 * same seat (as large as fits in the original stone's outline).
 *
 * Rhino is z-up with the ring's finger along y; the stage is y-up with the finger along z.
 */
import { decodeMesh } from './meshDecode.mjs';
import { cut } from './cuts.mjs';

const SHAPE_NAMES = ['round', 'oval', 'cushion', 'emerald', 'princess', 'pear', 'marquise', 'radiant', 'asscher', 'heart', 'baguette', 'trillion', 'trilliant', 'halfmoon', 'half moon', 'half_moon', 'half-moon'];
const NEAREST = { radiant: 'cushion', asscher: 'emerald', heart: 'pear', trilliant: 'trillion', halfmoon: 'half-moon', 'half moon': 'half-moon', half_moon: 'half-moon' };
/**
 * The builder's cut for a CAD stone's block name ("Diamond_Oval"), or null. A baguette is tapered
 * when one end is clearly narrower than the other (`taper`: narrow end ÷ wide end).
 */
export const shapeOfName = (name = '', taper = 1) => {
  const s = SHAPE_NAMES.find((k) => name.toLowerCase().includes(k));
  if (s === 'baguette') return taper < 0.9 ? 'tapered-baguette' : 'baguette';
  return s ? NEAREST[s] ?? s : null;
};

/** Rhino (x, y, z) to stage (x, z, −y). */
const toStage = ([x, y, z]) => [x, z, -y];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Loads a converted collection from a base URL (browser) or with a custom reader. */
export async function loadCad(read = (name) => fetch(name)) {
  const [json, b64, fit] = await Promise.all([
    read('rings.json').then((r) => r.json()),
    read('rings.b64.txt').then((r) => r.text()),
    read('fit.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  const bytes = typeof atob === 'function' ? Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(b64.trim(), 'base64'));
  return { data: json, buffer: bytes.buffer, fit };
}

/** 4×4 row-major Rhino transform applied to a point, or to a direction (w = 0). */
const apply = (m, [x, y, z], w = 1) => [
  m[0] * x + m[1] * y + m[2] * z + m[3] * w,
  m[4] * x + m[5] * y + m[6] * z + m[7] * w,
  m[8] * x + m[9] * y + m[10] * z + m[11] * w,
];

/**
 * A stone's girdle, from its mesh in its block's own space: centre, table direction, long axis,
 * width and length. The thinnest bounding-box axis is the depth; the table is the end where the
 * stone is widest (the culet is a point).
 */
function stoneFrame(positions) {
  const n = positions.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i * 3 + k]); max[k] = Math.max(max[k], positions[i * 3 + k]); }
  const ext = max.map((v, k) => v - min[k]);
  const d = ext.indexOf(Math.min(...ext));
  const [a, b] = [0, 1, 2].filter((k) => k !== d);
  const [shortAxis, longAxis] = ext[a] <= ext[b] ? [a, b] : [b, a];
  const mid = min.map((v, k) => (v + max[k]) / 2);
  const radial = (i) => Math.hypot(positions[i * 3 + a] - mid[a], positions[i * 3 + b] - mid[b]);
  let top = 0, bottom = 0, rMax = 0;
  for (let i = 0; i < n; i++) {
    const h = positions[i * 3 + d], r = radial(i);
    if (h > max[d] - ext[d] * 0.06) top = Math.max(top, r);
    if (h < min[d] + ext[d] * 0.06) bottom = Math.max(bottom, r);
    rMax = Math.max(rMax, r);
  }
  // The girdle: where the stone is widest.
  let gSum = 0, gCount = 0;
  for (let i = 0; i < n; i++) if (radial(i) > rMax * 0.97) { gSum += positions[i * 3 + d]; gCount++; }
  const centre = [...mid];
  centre[d] = gCount ? gSum / gCount : mid[d];
  const up = [0, 0, 0]; up[d] = top >= bottom ? 1 : -1;
  // Width at each end of the long axis: a tapered stone is wider at one end.
  const endWidth = (sign) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const along = (positions[i * 3 + longAxis] - mid[longAxis]) * sign;
      if (along > ext[longAxis] * 0.4) { lo = Math.min(lo, positions[i * 3 + shortAxis]); hi = Math.max(hi, positions[i * 3 + shortAxis]); }
    }
    return hi - lo;
  };
  const [plus, minus] = [endWidth(1), endWidth(-1)];
  // The long axis points to the wider end (the builder's tapered cuts are wide at +z).
  const long = [0, 0, 0]; long[longAxis] = minus > plus * 1.05 ? -1 : 1;
  const short = [0, 0, 0]; short[shortAxis] = 1;
  return { centre, up, long, short, width: ext[shortAxis], length: ext[longAxis], taper: Math.min(plus, minus) / Math.max(plus, minus, 1e-9) };
}

/** Merges meshes (stage coordinates) into one geometry. */
function merge(pieces) {
  const count = pieces.reduce((s, p) => s + p.positions.length / 3, 0);
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const indexCount = pieces.reduce((s, p) => s + p.index.length, 0);
  const index = count > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let v = 0, i = 0;
  for (const p of pieces) {
    positions.set(p.positions, v * 3);
    normals.set(p.normals, v * 3);
    for (let k = 0; k < p.index.length; k++) index[i + k] = p.index[k] + v;
    v += p.positions.length / 3;
    i += p.index.length;
  }
  return { positions, normals, index };
}

/** The stone shape a CAD ring was designed for (its centre stone's cut). */
export function designedShape(cad, ringIndex) {
  const ring = cad.data.rings[ringIndex];
  const centre = ring.items.find((it) => it.role === 'centre');
  return shapeOfName(ring.defs[centre?.def]?.name) ?? 'round';
}

/**
 * A stage design for CAD ring head `head` on shank `shank` (indices into rings.json; a head on
 * another ring's shank is moved by the fit check's shift). Options: centre `shape` (default: as
 * designed), `gem` and `accentGem`, and the metals.
 */
export async function buildCadRing(cad, { head = 0, shank = head, shape = null, gem = 'diamond', accentGem = 'diamond', headMetal = 'white', shankMetal = headMetal } = {}) {
  const shift = head === shank ? 0 : cad.fit[`${head}-${shank}`]?.shift ?? 0;
  const sources = [
    ...cad.data.rings[shank].items.filter((it) => it.part === 'shank').map((it) => ({ it, ring: cad.data.rings[shank], dz: 0 })),
    ...cad.data.rings[head].items.filter((it) => it.part === 'head').map((it) => ({ it, ring: cad.data.rings[head], dz: shift })),
  ];
  const metal = { head: [], shank: [] };
  const stones = new Map();
  let centreInfo = null;
  for (const { it, ring, dz } of sources) {
    if (it.kind === 'metal') {
      const d = await decodeMesh(it.mesh, cad.buffer);
      const n = d.positions.length / 3;
      const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const p = toStage([d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2] + dz]);
        const q = toStage([d.normals[i * 3], d.normals[i * 3 + 1], d.normals[i * 3 + 2]]);
        positions.set(p, i * 3); normals.set(q, i * 3);
      }
      metal[it.part].push({ positions, normals, index: d.index });
      continue;
    }
    // A stone: its seat, from the block's mesh and placement (or its own mesh).
    const def = it.def ? ring.defs[it.def] : null;
    const src = def?.mesh ?? it.mesh;
    if (!src) continue;
    const d = await decodeMesh(src, cad.buffer);
    const f = stoneFrame(d.positions);
    const m = it.xform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const centre = toStage(sub(apply(m, f.centre), [0, 0, -dz]));
    const upW = apply(m, f.up, 0), longW = apply(m, f.long, 0), shortW = apply(m, f.short, 0);
    const width = f.width * len(shortW), length = f.length * len(longW);
    const y = unit(toStage(upW));
    let z = unit(toStage(longW));
    const x = unit(cross(y, z));
    z = cross(x, y);
    const isCentre = it.role === 'centre';
    const own = shapeOfName(def?.name, f.taper) ?? (Math.abs(length / width - 1) < 0.08 ? 'round' : 'oval');
    let key = isCentre ? shape ?? own : own;
    // Small round stones (pavé, halo) use the accent cut: they are a few pixels across.
    const small = !isCentre && Math.max(width, length) < 2.2;
    if (small && key === 'round') key = 'round-accent';
    if (small && key === 'princess') key = 'princess-accent';
    const c = cut(key);
    // As large as fits in the seat's outline; an elongated cut lies along the seat's long side.
    const s = Math.min(width, length / c.ratio);
    const role = isCentre ? 'centre' : small ? 'accent' : 'side';
    const stoneGem = isCentre ? gem : accentGem;
    const group = `${key}|${stoneGem}|${role}`;
    if (!stones.has(group)) stones.set(group, { cut: key, gem: stoneGem, role: role === 'side' ? 'centre' : role, matrices: [] });
    stones.get(group).matrices.push([x[0] * s, x[1] * s, x[2] * s, 0, y[0] * s, y[1] * s, y[2] * s, 0, z[0] * s, z[1] * s, z[2] * s, 0, centre[0], centre[1], centre[2], 1]);
    if (isCentre) centreInfo = { centre, width: s, length: s * c.ratio, top: c.top * s, bottom: c.bottom * s };
  }
  const parts = [];
  if (metal.shank.length) parts.push({ geometry: merge(metal.shank), metal: shankMetal, finish: 'polished' });
  if (metal.head.length) parts.push({ geometry: merge(metal.head), metal: headMetal, finish: 'polished' });

  let floor = Infinity, top = -Infinity;
  for (const p of parts) for (let i = 1; i < p.geometry.positions.length; i += 3) { floor = Math.min(floor, p.geometry.positions[i]); top = Math.max(top, p.geometry.positions[i]); }
  const ci = centreInfo ?? { centre: [0, top - 3, 0], width: 6, length: 6, top: 1, bottom: -3 };
  const reach = Math.max(ci.width, ci.length) * 0.5 + 1.6;
  return {
    parts,
    stones: [...stones.values()],
    frame: {
      floor,
      head: ci.centre,
      top,
      radius: (top - floor) / 2,
      // Where the band's top is (Rhino z = stage y): above it is the head.
      bandTop: cad.data.rings[shank].shankTop,
      stone: [ci.length, ci.width],
      headBox: {
        min: [ci.centre[0] - reach, ci.centre[1] + ci.bottom * 1.6 - 1, ci.centre[2] - reach],
        max: [ci.centre[0] + reach, Math.max(top, ci.centre[1] + ci.top + 0.6), ci.centre[2] + reach],
      },
    },
    designedShape: designedShape(cad, head),
  };
}
