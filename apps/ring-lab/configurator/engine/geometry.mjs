/**
 * Building blocks for jewellery made from measurements: bands swept round the finger, wires
 * (prongs, rails, braids) swept along curves, and beads. Plain arrays, no three.js, so the
 * same code runs in tests. Units are millimetres.
 *
 * Ring axes: the finger runs along z; the band lies in the x-y plane with its top (where the
 * head sits) at +y. Angle φ is measured round the band from the top.
 */

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vec = { add, sub, scale, dot, cross, len, unit };

/** Triangles being collected for one material zone. */
export class Mesh {
  constructor() {
    this.p = []; this.n = []; this.uv = []; this.i = [];
    /** Volume of the closed pieces added so far (mm³), for the metal's weight. */
    this.volume = 0;
  }
  get count() { return this.p.length / 3; }
  vertex(p, n, uv = [0, 0]) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    return this.count - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  /** Adds another mesh's triangles. */
  append(m) {
    const base = this.count;
    this.p.push(...m.p); this.n.push(...m.n); this.uv.push(...m.uv);
    for (const k of m.i) this.i.push(k + base);
    this.volume += m.volume;
    return this;
  }
  finish() {
    return {
      positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.uv),
      index: this.count > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), volume: this.volume,
    };
  }
}

/** Signed volume of triangles first..last of a mesh (positive when they face outwards). */
function volumeOf(m, firstIndex) {
  let v = 0;
  for (let k = firstIndex; k < m.i.length; k += 3) {
    const a = m.i[k] * 3, b = m.i[k + 1] * 3, c = m.i[k + 2] * 3;
    const A = [m.p[a], m.p[a + 1], m.p[a + 2]], B = [m.p[b], m.p[b + 1], m.p[b + 2]], C = [m.p[c], m.p[c + 1], m.p[c + 2]];
    v += dot(A, cross(B, C)) / 6;
  }
  return v;
}

/** Turns the triangles and normals of a piece inside out. */
function flipPiece(m, firstIndex, firstVertex) {
  for (let k = firstIndex; k < m.i.length; k += 3) { const t = m.i[k + 1]; m.i[k + 1] = m.i[k + 2]; m.i[k + 2] = t; }
  for (let k = firstVertex * 3; k < m.n.length; k++) m.n[k] = -m.n[k];
}

/**
 * A surface from a grid of points: rows × cols, either direction may wrap round. Normals come
 * from the neighbouring points, so any shape of grid gets smooth shading.
 * Returns the grid's first vertex index.
 */
export function grid(m, rows, cols, point, { wrapRows = false, wrapCols = false, uv = (i, j) => [i / rows, j / cols] } = {}) {
  const P = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) P.push(point(i, j));
  const at = (i, j) => P[i * cols + j];
  const first = m.count;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const i0 = wrapRows ? (i - 1 + rows) % rows : Math.max(i - 1, 0), i1 = wrapRows ? (i + 1) % rows : Math.min(i + 1, rows - 1);
      const j0 = wrapCols ? (j - 1 + cols) % cols : Math.max(j - 1, 0), j1 = wrapCols ? (j + 1) % cols : Math.min(j + 1, cols - 1);
      let du = sub(at(i1, j), at(i0, j)), dv = sub(at(i, j1), at(i, j0));
      // At a pole (all points of a row in one place) look one row further.
      if (len(dv) < 1e-9) dv = sub(at(i, j1 === j ? j : j1), at(i0 === i ? i1 : i0, j));
      let n = cross(du, dv);
      if (len(n) < 1e-12) n = cross(sub(at(i1, j1), at(i0, j0)), sub(at(i1, j0), at(i0, j1)));
      m.vertex(at(i, j), unit(n), uv(i, j));
    }
  }
  const iMax = wrapRows ? rows : rows - 1, jMax = wrapCols ? cols : cols - 1;
  for (let i = 0; i < iMax; i++) {
    for (let j = 0; j < jMax; j++) {
      const a = first + i * cols + j, b = first + ((i + 1) % rows) * cols + j;
      const c = first + ((i + 1) % rows) * cols + ((j + 1) % cols), d = first + i * cols + ((j + 1) % cols);
      m.tri(a, b, c); m.tri(a, c, d);
    }
  }
  return first;
}

/**
 * A closed solid piece: adds the surfaces made by build(), then makes sure they face outwards
 * and counts the enclosed volume.
 */
export function solid(m, build) {
  const firstIndex = m.i.length, firstVertex = m.count;
  build();
  let v = volumeOf(m, firstIndex);
  if (v < 0) { flipPiece(m, firstIndex, firstVertex); v = -v; }
  m.volume += v;
  return v;
}

/**
 * A band round the finger. profile(φ) gives the cross-section at angle φ as closed loops of
 * [u, v] points: u outwards from the inner radius r, v along the finger. Points listed in a
 * `sharp` set are hard edges (the surface is split there). uv: u round the band (0–1), v across.
 */
export function band(m, { r, segments = 256, profile, sharp = [] }) {
  const first = profile(0);
  const n = first.length;
  // Split the loop at hard edges into runs that each get smooth normals.
  const cuts = [...sharp].sort((a, b) => a - b);
  const runs = cuts.length === 0 ? [null] : cuts.map((c, k) => {
    const end = cuts[(k + 1) % cuts.length];
    const idx = [];
    for (let j = c; ; j = (j + 1) % n) { idx.push(j); if (j === end && idx.length > 1) break; }
    return idx;
  });
  const sections = Array.from({ length: segments }, (_, i) => profile((i / segments) * 2 * Math.PI));
  const place = (i, j) => {
    const phi = (i / segments) * 2 * Math.PI;
    const [u, v] = sections[i][j];
    return [(r + u) * Math.sin(phi), (r + u) * Math.cos(phi), v];
  };
  return solid(m, () => {
    for (const run of runs) {
      if (run === null) grid(m, segments, n, place, { wrapRows: true, wrapCols: true, uv: (i, j) => [i / segments, j / n] });
      else grid(m, segments, run.length, (i, j) => place(i, run[j]), { wrapRows: true, uv: (i, j) => [i / segments, run[j] / n] });
    }
  });
}

/** Points along a Catmull-Rom curve through the given points (open or closed). */
export function curve(points, { closed = false, steps = 8 } = {}) {
  const out = [];
  const n = points.length;
  const P = (k) => closed ? points[(k + n) % n] : points[Math.min(Math.max(k, 0), n - 1)];
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((a) => 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)));
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/** Frames along a path that twist as little as possible (parallel transport). */
function frames(path, closed) {
  const n = path.length;
  const T = path.map((_, k) => {
    const a = path[closed ? (k - 1 + n) % n : Math.max(k - 1, 0)], b = path[closed ? (k + 1) % n : Math.min(k + 1, n - 1)];
    return unit(sub(b, a));
  });
  let ref = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let N = unit(cross(cross(T[0], ref), T[0]));
  const Ns = [N];
  for (let k = 1; k < n; k++) {
    const t = T[k];
    N = unit(sub(Ns[k - 1], scale(t, dot(Ns[k - 1], t))));
    Ns.push(N);
  }
  if (closed) {
    // Spread any leftover twist evenly so the loop closes without a seam.
    const B0 = cross(T[0], Ns[0]);
    const end = Ns[n - 1];
    const angle = Math.atan2(dot(end, B0), dot(end, Ns[0]));
    for (let k = 0; k < n; k++) {
      const a = (-angle * k) / n, c = Math.cos(a), s = Math.sin(a);
      const B = cross(T[k], Ns[k]);
      Ns[k] = unit(add(scale(Ns[k], c), scale(B, s)));
    }
  }
  return path.map((_, k) => ({ T: T[k], N: Ns[k], B: cross(T[k], Ns[k]) }));
}

/**
 * A wire along a path. radius is a number or a function of how far along (0–1). Open wires get
 * rounded ends. `section` (optional) flattens it: [across, deep] multipliers of the radius,
 * with `up` choosing which way "deep" points.
 */
export function wire(m, path, { radius, sides = 12, closed = false, section = [1, 1], up = null, cap = true } = {}) {
  const rad = typeof radius === 'function' ? radius : () => radius;
  const F = frames(path, closed);
  if (up) for (const f of F) {
    // Turn each frame so that N points as close to `up` as it can.
    const N = unit(sub(up, scale(f.T, dot(up, f.T))));
    if (len(N) > 0.1) { f.N = N; f.B = cross(f.T, N); }
  }
  // Rows: optional cap rings, the path, cap rings.
  const rows = [];
  const capRings = closed || !cap ? 0 : 4;
  const r0 = rad(0), r1 = rad(1);
  for (let c = capRings; c >= 1; c--) {
    const a = (c / capRings) * (Math.PI / 2);
    rows.push({ k: 0, shrink: Math.cos(a), push: -Math.sin(a) * r0 });
  }
  for (let k = 0; k < path.length; k++) rows.push({ k, shrink: 1, push: 0 });
  for (let c = 1; c <= capRings; c++) {
    const a = (c / capRings) * (Math.PI / 2);
    rows.push({ k: path.length - 1, shrink: Math.cos(a), push: Math.sin(a) * r1 });
  }
  const point = (i, j) => {
    const { k, shrink, push } = rows[i];
    const f = F[k];
    const t = closed ? k / path.length : k / (path.length - 1);
    const r = rad(t) * Math.max(shrink, 0.0001);
    const a = (j / sides) * 2 * Math.PI;
    const off = add(scale(f.N, Math.cos(a) * r * section[1]), scale(f.B, Math.sin(a) * r * section[0]));
    return add(add(path[k], off), scale(f.T, push));
  };
  return solid(m, () => grid(m, rows.length, sides, point, { wrapRows: closed, wrapCols: true }));
}

/** A ball. */
export function bead(m, centre, r, detail = 8) {
  const rows = detail + 1, cols = detail * 2;
  return solid(m, () => grid(m, rows, cols, (i, j) => {
    const a = (i / (rows - 1)) * Math.PI, b = (j / cols) * 2 * Math.PI;
    // Poles are nudged off exactly 0 and π so every row has a direction.
    const aa = Math.min(Math.max(a, 1e-3), Math.PI - 1e-3);
    return [centre[0] + r * Math.sin(aa) * Math.cos(b), centre[1] + r * Math.cos(aa), centre[2] + r * Math.sin(aa) * Math.sin(b)];
  }, { wrapCols: true }));
}

/**
 * A ridge swept along a closed path lying round the y axis (a bezel or halo frame): the
 * cross-section is given in [out, up] (out: away from the path's middle, up: +y).
 */
export function loop(m, path, section, { sharp = [] } = {}) {
  const n = path.length;
  // Outward direction at each point: perpendicular to the path, horizontal.
  const out = path.map((p, k) => {
    const a = path[(k - 1 + n) % n], b = path[(k + 1) % n];
    const t = sub(b, a);
    let o = unit([t[2], 0, -t[0]]);
    const mid = path.reduce((s, q) => add(s, q), [0, 0, 0]).map((x) => x / n);
    if (dot(o, sub(p, mid)) < 0) o = scale(o, -1);
    return o;
  });
  const place = (i, j) => {
    const [u, v] = section[j];
    return add(add(path[i], scale(out[i], u)), [0, v, 0]);
  };
  const cuts = [...sharp].sort((a, b) => a - b);
  const s = section.length;
  return solid(m, () => {
    if (cuts.length === 0) { grid(m, n, s, place, { wrapRows: true, wrapCols: true }); return; }
    cuts.forEach((c, k) => {
      const end = cuts[(k + 1) % cuts.length];
      const idx = [];
      for (let j = c; ; j = (j + 1) % s) { idx.push(j); if (j === end && idx.length > 1) break; }
      grid(m, n, idx.length, (i, j) => place(i, idx[j]), { wrapRows: true });
    });
  });
}

/** Rounded-rectangle-like cross-section: a superellipse with half-sizes a (u) and b (v). */
export function superellipse(cu, cv, a, b, power, count = 32, startAngle = 0) {
  const pts = [];
  for (let k = 0; k < count; k++) {
    const t = startAngle + (k / count) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([cu + a * Math.sign(c) * Math.abs(c) ** (2 / power), cv + b * Math.sign(s) * Math.abs(s) ** (2 / power)]);
  }
  return pts;
}

/** Resamples a closed path to points spaced evenly along it, `count` of them. */
export function evenly(path, count) {
  const n = path.length;
  const seg = path.map((p, k) => len(sub(path[(k + 1) % n], p)));
  const total = seg.reduce((a, b) => a + b, 0);
  const out = [];
  let k = 0, acc = 0;
  for (let c = 0; c < count; c++) {
    const want = (c / count) * total;
    while (acc + seg[k] < want) { acc += seg[k]; k++; }
    const f = (want - acc) / seg[k];
    out.push(add(path[k], scale(sub(path[(k + 1) % n], path[k]), f)));
  }
  return { points: out, length: total };
}

/** Column-major 4×4 matrix from axes (each scaled by s) and a position. */
export const matrix = (x, y, z, s, p) => [x[0] * s, x[1] * s, x[2] * s, 0, y[0] * s, y[1] * s, y[2] * s, 0, z[0] * s, z[1] * s, z[2] * s, 0, p[0], p[1], p[2], 1];
