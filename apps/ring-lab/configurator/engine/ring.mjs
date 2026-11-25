/**
 * The engagement ring builder's design engine: a centre stone (shape and carat), a head that
 * holds it and a shank (band), each made from measurements in millimetres, so every
 * combination fits by construction. Returns plain arrays for the renderer, plus the specs that
 * set the price: carats of every stone and grams of metal.
 *
 * Axes (see geometry.mjs): finger along z, band in the x-y plane, head at +y. Stones' length runs
 * along the finger (z).
 */
import { cut, caratsOf, widthForCarats, SHAPES } from './cuts.mjs';
import { Mesh, band, wire, bead, loop, curve, superellipse, evenly, matrix, vec } from './geometry.mjs';
import { GEMS, METALS, gramsOf, metalLabel, usToDiameter } from './materials.mjs';

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const HEADS = {
  'four-prong':   { label: '4 Prong', prongs: 4 },
  'six-prong':    { label: '6 Prong', prongs: 6 },
  halo:           { label: 'Halo', prongs: 4, halo: true },
  'hidden-halo':  { label: 'Hidden Halo', prongs: 4, hidden: true },
  'secret-halo':  { label: 'Secret Hidden Halo', prongs: 4, hidden: true, secret: true },
  bezel:          { label: 'Bezel', prongs: 0, bezel: 'full' },
  'secret-bezel': { label: 'Secret Bezel', prongs: 4, bezel: 'secret' },
  tulip:          { label: 'Tulip', prongs: 6, tulip: true },
};

// w: band width (along the finger) and t: thickness, each [at the bottom, at the head].
export const SHANKS = {
  classic:           { label: 'Classic', w: [2.0, 2.1], t: [1.75, 1.6] },
  'classic-round':   { label: 'Classic Round', w: [2.0, 2.0], t: [2.0, 2.0], round: true },
  petite:            { label: 'Petite', w: [1.5, 1.6], t: [1.5, 1.45] },
  twist:             { label: 'Twist', strands: 2, twists: 9, strand: 0.68 },
  braided:           { label: 'Braided', strands: 3, twists: 17, strand: 0.56 },
  fluted:            { label: 'Fluted', w: [2.3, 2.3], t: [1.8, 1.7], flutes: 64 },
  cathedral:         { label: 'Cathedral', w: [2.0, 2.2], t: [1.75, 1.6], cathedral: true },
  'cathedral-pave':  { label: 'Cathedral Pavé', w: [2.0, 2.2], t: [1.75, 1.6], cathedral: true, pave: { rows: 1, d: 1.15, end: 95 } },
  pave:              { label: 'Pavé', w: [1.9, 2.0], t: [1.75, 1.65], pave: { rows: 1, d: 1.25, end: 108 } },
  'pave-edge':       { label: 'Pavé Edge', w: [2.5, 2.6], t: [1.75, 1.65], pave: { rows: 2, d: 0.85, end: 100 } },
  'knife-edge-pave': { label: 'Knife Edge Pavé', w: [2.2, 2.3], t: [1.95, 1.85], knife: true, pave: { rows: 2, d: 0.85, end: 100 } },
  channel:           { label: 'Channel Set', w: [2.6, 2.7], t: [1.75, 1.65], channel: { d: 1.45, end: 98 } },
  'french-pave':     { label: 'French Pavé', w: [1.9, 2.0], t: [1.75, 1.65], pave: { rows: 1, d: 1.25, end: 108 }, notch: 'v' },
  'u-pave':          { label: 'U-Pavé', w: [1.9, 2.0], t: [1.75, 1.65], pave: { rows: 1, d: 1.25, end: 108 }, notch: 'u' },
  'eight-stone':     { label: 'Eight Stone', w: [2.4, 2.6], t: [1.85, 1.75], pave: { rows: 1, d: 1.9, count: 4 } },
  'triple-pave':     { label: 'Triple Pavé', w: [3.2, 3.3], t: [1.75, 1.65], pave: { rows: 3, d: 0.95, end: 92 } },
};

export const CARATS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];
export const RING_SIZES = Array.from({ length: 17 }, (_, i) => 3 + i * 0.5);

export const DEFAULT_RING = {
  shape: 'round', carat: 1, gem: 'diamond', head: 'four-prong', shank: 'pave',
  headMetal: 'white', shankMetal: 'white', karat: '14k', accentGem: 'diamond', size: 6,
};

// Where the prongs go, as positions on the outline (degrees of each outline's own parameter).
const PRONGS = {
  round: { 4: [45, 135, 225, 315], 6: [0, 60, 120, 180, 240, 300] },
  oval: { 4: [52, 128, 232, 308], 6: [42, 90, 138, 222, 270, 318] },
  cushion: { 4: [45, 135, 225, 315], 6: [45, 135, 225, 315, 0, 180] },
  princess: { 4: [45, 135, 225, 315], 6: [45, 135, 225, 315, 0, 180] },
  emerald: { 4: [53, 127, 233, 307], 6: [53, 127, 233, 307, 0, 180] },
  pear: { 4: [180, 32, 328, 108, 252], 6: [180, 0, 40, 320, 110, 250] },
  marquise: { 4: [0, 180, 90, 270], 6: [0, 180, 62, 118, 242, 298] },
};

/** Builds a ring: metal meshes for the head and shank, stone placements, specs. */
export function buildRing(input = {}) {
  const o = { ...DEFAULT_RING, ...input };
  if (!SHAPES[o.shape]) throw new Error(`unknown shape ${o.shape}`);
  const head = HEADS[o.head], shank = SHANKS[o.shank];
  if (!head) throw new Error(`unknown head ${o.head}`);
  if (!shank) throw new Error(`unknown shank ${o.shank}`);

  const R = usToDiameter(o.size) / 2;
  const centre = cut(o.shape);
  const W = widthForCarats(o.shape, o.carat);
  const L = W * centre.ratio;
  const depth = -centre.bottom * W;      // girdle middle to culet
  const crownH = centre.top * W;         // girdle middle to table

  const headMesh = new Mesh(), shankMesh = new Mesh();
  const stones = { centre: [], accent: [], channel: [] };

  // The band's top under the head, and how high the stone sits above it.
  const tTop = shank.strands ? shank.strand * 2 : shank.t[1];
  const bandTop = R + tTop;
  const clearance = head.hidden ? 1.25 : head.bezel === 'full' ? 0.7 : 0.85;
  const yGirdle = bandTop + depth + clearance;
  const rp = clamp(0.066 * Math.min(W, L), 0.33, 0.62);    // prong radius

  stones.centre.push(matrix([1, 0, 0], [0, 1, 0], [0, 0, 1], W, [0, yGirdle, 0]));

  const outlineAt = (deg) => {
    const { p, n } = centre.outline.at(deg * DEG);
    return { p: [p[0] * W, p[1] * W], n };
  };
  // A point beside the stone: at fraction f of the way down the pavilion, pushed out by `out` mm.
  const beside = (deg, f, out, y) => {
    const { p, n } = outlineAt(deg);
    const s = 1 - f * 0.92;
    return [p[0] * s + n[0] * out, y, p[1] * s + n[1] * out];
  };
  const outlineLoop = (count, f, out, y) => Array.from({ length: count }, (_, k) => beside((k / count) * 360, f, out, y));

  // ── Head ──
  const prongDegs = head.prongs ? PRONGS[o.shape][head.prongs === 6 ? 6 : 4] : [];
  for (const deg of prongDegs) {
    const tip = beside(deg, 0, 0, 0);
    const { n } = outlineAt(deg);
    const path = curve([
      beside(deg, 0.72, rp * 0.6, bandTop + 0.25),
      beside(deg, 0.5, rp * 1.05, yGirdle - depth * 0.5),
      beside(deg, 0, rp * 0.95, yGirdle),
      [tip[0] * 0.965 + n[0] * rp * 0.42, yGirdle + crownH * 0.5 + rp * 0.3, tip[2] * 0.965 + n[1] * rp * 0.42],
    ], { steps: 7 });
    wire(headMesh, path, { radius: (t) => rp * (0.92 + 0.12 * Math.sin(Math.PI * Math.min(t * 1.4, 1)) - 0.06 * t), sides: 14 });
  }
  if (head.prongs) {
    // Basket: a rail round the pavilion joining the prongs, and a ring at the bottom on the band.
    wire(headMesh, outlineLoop(72, 0.5, rp * 1.1, yGirdle - depth * 0.5), { radius: rp * 0.72, closed: true, sides: 10 });
    wire(headMesh, outlineLoop(48, 0.72, rp * 0.6, bandTop + 0.25), { radius: rp * 0.85, closed: true, sides: 10 });
  }
  if (head.tulip) {
    // Petals: flat ribbons between the prongs, rising from the base and flaring out under the
    // girdle, like a tulip's cup.
    const sorted = [...prongDegs].sort((a, b) => a - b);
    sorted.forEach((deg, k) => {
      const next = sorted[(k + 1) % sorted.length] + (k + 1 === sorted.length ? 360 : 0);
      const mid = (deg + next) / 2;
      const path = curve([
        beside(mid, 0.72, rp * 0.5, bandTop + 0.3),
        beside(mid, 0.45, rp * 1.6, yGirdle - depth * 0.5),
        beside(mid, 0.08, rp * 1.5, yGirdle - 0.25),
      ], { steps: 10 });
      const { n } = outlineAt(mid);
      wire(headMesh, path, { radius: (t) => rp * (0.55 + 1.5 * Math.sin(Math.PI * Math.min(t * 1.05, 1)) ** 0.8), sides: 14, section: [1, 0.32], up: [n[0], 0, n[1]] });
    });
  }
  if (head.bezel === 'full') {
    // A metal rim round the girdle, its lip just over the crown's edge, on a cup to the band.
    const path = outlineLoop(160, 0, 0, yGirdle);
    loop(headMesh, path, superellipse(0.16, -0.3, 0.4, 0.68, 3.2, 40));
    wire(headMesh, outlineLoop(72, 0.55, 0.3, yGirdle - depth * 0.55), { radius: 0.42, closed: true, sides: 10 });
    wire(headMesh, outlineLoop(48, 0.72, 0.25, bandTop + 0.25), { radius: 0.5, closed: true, sides: 10 });
    for (const deg of PRONGS[o.shape][4]) {
      wire(headMesh, curve([beside(deg, 0.72, 0.25, bandTop + 0.25), beside(deg, 0.55, 0.3, yGirdle - depth * 0.55), beside(deg, 0.1, 0.2, yGirdle - 0.8)], { steps: 6 }), { radius: 0.4, sides: 10 });
    }
  }
  if (head.bezel === 'secret') {
    // A thin rim hidden under the girdle.
    loop(headMesh, outlineLoop(140, 0.06, 0.1, yGirdle - 0.18), superellipse(0.12, -0.3, 0.34, 0.3, 2.6, 28));
  }
  const accent = cut('round-accent');
  const accentCrown = accent.top;
  if (head.halo) {
    // A ring of small stones round the centre stone, their tables level with its girdle.
    const dh = clamp(0.16 * Math.min(W, L), 0.9, 1.6);
    const offset = rp * 1.9 + dh * 0.5 + 0.06;
    const yH = yGirdle - accentCrown * dh + 0.02;
    const dense = outlineLoop(360, 0, offset, yH);
    const { length } = evenly(dense, 360);
    const count = Math.max(12, Math.round(length / (dh + 0.1)));
    const { points } = evenly(dense, count);
    placeLoopStones(points, dh, 7, stones.accent);
    loop(headMesh, evenly(dense, 180).points, superellipse(0, -0.42 * dh, 0.5 * dh, 0.36 * dh, 3, 28));
    loopBeads(headMesh, points, dh, yH + 0.1 * dh);
    // Posts from the halo down to the basket, beside each prong.
    for (const deg of prongDegs) {
      wire(headMesh, curve([beside(deg + 14, 0, offset, yH - 0.5 * dh), beside(deg + 14, 0.35, rp * 1.3, yGirdle - depth * 0.42)], { steps: 5 }), { radius: rp * 0.55, sides: 8 });
    }
  }
  if (head.hidden) {
    // Small stones tucked under the girdle, facing outwards: seen from the side.
    const dh = clamp(0.13 * Math.min(W, L), 0.8, 1.3);
    const y = yGirdle - 0.12 - dh * 0.42;
    const dense = outlineLoop(360, 0.05, dh * 0.18, y);
    const { length } = evenly(dense, 360);
    const count = Math.max(10, Math.round(length / (dh + 0.08)));
    const { points } = evenly(dense, count);
    placeLoopStones(points, dh, 58, stones.accent);
    loop(headMesh, evenly(dense, 180).points, superellipse(-0.32 * dh, -0.12 * dh, 0.38 * dh, 0.36 * dh, 2.6, 28));
    if (head.secret) {
      // A second row lower down, round the base of the basket.
      const d2 = dh * 0.85;
      const y2 = yGirdle - depth * 0.55 - d2 * 0.2;
      const dense2 = outlineLoop(240, 0.55, rp * 1.4 + d2 * 0.18, y2);
      const count2 = Math.max(8, Math.round(evenly(dense2, 240).length / (d2 + 0.08)));
      const pts2 = evenly(dense2, count2).points;
      placeLoopStones(pts2, d2, 64, stones.accent);
      loop(headMesh, evenly(dense2, 160).points, superellipse(-0.22 * d2, -0.15 * d2, 0.4 * d2, 0.45 * d2, 2.6, 24));
    }
  }

  const headReach = head.halo ? rp * 1.9 + clamp(0.16 * Math.min(W, L), 0.9, 1.6) * 1.1 : rp * 2.2;

  // ── Shank ──
  const headHalf = Math.max(0.36 * W + rp * 1.6, head.halo ? 0.2 * W : 0) + 0.25;   // head's footprint on the band (along x)
  const phiHead = Math.asin(clamp(headHalf / (R + tTop), 0, 0.95));
  if (shank.strands) strandsShank(shankMesh, R, shank);
  else plainShank(shankMesh, R, shank, { phiHead, liftTo: yGirdle - depth * 0.5 - (R + shank.t[1]) });
  if (shank.pave) paveRows(shankMesh, R, shank, phiHead, stones.accent);
  if (shank.channel) channelRow(shankMesh, R, shank, phiHead, stones.channel);

  // ── Specs ──
  const gem = GEMS[o.gem], accentGem = GEMS[o.accentGem];
  const accentCarats = sumCarats(stones.accent, 'round-accent', accentGem.density) + sumCarats(stones.channel, 'princess-accent', accentGem.density);
  const centreCarats = caratsOf(o.shape, W, gem.density);
  const headVolume = headMesh.volume, shankVolume = shankMesh.volume;
  const specs = {
    centre: { shape: o.shape, label: SHAPES[o.shape].label, size: o.carat, carats: round(centreCarats, 2), mm: [round(L, 2), round(W, 2)], gem: o.gem },
    accents: { count: stones.accent.length + stones.channel.length, carats: round(accentCarats, 2), gem: o.accentGem },
    totalCarats: round(centreCarats + accentCarats, 2),
    metal: {
      head: { metal: o.headMetal, label: metalLabel(o.headMetal, o.karat), grams: round(gramsOf(headVolume, o.headMetal, o.karat), 2) },
      shank: { metal: o.shankMetal, label: metalLabel(o.shankMetal, o.karat), grams: round(gramsOf(shankVolume, o.shankMetal, o.karat), 2) },
    },
    head: o.head, shank: o.shank, size: o.size,
  };
  specs.metal.grams = round(specs.metal.head.grams + specs.metal.shank.grams, 2);

  return {
    options: o,
    metal: { head: headMesh.finish(), shank: shankMesh.finish() },
    stones: [
      { cut: o.shape, gem: o.gem, role: 'centre', matrices: stones.centre },
      { cut: 'round-accent', gem: o.accentGem, role: 'accent', matrices: stones.accent },
      { cut: 'princess-accent', gem: o.accentGem, role: 'accent', matrices: stones.channel },
    ].filter((s) => s.matrices.length),
    specs,
    frame: {
      // The ring stands on the bottom of its band; the head is the interesting part.
      floor: -(R + (shank.strands ? shank.strand * 2 : shank.t[0])),
      head: [0, yGirdle, 0],
      top: yGirdle + crownH + (head.prongs ? rp : 0),
      radius: R + tTop,
      stone: [L, W],
      // The head's extent, for close views of it.
      headBox: {
        min: [-(W / 2 + headReach), bandTop - 0.8, -(L / 2 + headReach)],
        max: [W / 2 + headReach, yGirdle + crownH + (head.prongs ? rp : 0.3), L / 2 + headReach],
      },
    },
  };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const sumCarats = (list, key, density) => list.reduce((s, m) => s + caratsOf(key, Math.hypot(m[0], m[1], m[2]), density), 0);

/** Small stones round a closed path, facing up and tilted outwards by `tilt` degrees. */
function placeLoopStones(points, d, tilt, out) {
  const n = points.length;
  const mid = points.reduce((s, p) => vec.add(s, p), [0, 0, 0]).map((x) => x / n);
  points.forEach((p, k) => {
    const t = vec.unit(vec.sub(points[(k + 1) % n], points[(k - 1 + n) % n]));
    let o = vec.unit([t[2], 0, -t[0]]);
    if (vec.dot(o, vec.sub(p, mid)) < 0) o = vec.scale(o, -1);
    const c = Math.cos(tilt * DEG), s = Math.sin(tilt * DEG);
    const y = vec.unit(vec.add(vec.scale([0, 1, 0], c), vec.scale(o, s)));
    const x = vec.unit(vec.cross(y, t));
    const z = vec.cross(x, y);
    out.push(matrix(x, y, z, d, p));
  });
}

/** Beads between neighbouring stones of a loop, inside and outside. */
function loopBeads(m, points, d, y) {
  const n = points.length;
  const mid = points.reduce((s, p) => vec.add(s, p), [0, 0, 0]).map((x) => x / n);
  for (let k = 0; k < n; k++) {
    const a = points[k], b = points[(k + 1) % n];
    const c = vec.scale(vec.add(a, b), 0.5);
    const t = vec.unit(vec.sub(b, a));
    let o = vec.unit([t[2], 0, -t[0]]);
    if (vec.dot(o, vec.sub(c, mid)) < 0) o = vec.scale(o, -1);
    for (const side of [-1, 1]) bead(m, vec.add([c[0], y, c[2]], vec.scale(o, side * (d * 0.48 + 0.02))), d * 0.17, 6);
  }
}

// ── Shanks ──

/** Thickness, width and lift of a plain shank at angle φ from the top. */
function shankShape(shank, phi, phiHead, liftTo) {
  const top = (1 + Math.cos(phi)) / 2;    // 1 at the head, 0 at the bottom
  const w = shank.w[0] + (shank.w[1] - shank.w[0]) * top;
  let t = shank.t[0] + (shank.t[1] - shank.t[0]) * top;
  const a = Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi)));
  if (shank.cathedral) {
    // Shoulders that rise in an arch to hold the head, fading out over 50° of the band.
    const rise = 1 - smooth(phiHead * 0.7, phiHead + 50 * DEG, a);
    t += Math.max(liftTo, 0) * rise * rise * 0.92;
  }
  return { w, t, a };
}

function plainShank(m, R, shank, { phiHead, liftTo }) {
  const count = 48;
  const outerPow = shank.knife ? 2 : 2.4, innerPow = 5;
  const pave = shank.pave;
  const pitch = pave ? pave.d + 0.1 : 1;
  const profile = (phi) => {
    const { w, t, a } = shankShape(shank, phi, phiHead, liftTo);
    const pts = [];
    if (shank.round) {
      for (let k = 0; k < count; k++) {
        const ang = (k / count) * 2 * Math.PI;
        pts.push([t / 2 + (t / 2) * Math.cos(ang), (w / 2) * Math.sin(ang)]);
      }
      return pts;
    }
    for (let k = 0; k < count; k++) {
      const ang = (k / count) * 2 * Math.PI;
      const c = Math.cos(ang), s = Math.sin(ang);
      const p = c >= 0 ? outerPow : innerPow;
      let u = t / 2 + (t / 2) * Math.sign(c) * Math.abs(c) ** (2 / p);
      const v = (w / 2) * Math.sign(s) * Math.abs(s) ** (2 / p);
      if (shank.knife && c > 0) u = t * 0.5 + t * 0.5 * (1 - Math.abs(v) / (w / 2)) * Math.min(1, c * 3);
      if (c < 0) u -= 0.12 * t * (1 - (2 * v / w) ** 2) * Math.abs(c);   // comfort fit inside
      if (shank.flutes && c > 0 && a > phiHead * 1.4) {
        const fl = 0.5 + 0.5 * Math.cos(phi * shank.flutes);
        u -= 0.22 * fl * c ** 2 * smooth(phiHead * 1.4, phiHead * 1.4 + 0.15, a);
      }
      if (shank.notch && pave && c > 0 && a > phiHead && a < pave.end * DEG) {
        // French / U pavé: scallops cut into the sides between stones, showing more of each stone.
        const phase = (((a - phiHead) * (R + t)) / pitch) % 1;
        const shape = shank.notch === 'v' ? 1 - Math.abs(2 * phase - 1) : Math.sqrt(Math.max(Math.sin(Math.PI * phase), 0));
        const edge = smooth(0.3, 0.5, Math.abs(v) / w);
        u -= 0.5 * t * shape * edge * c;
      }
      pts.push([u, v]);
    }
    return pts;
  };
  const segments = shank.flutes ? 576 : shank.notch ? 512 : 256;
  band(m, { r: R, segments, profile });
}

/** Twisted or braided wires, round the finger. */
function strandsShank(m, R, shank) {
  const rc = R + shank.strand * 1.05;
  // Strands overlap a little so they read as one twisted band, not separate wires.
  const a = shank.strand * (shank.strands === 2 ? 0.72 : 0.82);
  for (let s = 0; s < shank.strands; s++) {
    const path = [];
    const N = 720;
    for (let i = 0; i < N; i++) {
      const phi = (i / N) * 2 * Math.PI;
      const th = phi * shank.twists + (s * 2 * Math.PI) / shank.strands;
      const r = rc + a * Math.cos(th);
      path.push([r * Math.sin(phi), r * Math.cos(phi), a * Math.sin(th)]);
    }
    wire(m, path, { radius: shank.strand, closed: true, sides: 12 });
  }
}

/** Height of a shank's outer surface at offset v across it, and its slope there. */
function surfaceAt(shank, w, t, v) {
  if (shank.knife) {
    const slope = (t * 0.5) / (w / 2);
    return { u: t * 0.5 + t * 0.5 * (1 - Math.abs(v) / (w / 2)), tilt: Math.atan(slope) * Math.sign(v) };
  }
  const p = 2.4, x = Math.min(Math.abs(v) / (w / 2), 0.999);
  const f = (1 - x ** p) ** (1 / p);
  const u = t / 2 + (t / 2) * f;
  const dudv = -(t / 2) * (x ** (p - 1)) * (1 - x ** p) ** (1 / p - 1) / (w / 2);
  return { u, tilt: Math.atan(-dudv) * Math.sign(v) };
}

/** Rows of small stones set into the top of the shank, with beads holding them. */
function paveRows(m, R, shank, phiHead, out) {
  const { rows, d } = shank.pave;
  const gap = shank.pave.count ? 0.22 : 0.1;
  const pitch = d + gap;
  const top = shankShape(shank, 0, phiHead, 0);
  const spacing = d + 0.14;
  const offsets = rows === 1 ? [0] : rows === 2 ? [-spacing / 2, spacing / 2] : [-spacing, 0, spacing];
  const start = phiHead + (pitch * 0.55) / (R + top.t);
  for (const side of [1, -1]) {
    for (const v of offsets) {
      let phi = start;
      let placed = 0;
      const end = (shank.pave.end ?? 180) * DEG;
      const beadsAt = [];
      while ((shank.pave.count ? placed < shank.pave.count : phi < end)) {
        const { w, t } = shankShape(shank, phi, phiHead, 0);
        const surf = surfaceAt(shank, w, t, v * (w / top.w));
        const radial = [Math.sin(side * phi), Math.cos(side * phi), 0];
        const along = [Math.cos(side * phi) * side, -Math.sin(side * phi) * side, 0];
        const tilt = rows === 1 ? 0 : surf.tilt;
        const y = vec.unit(vec.add(vec.scale(radial, Math.cos(tilt)), [0, 0, Math.sin(tilt)]));
        const x = vec.unit(vec.cross(y, [0, 0, 1]));
        const z = vec.cross(x, y);
        const centreAt = vec.add(vec.scale(radial, R + surf.u - d * 0.03), [0, 0, v * (w / top.w)]);
        out.push(matrix(x, y, z, d, centreAt));
        beadsAt.push({ phi, w, t });
        placed++;
        phi += pitch / (R + t);
      }
      // Beads: between neighbours and at the ends of the row, on both edges of the row.
      const beadR = d * (shank.pave.count ? 0.2 : 0.17);
      const edges = rows === 3 && v === 0 ? [] : [v - (d / 2 + 0.03) * (v <= 0 ? 1 : -1)].concat(rows === 1 ? [v + d / 2 + 0.03] : []);
      for (let k = 0; k <= beadsAt.length; k++) {
        const a = beadsAt[Math.max(k - 1, 0)], b = beadsAt[Math.min(k, beadsAt.length - 1)];
        const phiB = k === 0 ? a.phi - pitch / 2 / (R + a.t) : k === beadsAt.length ? b.phi + pitch / 2 / (R + b.t) : (a.phi + b.phi) / 2;
        const { w, t } = shankShape(shank, phiB, phiHead, 0);
        const radial = [Math.sin(side * phiB), Math.cos(side * phiB), 0];
        const list = rows === 1 ? [v - d / 2 - 0.02, v + d / 2 + 0.02] : [v + Math.sign(v || 1) * (d / 2 + 0.03)].concat(rows === 3 ? [v - Math.sign(v || 1) * (d / 2 + 0.03)] : []);
        for (const e of (rows === 3 && v === 0 ? [] : list)) {
          const vv = e * (w / top.w);
          const surf = surfaceAt(shank, w, t, Math.max(Math.min(vv, w / 2 * 0.95), -w / 2 * 0.95));
          bead(m, vec.add(vec.scale(radial, R + surf.u + beadR * 0.15), [0, 0, vv]), beadR, 6);
        }
      }
      void edges;
    }
  }
}

/** Square stones side by side between two metal rails. */
function channelRow(m, R, shank, phiHead, out) {
  const { d, end } = shank.channel;
  const top = shankShape(shank, 0, phiHead, 0);
  const pitch = d + 0.03;
  for (const side of [1, -1]) {
    let phi = phiHead + (pitch * 0.6) / (R + top.t);
    const first = phi;
    while (phi < end * DEG) {
      const { t } = shankShape(shank, phi, phiHead, 0);
      const radial = [Math.sin(side * phi), Math.cos(side * phi), 0];
      const y = radial;
      const x = vec.unit(vec.cross(y, [0, 0, 1]));
      out.push(matrix(x, y, [0, 0, 1], d, vec.scale(radial, R + t - 0.02)));
      phi += pitch / (R + t);
    }
    // Rails either side of the stones, a little higher than their girdles.
    for (const v of [-1, 1]) {
      const path = [];
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const p = first - (pitch * 0.55) / (R + top.t) + ((phi - first) * i) / steps;
        const { t } = shankShape(shank, p, phiHead, 0);
        const radial = [Math.sin(side * p), Math.cos(side * p), 0];
        path.push(vec.add(vec.scale(radial, R + t + 0.04), [0, 0, v * (d / 2 + 0.2)]));
      }
      wire(m, path, { radius: 0.26, sides: 10, section: [0.85, 1.25], up: null });
    }
  }
}

export { HEADS as RING_HEADS, SHANKS as RING_SHANKS, METALS };
