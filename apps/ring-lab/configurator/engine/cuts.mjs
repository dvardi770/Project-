/**
 * Gem cuts made from facet angles, the way a gem cutter specifies them: every facet is a plane
 * (its direction around the stone and its slope), and the stone is the space inside all of them.
 * The same planes drive the stone shader, which follows light through exactly these facets.
 *
 * Everything here is plain math (no three.js), so it runs in Node for tests and in the browser.
 * Cuts are made at a width of 1 and scaled to the stone's millimetres by the caller.
 *
 * Axes: x across the stone, z along it (oval, pear, emerald, radiant and marquise are longer in z),
 * y up through the table. The girdle's middle is at y = 0.
 */

const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Solves the point where three planes meet, or null when two of them are parallel. */
function meet(p, q, r) {
  const qr = cross(q.n, r.n);
  const det = dot(p.n, qr);
  if (Math.abs(det) < 1e-10) return null;
  const rp = cross(r.n, p.n), pq = cross(p.n, q.n);
  return [0, 1, 2].map((i) => (p.d * qr[i] + q.d * rp[i] + r.d * pq[i]) / det);
}

/**
 * The convex solid inside every plane (n · x <= d, n of unit length): its corners and facets.
 * Planes that end up touching the solid in fewer than three corners are dropped.
 */
export function solidFromPlanes(input) {
  // Identical planes (same direction and offset) would make the same facet twice.
  const planes = [];
  for (const p of input) {
    const n = norm(p.n);
    const scale = Math.hypot(...p.n);
    const q = { n, d: p.d / scale, tag: p.tag };
    if (!planes.some((o) => dot(o.n, q.n) > 1 - 1e-9 && Math.abs(o.d - q.d) < 1e-9)) planes.push(q);
  }
  const corners = [];
  const P = planes.length;
  for (let i = 0; i < P; i++) {
    for (let j = i + 1; j < P; j++) {
      for (let k = j + 1; k < P; k++) {
        const x = meet(planes[i], planes[j], planes[k]);
        if (!x) continue;
        let inside = true;
        for (let m = 0; m < P; m++) if (dot(planes[m].n, x) - planes[m].d > 1e-8) { inside = false; break; }
        if (inside && !corners.some((c) => (c[0] - x[0]) ** 2 + (c[1] - x[1]) ** 2 + (c[2] - x[2]) ** 2 < 1e-14)) corners.push(x);
      }
    }
  }
  const facets = [];
  for (const plane of planes) {
    const on = [];
    corners.forEach((c, i) => { if (Math.abs(dot(plane.n, c) - plane.d) < 1e-7) on.push(i); });
    if (on.length < 3) continue;
    // Order the corners around the facet, anticlockwise seen from outside.
    const centre = [0, 1, 2].map((a) => on.reduce((s, i) => s + corners[i][a], 0) / on.length);
    const u = norm(sub(corners[on[0]], centre));
    const v = cross(plane.n, u);
    on.sort((a, b) => {
      const da = sub(corners[a], centre), db = sub(corners[b], centre);
      return Math.atan2(dot(da, v), dot(da, u)) - Math.atan2(dot(db, v), dot(db, u));
    });
    facets.push({ plane, corners: on });
  }
  return { corners, facets };
}

/** Flat-shaded triangles of a solid, its facet planes as [nx, ny, nz, d] and its volume. */
export function meshOfSolid({ corners, facets }) {
  const positions = [], normals = [], planes = [];
  let volume = 0;
  for (const { plane, corners: ring } of facets) {
    planes.push(...plane.n, plane.d);
    for (let i = 1; i + 1 < ring.length; i++) {
      const a = corners[ring[0]], b = corners[ring[i]], c = corners[ring[i + 1]];
      positions.push(...a, ...b, ...c);
      normals.push(...plane.n, ...plane.n, ...plane.n);
      volume += dot(a, cross(b, c)) / 6;
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), planes: new Float32Array(planes), volume };
}

// ─── Outlines (the stone seen from above), width 1 ──────────────────────────
// Each is a closed curve p(t), t in [0, 2π). Facets are placed at values of t, so the curve's
// own parameter spreads them sensibly round long and pointed shapes.

function outline(fn, ratio) {
  const at = (t) => {
    const p = fn(t);
    const h = 1e-3;
    const a = fn(t - h), b = fn(t + h);
    let tx = b[0] - a[0], tz = b[1] - a[1];
    let n = [tz, -tx];
    let l = Math.hypot(n[0], n[1]);
    // At a pointed tip the curve stops for an instant: face straight outwards there.
    if (l < 1e-7) { n = [p[0], p[1] - centre[1]]; l = Math.hypot(n[0], n[1]); }
    n = [n[0] / l, n[1] / l];
    if (n[0] * p[0] + n[1] * (p[1] - centre[1]) < 0) n = [-n[0], -n[1]];
    return { p, n };
  };
  // The curve's centre, for telling outwards from inwards.
  let centre = [0, 0];
  const N = 720;
  let cx = 0, cz = 0;
  for (let i = 0; i < N; i++) { const p = fn((i / N) * 2 * Math.PI); cx += p[0]; cz += p[1]; }
  centre = [cx / N, cz / N];
  return { at, ratio, centre };
}

const OUTLINES = {
  round: () => outline((t) => [0.5 * Math.cos(t), 0.5 * Math.sin(t)], 1),
  oval: (r = 1.38) => outline((t) => [0.5 * Math.cos(t), 0.5 * r * Math.sin(t)], r),
  // A superellipse: square with rounded corners, softer than a princess.
  cushion: (r = 1.05, n = 3.2) => outline((t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [0.5 * Math.sign(c) * Math.abs(c) ** (2 / n), 0.5 * r * Math.sign(s) * Math.abs(s) ** (2 / n)];
  }, r),
  princess: (r = 1, n = 14) => outline((t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [0.5 * Math.sign(c) * Math.abs(c) ** (2 / n), 0.5 * r * Math.sign(s) * Math.abs(s) ** (2 / n)];
  }, r),
  // A rectangle with its corners cut off, as a radiant is outlined (a square one at r = 1).
  radiant: (r = 1.2, corner = 0.17) => {
    const edges = cutCorners(0.5, 0.5 * r, corner);
    return outline((t) => octagonAt(edges, t).p, r);
  },
  // A triangle with gently curved sides and softened points: a flat side towards +z (the
  // centre stone, in a three-stone ring), a point towards −z. Scaled to width 1.
  trillion: () => {
    const edges = [90, 210, 330].map((deg) => ({ n: [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)], D: 0.2887 }));
    const raw = (t) => {
      const p = octagonAt(edges, t).p, r = Math.hypot(p[0], p[1]);
      // Sides bulge out a little; the points are rounded off.
      const k = Math.min(r + 0.06 * Math.max(0, (0.5774 - r) / 0.2887), 0.52) / r;
      return [p[0] * k, p[1] * k];
    };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const [x, z] = raw((i / 2000) * 2 * Math.PI);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const k = 1 / (maxX - minX), mz = (minZ + maxZ) / 2;
    return outline((t) => { const [x, z] = raw(t); return [x * k, (z - mz) * k]; }, (maxZ - minZ) * k);
  },
  // A half moon: a straight edge towards +z (the centre stone), a half circle towards −z.
  'half-moon': () => outline((t) => {
    const s = Math.sin(t);
    return [0.5 * Math.cos(t), (s < 0 ? 0.5 * s : 0) + 0.25];
  }, 0.5),
  // Pointed at both ends: x = ½(1 − (z/b)²), a lens.
  marquise: (r = 2.0) => outline((t) => [0.5 * Math.sin(t) * Math.abs(Math.sin(t)), 0.5 * r * Math.cos(t)], r),
  // Round at −z, pointed at +z; widest nearer the round end, as a pear is.
  pear: (r = 1.55) => {
    const raw = (t) => [Math.sin(t) * Math.abs(Math.cos(t / 2)), -Math.cos(t)];
    // Measure the raw curve, then scale it to width 1 and length r, centred on the origin.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const [x, z] = raw((i / 2000) * 2 * Math.PI);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const sx = 1 / (maxX - minX), sz = r / (maxZ - minZ), mz = (minZ + maxZ) / 2;
    return outline((t) => { const [x, z] = raw(t); return [x * sx, (z - mz) * sz]; }, r);
  },
};

// ─── Cuts ───────────────────────────────────────────────────────────────────

/** A plane through point q, facing horizontal direction n2 = [nx, nz], tilted by slope (degrees). */
function sloped(q, n2, slope, up) {
  const s = Math.sin(slope * DEG), c = Math.cos(slope * DEG);
  const n = [s * n2[0], up ? c : -c, s * n2[1]];
  return { n, d: dot(n, q) };
}

/**
 * A brilliant cut on any convex outline (round, oval, cushion, pear, marquise, princess):
 * table, 8 bezel, 8 star and 16 upper-girdle facets on the crown; 8 main and 16 lower-girdle
 * facets on the pavilion; a faceted girdle. Proportions are an excellent round brilliant's.
 */
function brilliant(shape, o = {}) {
  const {
    table = 0.56, crown = 34.5, pavilion = 40.75, girdle = 0.03, star = 0.5, lowerHalf = 0.77,
    girdleFacets = 32, simple = false,
  } = o;
  const line = OUTLINES[shape](o.ratio);
  const yG = (girdle / 2);
  const yT = yG + 0.5 * (1 - table) * Math.tan(crown * DEG);
  const planes = [{ n: [0, 1, 0], d: yT, tag: 'table' }];
  const mains = 8;
  for (let k = 0; k < mains; k++) {
    const t = (k / mains) * 2 * Math.PI;
    const { p, n } = line.at(t);
    planes.push({ ...sloped([p[0], yG, p[1]], n, crown, true), tag: 'bezel' });
    planes.push({ ...sloped([p[0], -yG, p[1]], n, pavilion, false), tag: 'main' });
  }
  if (!simple) {
    for (let k = 0; k < mains; k++) {
      const mid = ((k + 0.5) / mains) * 2 * Math.PI;
      // Star facets: shallow, from the table edge out to halfway down the crown.
      const m = line.at(mid);
      const r = Math.hypot(m.p[0], m.p[1] - line.centre[1]);
      const tableR = r * table;
      const scale = tableR / r;
      const q = [line.centre[0] + (m.p[0] - line.centre[0]) * scale, yT, line.centre[1] + (m.p[1] - line.centre[1]) * scale];
      const starSlope = Math.atan(Math.tan(crown * DEG) * (1 - star) * 0.62) / DEG;
      planes.push({ ...sloped(q, m.n, starSlope, true), tag: 'star' });
      // Upper and lower halves: a pair either side of the gap between two mains.
      for (const f of [0.25, 0.75]) {
        const t = ((k + f) / mains) * 2 * Math.PI;
        const { p, n } = line.at(t);
        planes.push({ ...sloped([p[0], yG, p[1]], n, crown + 7.5, true), tag: 'upper' });
        // Steeper than the mains, so the lower halves reach lowerHalf of the way to the culet.
        const lower = Math.atan(Math.tan(pavilion * DEG) / (1 - (1 - lowerHalf) * 0.55)) / DEG;
        planes.push({ ...sloped([p[0], -yG, p[1]], n, Math.max(lower, pavilion + 1.2), false), tag: 'lower' });
      }
    }
  }
  for (let j = 0; j < girdleFacets; j++) {
    const t = ((j + 0.5) / girdleFacets) * 2 * Math.PI;
    const { p, n } = line.at(t);
    planes.push({ n: [n[0], 0, n[1]], d: n[0] * p[0] + n[1] * p[1], tag: 'girdle' });
  }
  return { planes, ratio: line.ratio, outline: line };
}

/** An emerald (step) cut: an octagon with three rows of steps on the crown and on the pavilion. */
function stepCut(o = {}) {
  const { ratio = 1.42, corner = 0.13, table = 0.62, girdle = 0.03 } = o;
  const edges = o.edges ?? cutCorners(0.5, 0.5 * ratio, corner);
  const yG = girdle / 2;
  const planes = [];
  for (const e of edges) planes.push({ n: [e.n[0], 0, e.n[1]], d: e.D, tag: 'girdle' });
  // Crown: three steps, each shallower than the one below, up to the table.
  const crownSteps = [44, 33, 22];
  const inset = (1 - table) * 0.5;
  let h = yG;
  const crownRows = crownSteps.map((slope, i) => {
    const row = { slope, inset: (i * inset) / 3, h };
    h += (inset / 3) * Math.tan(slope * DEG);
    return row;
  });
  const yT = h;
  for (const e of edges) {
    for (const r of crownRows) {
      const q = [e.n[0] * (e.D - r.inset), r.h, e.n[1] * (e.D - r.inset)];
      // q lies on the edge's line moved inwards; the plane's offset only needs one such point.
      planes.push({ ...sloped(q, e.n, r.slope, true), tag: 'crown-step' });
    }
  }
  planes.push({ n: [0, 1, 0], d: yT, tag: 'table' });
  // Pavilion: three steps, getting shallower towards the keel.
  const pavRows = [{ slope: 52, inset: 0 }, { slope: 45, inset: 0.06 }, { slope: 38, inset: 0.13 }];
  h = -yG;
  for (let i = 0; i < pavRows.length; i++) {
    pavRows[i].h = h;
    if (i + 1 < pavRows.length) h -= (pavRows[i + 1].inset - pavRows[i].inset) * Math.tan(pavRows[i].slope * DEG);
  }
  for (const e of edges) {
    for (const r of pavRows) {
      const q = [e.n[0] * (e.D - r.inset), r.h, e.n[1] * (e.D - r.inset)];
      planes.push({ ...sloped(q, e.n, r.slope, false), tag: 'pavilion-step' });
    }
  }
  const line = { ratio, centre: [0, 0], at: (t) => octagonAt(edges, t) };
  return { planes, ratio, outline: line };
}

/** The eight edges of a rectangle (half-sizes a, b) with corners cut back by c. */
function cutCorners(a, b, c) {
  return [
    { n: [1, 0], D: a }, { n: [-1, 0], D: a }, { n: [0, 1], D: b }, { n: [0, -1], D: b },
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({ n: [sx / Math.SQRT2, sz / Math.SQRT2], D: (a + b - c) / Math.SQRT2 })),
  ];
}

/** Point and outward direction on the octagon where a ray from the centre at angle t leaves it. */
function octagonAt(edges, t) {
  const dir = [Math.cos(t), Math.sin(t)];
  let best = Infinity, bestN = edges[0].n;
  for (const e of edges) {
    const nd = e.n[0] * dir[0] + e.n[1] * dir[1];
    if (nd <= 1e-9) continue;
    const s = e.D / nd;
    if (s < best) { best = s; bestN = e.n; }
  }
  return { p: [dir[0] * best, dir[1] * best], n: bestN };
}

/** The shapes offered for centre stones, with their usual length-to-width ratio. */
export const SHAPES = {
  round: { label: 'Round', make: () => brilliant('round') },
  oval: { label: 'Oval', make: () => brilliant('oval', { ratio: 1.38, table: 0.58, girdleFacets: 40 }) },
  cushion: { label: 'Cushion', make: () => brilliant('cushion', { ratio: 1.05, table: 0.6, crown: 33, pavilion: 41.5, girdleFacets: 40 }) },
  emerald: { label: 'Emerald', make: () => stepCut({ ratio: 1.42 }) },
  pear: { label: 'Pear', make: () => brilliant('pear', { ratio: 1.55, table: 0.57, girdleFacets: 40 }) },
  princess: { label: 'Princess', make: () => brilliant('princess', { ratio: 1, table: 0.66, crown: 32, pavilion: 41, girdleFacets: 32 }) },
  marquise: { label: 'Marquise', make: () => brilliant('marquise', { ratio: 2.0, table: 0.56, girdleFacets: 40 }) },
  // Brilliant facets on a cut-cornered rectangle: an emerald's outline with a princess's fire.
  radiant: { label: 'Radiant', make: () => brilliant('radiant', { ratio: 1.2, table: 0.56, crown: 35, pavilion: 40.5, girdleFacets: 32 }) },
  // A square step cut with deep corners and a small table, its steps seen as concentric squares.
  asscher: { label: 'Asscher', make: () => stepCut({ ratio: 1, corner: 0.24, table: 0.54 }) },
};

/** The trapezoid of a tapered baguette: wide end (width 1) at +z, narrow end (width k) at −z. */
function trapezoid(ratio, k) {
  const L = ratio / 2;
  // Each side runs from (±k/2, −L) to (±1/2, +L); its outward normal leans towards −z.
  const side = (sx) => { const n = [sx * 2 * L, -(0.5 - 0.5 * k)]; const l = Math.hypot(...n); const u = [n[0] / l, n[1] / l]; return { n: u, D: u[0] * sx * 0.5 + u[1] * L }; };
  return [{ n: [0, 1], D: L }, { n: [0, -1], D: L }, side(1), side(-1)];
}

/**
 * Side stones for three-stone rings: the centre shapes plus shapes made for flanking a centre
 * stone. Lengths run along z; in a ring, +z faces the centre stone (a pear's point, a tapered
 * baguette's wide end, a half moon's straight edge).
 */
export const SIDE_SHAPES = {
  round: { label: 'Round' },
  oval: { label: 'Oval' },
  pear: { label: 'Pear' },
  princess: { label: 'Princess' },
  emerald: { label: 'Emerald' },
  marquise: { label: 'Marquise' },
  baguette: { label: 'Baguette', make: () => stepCut({ ratio: 2.4, edges: cutCorners(0.5, 1.2, 0.02), table: 0.6 }) },
  'tapered-baguette': { label: 'Tapered baguette', make: () => stepCut({ ratio: 1.67, edges: trapezoid(1.67, 0.62), table: 0.6 }) },
  trillion: { label: 'Trillion', make: () => brilliant('trillion', { table: 0.6, crown: 33, pavilion: 41, girdleFacets: 36 }) },
  'half-moon': { label: 'Half moon', make: () => brilliant('half-moon', { table: 0.6, crown: 33, pavilion: 41, girdleFacets: 36 }) },
};

/** Cuts for small accent stones: fewer facets (they are a few pixels across), so cheaper to trace. */
const ACCENTS = {
  'round-accent': () => brilliant('round', { simple: true, girdleFacets: 16, table: 0.54, crown: 34, pavilion: 41 }),
  'princess-accent': () => brilliant('princess', { simple: true, girdleFacets: 16, table: 0.64, crown: 32, pavilion: 41 }),
};

const cache = new Map();

/**
 * A cut at width 1: triangles (flat shaded), facet planes, volume, proportions and outline.
 * Keys are SHAPES names or 'round-accent' / 'princess-accent'.
 */
export function cut(key) {
  if (cache.has(key)) return cache.get(key);
  const spec = SHAPES[key]?.make() ?? ACCENTS[key]?.() ?? SIDE_SHAPES[key]?.make?.();
  if (!spec) throw new Error(`unknown cut ${key}`);
  const solid = solidFromPlanes(spec.planes);
  const mesh = meshOfSolid(solid);
  let minY = Infinity, maxY = -Infinity;
  for (const c of solid.corners) { minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]); }
  const result = {
    key,
    ...mesh,
    planeCount: mesh.planes.length / 4,
    ratio: spec.ratio,
    outline: spec.outline,
    // Heights at width 1: the table's top and the culet's bottom, from the girdle's middle.
    top: maxY,
    bottom: minY,
  };
  cache.set(key, result);
  return result;
}

/** Specific gravity of each material: a stone's weight in carats is 5 × its volume in cm³ × this. */
export const DENSITY = { diamond: 3.52, corundum: 4.0, beryl: 2.72, zoisite: 3.35, moissanite: 3.21 };

/** Carats of a stone of this cut at this width (mm). */
export const caratsOf = (key, width, density = DENSITY.diamond) => cut(key).volume * width ** 3 * density * 0.005;

/** The width (mm) that makes a diamond of this cut weigh this many carats. */
export const widthForCarats = (key, carats) => Math.cbrt(carats / (cut(key).volume * DENSITY.diamond * 0.005));
