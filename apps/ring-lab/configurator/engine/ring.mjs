/**
 * The engagement ring builder's design engine: a centre stone (shape and carat), a head that
 * holds it and a shank (band), each made from measurements in millimetres, so every
 * combination fits by construction. Returns plain arrays for the renderer, plus the specs that
 * set the price: carats of every stone and grams of metal.
 *
 * Axes (see geometry.mjs): finger along z, band in the x-y plane, head at +y. Stones' length runs
 * along the finger (z).
 */
import { cut, caratsOf, widthForCarats, SHAPES, SIDE_SHAPES } from './cuts.mjs';
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
  'three-stone':  { label: 'Three Stone', prongs: 4, sides: true },
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
  // Three-stone side stones: shape, width across the band in mm (0: sized to the centre stone)
  // and lean in degrees (−1: following the band).
  sideShape: 'round', sideSize: 0, sideAngle: -1,
};

// Side stones' usual width next to a centre stone, as a share of the round default.
const SIDE_WIDTH = { round: 1, princess: 0.95, trillion: 1, oval: 0.85, pear: 0.85, marquise: 0.75, emerald: 0.85, baguette: 0.5, 'tapered-baguette': 0.5, 'half-moon': 1.25 };
// Where a side stone's prongs go: towards its corners (directions in its own x, z).
const sideProngDirections = (key, ratio) => key === 'trillion' ? [[0, -1], [0.87, 0.5], [-0.87, 0.5]]
  : key === 'half-moon' ? [[1, 0.35], [-1, 0.35], [0.75, -0.8], [-0.75, -0.8]]
  : [[1, ratio], [-1, ratio], [1, -ratio], [-1, -ratio]];

// Where the prongs go, as positions on the outline (degrees of each outline's own parameter).
const PRONGS = {
  round: { 4: [45, 135, 225, 315], 6: [0, 60, 120, 180, 240, 300] },
  oval: { 4: [52, 128, 232, 308], 6: [42, 90, 138, 222, 270, 318] },
  cushion: { 4: [45, 135, 225, 315], 6: [45, 135, 225, 315, 0, 180] },
  princess: { 4: [45, 135, 225, 315], 6: [45, 135, 225, 315, 0, 180] },
  emerald: { 4: [53, 127, 233, 307], 6: [53, 127, 233, 307, 0, 180] },
  pear: { 4: [180, 32, 328, 108, 252], 6: [180, 0, 40, 320, 110, 250] },
  marquise: { 4: [0, 180, 90, 270], 6: [0, 180, 62, 118, 242, 298] },
  radiant: { 4: [50, 130, 230, 310], 6: [50, 130, 230, 310, 0, 180] },
  asscher: { 4: [45, 135, 225, 315], 6: [45, 135, 225, 315, 0, 180] },
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
  const stones = { centre: [], accent: [], channel: [], side: [] };

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
    wire(headMesh, path, { radius: (t) => rp * (0.92 + 0.12 * Math.sin(Math.PI * Math.min(t * 1.4, 1)) - 0.06 * t), sides: 20 });
  }
  if (head.prongs) {
    // Basket: a rail round the pavilion joining the prongs, and a ring at the bottom on the band.
    wire(headMesh, outlineLoop(72, 0.5, rp * 1.1, yGirdle - depth * 0.5), { radius: rp * 0.72, closed: true, sides: 16 });
    wire(headMesh, outlineLoop(48, 0.72, rp * 0.6, bandTop + 0.25), { radius: rp * 0.85, closed: true, sides: 16 });
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
    // A ring of small stones tight round the centre stone, their tables level with its girdle.
    // The centre's prongs rise through small gaps in the ring, as on a real halo.
    const dh = clamp(0.15 * Math.min(W, L), 0.9, 1.5);
    const offset = dh * 0.5 + 0.1;
    const yH = yGirdle - accentCrown * dh + 0.03;
    const path = outlineLoop(720, 0, offset, yH);
    const placed = stonesBetween(path, prongDegs.map((d) => Math.round(((d % 360) + 360) % 360 * 2) % 720), dh, rp * 2 + 0.12, 0.08);
    placeLoopStones(placed.points, dh, 6, stones.accent, path);
    loop(headMesh, evenly(path, 240).points, superellipse(0.02 * dh, -0.44 * dh, 0.5 * dh, 0.36 * dh, 3, 28));
    loopBeads(headMesh, placed.points, dh, yH + 0.1 * dh, placed.gapAfter, path);
  }
  if (head.hidden) {
    // Small stones tucked under the girdle, facing outwards: seen from the side.
    const dh = clamp(0.13 * Math.min(W, L), 0.8, 1.3);
    const y = yGirdle - 0.12 - dh * 0.42;
    const dense = outlineLoop(720, 0.05, dh * 0.18, y);
    const { points } = stonesBetween(dense, prongDegs.map((d) => Math.round(((d % 360) + 360) % 360 * 2) % 720), dh, rp * 2 + 0.1, 0.07);
    placeLoopStones(points, dh, 58, stones.accent, dense);
    loop(headMesh, evenly(dense, 180).points, superellipse(-0.32 * dh, -0.12 * dh, 0.38 * dh, 0.36 * dh, 2.6, 28));
    if (head.secret) {
      // A second row lower down, round the base of the basket.
      const d2 = dh * 0.85;
      const y2 = yGirdle - depth * 0.55 - d2 * 0.2;
      const dense2 = outlineLoop(720, 0.55, rp * 1.4 + d2 * 0.18, y2);
      const pts2 = stonesBetween(dense2, prongDegs.map((d) => Math.round(((d % 360) + 360) % 360 * 2) % 720), d2, rp * 2 + 0.1, 0.07).points;
      placeLoopStones(pts2, d2, 64, stones.accent, dense2);
      loop(headMesh, evenly(dense2, 160).points, superellipse(-0.22 * d2, -0.15 * d2, 0.4 * d2, 0.45 * d2, 2.6, 24));
    }
  }

  // Three stone: a stone either side of the centre (any of SIDE_SHAPES), lower down on the
  // band's shoulders and leaning outwards with its curve (or at a chosen angle), each in its own
  // basket that sits on the band, prongs at its corners, its girdle close to the centre stone's.
  // The side stone's length runs along the band; its +z end faces the centre stone.
  const headReach = head.halo ? clamp(0.15 * Math.min(W, L), 0.9, 1.5) * 1.15 + 0.15 : rp * 2.2;
  let sideReach = 0, sideFoot = 0, sideRail = null, sideInfo = null;
  const sideKey = SIDE_SHAPES[o.sideShape] ? o.sideShape : 'round';
  if (head.sides) {
    const sc = cut(sideKey);
    const autoWidth = clamp(0.62 * Math.min(W, L), 2.6, 6.5) * (SIDE_WIDTH[sideKey] ?? 1);
    const ws = Number(o.sideSize) > 0 ? clamp(Number(o.sideSize), 1.5, 8) : autoWidth;
    const sDepth = -sc.bottom * ws, sCrown = sc.top * ws;
    const srp = clamp(0.07 * Math.min(ws, ws * sc.ratio) + 0.06, 0.26, 0.5);
    const lift = sDepth + 0.95;                       // girdle above the basket's foot
    const gap = 0.12 + rp * 0.2;                      // side girdle to centre girdle
    // The stone's outline at its size: how far it reaches towards the centre and away from it.
    const oc = sc.outline.centre ?? [0, 0];
    let zFront = -Infinity, zBack = Infinity;
    for (let i = 0; i < 360; i++) { const { p } = sc.outline.at((i / 360) * 2 * Math.PI); zFront = Math.max(zFront, p[1] * ws); zBack = Math.min(zBack, p[1] * ws); }
    // The centre stone's half-width along x: at its girdle, and down its pavilion, which narrows
    // towards the culet, so a lower side stone can tuck in under the girdle's edge. Its basket's
    // mid rail must stay clear too.
    let inner = 0;
    for (let deg = 0; deg < 360; deg += 2) inner = Math.max(inner, Math.abs(beside(deg, 0, 0, 0)[0]));
    const railX = Math.abs(beside(0, 0.5, rp * 1.1, 0)[0]) + rp * 0.7;
    const clearAt = (y) => {
      const below = clamp((yGirdle - y) / depth, 0, 1);
      // Seen from above, the side stone may only just slip under the girdle's edge.
      return Math.max(inner * Math.max(1 - below * 0.92, 0.95), y < yGirdle - depth * 0.3 ? railX : 0) + gap;
    };
    const placeAt = (phi) => {
      const tBand = shank.strands ? shank.strand * 2 : shankShape(shank, phi).t;
      const rho = R + tBand + lift - 0.22;            // the foot sinks a little into the band
      const th = Number(o.sideAngle) >= 0 ? clamp(Number(o.sideAngle), 0, 50) * DEG : 0.6 * phi;
      return { phi, th, c: [rho * Math.sin(phi), rho * Math.cos(phi)], right: [Math.cos(th), -Math.sin(th)], up: [Math.sin(th), Math.cos(th)] };
    };
    // Lean out along the band until the side stone's inner girdle clears the centre stone.
    let lo = 0.01, hi = 1.4;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2, s = placeAt(mid);
      // The inner end of the side stone's girdle, and the top of its crown there.
      const px = s.c[0] - s.right[0] * zFront, py = s.c[1] - s.right[1] * zFront;
      if (px < clearAt(py + sCrown * 0.5) || px < clearAt(py)) lo = mid; else hi = mid;
    }
    const s = placeAt(hi);
    const prongTs = sideProngDirections(sideKey, sc.ratio).map((d) => {
      let best = 0, bv = -Infinity;
      for (let i = 0; i < 720; i++) { const t = (i / 720) * 2 * Math.PI; const { p } = sc.outline.at(t); const v = p[0] * d[0] + p[1] * d[1]; if (v > bv) { bv = v; best = t; } }
      return best;
    });
    for (const sx of [-1, 1]) {
      const right = [s.right[0], sx * s.right[1], 0], up = [sx * s.up[0], s.up[1], 0];
      // The stone's own axes: x across the band (along the finger), y up through its table,
      // z towards the centre stone. Mirrored on the left so both are right-handed.
      const X = [0, 0, sx], Zc = vec.scale(right, -sx);
      const c = [sx * s.c[0], s.c[1], 0];
      const local = (lx, ly, lz) => vec.add(vec.add(vec.add(c, vec.scale(X, lx)), vec.scale(up, ly)), vec.scale(Zc, lz));
      // A point beside the stone: f of the way down the pavilion, `out` mm outside it.
      const at = (t, f, out, ly) => {
        const { p, n } = sc.outline.at(t);
        const k = 1 - f * 0.92;
        return local((oc[0] + (p[0] - oc[0]) * k) * ws + n[0] * out, ly, (oc[1] + (p[1] - oc[1]) * k) * ws + n[1] * out);
      };
      stones.side.push(matrix(X, up, Zc, ws, c));
      for (const t of prongTs) {
        wire(headMesh, curve([
          at(t, 0.72, srp * 0.6, -lift),
          at(t, 0.5, srp * 1.05, -sDepth * 0.5),
          at(t, 0, srp * 0.95, 0),
          at(t, 0.035, srp * 0.42, sCrown * 0.5 + srp * 0.3),
        ], { steps: 7 }), { radius: (u) => srp * (0.92 + 0.12 * Math.sin(Math.PI * Math.min(u * 1.4, 1)) - 0.06 * u), sides: 16 });
      }
      const ring = (f, out, ly, count) => Array.from({ length: count }, (_, k) => at((k / count) * 2 * Math.PI, f, out, ly));
      wire(headMesh, ring(0.5, srp * 1.1, -sDepth * 0.5, 72), { radius: srp * 0.72, closed: true, sides: 12 });
      wire(headMesh, ring(0.72, srp * 0.6, -lift, 48), { radius: srp * 0.85, closed: true, sides: 12 });
      // A bar low down from the centre basket's foot to this basket's, when they are close, so
      // the three baskets read as one gallery.
      let tIn = 0, zMax = -Infinity;
      for (let i = 0; i < 360; i++) { const t = (i / 360) * 2 * Math.PI; const z = sc.outline.at(t).p[1]; if (z > zMax) { zMax = z; tIn = t; } }
      const to = at(tIn, 0.72, srp * 0.6, -lift);
      const from = beside(sx > 0 ? 0 : 180, 0.72, rp * 0.6, bandTop + 0.25);
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 4.5) wire(headMesh, curve([from, vec.add(vec.scale(vec.add(from, to), 0.5), [0, 0.15, 0]), to], { steps: 6 }), { radius: Math.min(rp, srp) * 0.85, sides: 12 });
      if (sx === 1) {
        // The basket's outer end, where cathedral arches meet it.
        let tOut = 0, zMin = Infinity;
        for (let i = 0; i < 360; i++) { const t = (i / 360) * 2 * Math.PI; const z = sc.outline.at(t).p[1]; if (z < zMin) { zMin = z; tOut = t; } }
        const q = at(tOut, 0.5, srp * 1.1, -sDepth * 0.5);
        sideRail = { x: q[0], y: q[1] };
      }
    }
    const outer = s.c[0] + s.right[0] * (-zBack + srp) + s.up[0] * sCrown;
    sideReach = Math.max(0, outer - (W / 2 + headReach));
    // Where the side basket's foot meets the band, measured along the band.
    sideFoot = (R + tTop) * Math.sin(s.phi) + Math.max(zFront, -zBack) * 0.4 + srp;
    sideInfo = { shape: sideKey, width: round(ws, 2), length: round(ws * sc.ratio, 2), angle: Math.round(s.th / DEG), carats: round(caratsOf(sideKey, ws, accentGemDensity(o)), 3) };
  }

  // ── Shank ──
  const headHalf = Math.max(0.36 * W + rp * 1.6, head.halo ? 0.2 * W : 0, sideFoot) + 0.25;   // head's footprint on the band (along x)
  const phiHead = Math.asin(clamp(headHalf / (R + tTop), 0, 0.95));
  const channel = shank.channel ? channelPlaces(R, shank, phiHead) : null;
  if (shank.strands) strandsShank(shankMesh, R, shank);
  else plainShank(shankMesh, R, shank, { phiHead, channel });
  let paveFrom = phiHead;
  if (shank.cathedral) {
    // Shoulders that leave the band and sweep up in an arch to the basket, leaving an open
    // window between arch and band on each side.
    // With side stones, the arches rise to the side baskets instead.
    const rail = sideRail ?? { x: 0.27 * W + rp * 1.1, y: yGirdle - depth * 0.5 };
    paveFrom = cathedralArms(shankMesh, R, shank, phiHead, rail, shank.pave ? stones.accent : null);
  }
  if (shank.pave) paveRows(shankMesh, R, shank, paveFrom, stones.accent);
  if (channel) channelRow(channel, stones.channel);

  // ── Specs ──
  const gem = GEMS[o.gem], accentGem = GEMS[o.accentGem];
  const accentCarats = sumCarats(stones.accent, 'round-accent', accentGem.density) + sumCarats(stones.channel, 'princess-accent', accentGem.density) + sumCarats(stones.side, sideKey, accentGem.density);
  const centreCarats = caratsOf(o.shape, W, gem.density);
  const headVolume = headMesh.volume, shankVolume = shankMesh.volume;
  const specs = {
    centre: { shape: o.shape, label: SHAPES[o.shape].label, size: o.carat, carats: round(centreCarats, 2), mm: [round(L, 2), round(W, 2)], gem: o.gem },
    accents: { count: stones.accent.length + stones.channel.length + stones.side.length, carats: round(accentCarats, 2), gem: o.accentGem },
    totalCarats: round(centreCarats + accentCarats, 2),
    metal: {
      head: { metal: o.headMetal, label: metalLabel(o.headMetal, o.karat), grams: round(gramsOf(headVolume, o.headMetal, o.karat), 2) },
      shank: { metal: o.shankMetal, label: metalLabel(o.shankMetal, o.karat), grams: round(gramsOf(shankVolume, o.shankMetal, o.karat), 2) },
    },
    head: o.head, shank: o.shank, size: o.size,
    sides: sideInfo,
  };
  specs.metal.grams = round(specs.metal.head.grams + specs.metal.shank.grams, 2);

  return {
    options: o,
    metal: { head: headMesh.finish(), shank: shankMesh.finish() },
    stones: [
      { cut: o.shape, gem: o.gem, role: 'centre', matrices: stones.centre },
      { cut: 'round-accent', gem: o.accentGem, role: 'accent', matrices: stones.accent },
      { cut: 'princess-accent', gem: o.accentGem, role: 'accent', matrices: stones.channel },
      { cut: sideKey, gem: o.accentGem, role: 'centre', matrices: stones.side },
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
        min: [-(W / 2 + headReach + sideReach), bandTop - 0.8, -(L / 2 + headReach)],
        max: [W / 2 + headReach + sideReach, yGirdle + crownH + (head.prongs ? rp : 0.3), L / 2 + headReach],
      },
    },
  };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const accentGemDensity = (o) => (GEMS[o.accentGem] ?? GEMS.diamond).density;
const sumCarats = (list, key, density) => list.reduce((s, m) => s + caratsOf(key, Math.hypot(m[0], m[1], m[2]), density), 0);

/**
 * Positions for small stones along a closed path, leaving a gap (`clear` mm) at each of the
 * given path indices (where prongs pass). Stones are `d` apart plus `gap`, centred in each run.
 */
function stonesBetween(path, gapIdx, d, clear, gap) {
  const n = path.length;
  const cum = [0];
  for (let k = 1; k <= n; k++) cum.push(cum[k - 1] + vec.len(vec.sub(path[k % n], path[k - 1])));
  const total = cum[n];
  const at = (s) => {
    s = ((s % total) + total) % total;
    let k = 0;
    while (cum[k + 1] < s) k++;
    const f = (s - cum[k]) / (cum[k + 1] - cum[k]);
    return vec.add(path[k], vec.scale(vec.sub(path[(k + 1) % n], path[k]), f));
  };
  const cuts = [...new Set(gapIdx)].map((i) => cum[i]).sort((a, b) => a - b);
  const pitch = d + gap;
  const points = [], gapAfter = [];
  if (!cuts.length) {
    const count = Math.max(8, Math.round(total / pitch));
    for (let k = 0; k < count; k++) { points.push(at((k * total) / count)); gapAfter.push(false); }
    return { points, gapAfter };
  }
  cuts.forEach((c, k) => {
    const next = k + 1 < cuts.length ? cuts[k + 1] : cuts[0] + total;
    const room = next - c - clear;
    const count = Math.max(0, Math.floor((room + gap) / pitch));
    const used = count * pitch - gap;
    const start = c + clear / 2 + (room - used) / 2 + d / 2;
    for (let i = 0; i < count; i++) { points.push(at(start + i * pitch)); gapAfter.push(i === count - 1); }
  });
  return { points, gapAfter };
}

/** Outward horizontal direction at a point, from the closed path it lies on. */
function outwardAt(p, ref) {
  let best = 0, bd = Infinity;
  for (let k = 0; k < ref.length; k++) { const d = vec.len(vec.sub(ref[k], p)); if (d < bd) { bd = d; best = k; } }
  const n = ref.length;
  const t = vec.unit(vec.sub(ref[(best + 1) % n], ref[(best - 1 + n) % n]));
  const mid = ref.reduce((s, q) => vec.add(s, q), [0, 0, 0]).map((x) => x / n);
  let o = vec.unit([t[2], 0, -t[0]]);
  if (vec.dot(o, vec.sub(p, mid)) < 0) o = vec.scale(o, -1);
  return { o, t };
}

/** Small stones at points on a closed path (ref), facing up and tilted outwards by `tilt` degrees. */
function placeLoopStones(points, d, tilt, out, ref = points) {
  for (const p of points) {
    const { o, t } = outwardAt(p, ref);
    const c = Math.cos(tilt * DEG), s = Math.sin(tilt * DEG);
    const y = vec.unit(vec.add(vec.scale([0, 1, 0], c), vec.scale(o, s)));
    const x = vec.unit(vec.cross(y, t));
    const z = vec.cross(x, y);
    out.push(matrix(x, y, z, d, p));
  }
}

/** Beads between neighbouring stones of a loop, on its outer and inner edges; none across a gap. */
function loopBeads(m, points, d, y, gapAfter = [], ref = points) {
  const n = points.length;
  for (let k = 0; k < n; k++) {
    const a = points[k], b = points[(k + 1) % n];
    const ends = gapAfter[k] ? [[a, 0.5], [b, -0.5]] : [[vec.scale(vec.add(a, b), 0.5), 0]];
    for (const [c, along] of ends) {
      const { o, t } = outwardAt(c, ref);
      const at = vec.add([c[0], y, c[2]], vec.scale(t, along * (d * 0.55)));
      bead(m, vec.add(at, vec.scale(o, d * 0.47 + 0.03)), d * 0.16, 6);
      bead(m, vec.add(at, vec.scale(o, -(d * 0.47 + 0.01))), d * 0.12, 6);
    }
  }
}

// ── Shanks ──

/** Thickness, width and lift of a plain shank at angle φ from the top. */
function shankShape(shank, phi) {
  const top = (1 + Math.cos(phi)) / 2;    // 1 at the head, 0 at the bottom
  const w = shank.w[0] + (shank.w[1] - shank.w[0]) * top;
  const t = shank.t[0] + (shank.t[1] - shank.t[0]) * top;
  const a = Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi)));
  return { w, t, a };
}

function plainShank(m, R, shank, { phiHead, channel }) {
  const count = channel ? 112 : 48;
  const outerPow = shank.knife ? 2 : 2.4, innerPow = 5;
  const pave = shank.pave;
  const pitch = pave ? pave.d + 0.1 : 1;
  const profile = (phi) => {
    const { w, t, a } = shankShape(shank, phi);
    // Channel: a groove along the top where the stones sit, its walls the rails that hold them.
    const groove = channel ? channel.depthAt(a) : 0;
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
      if (groove > 0 && c > 0 && Math.abs(v) < channel.half) u = Math.min(u, t - groove);
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
  const segments = shank.flutes ? 576 : shank.notch || channel ? 512 : 256;
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
function paveRows(m, R, shank, phiFrom, out) {
  const { rows, d } = shank.pave;
  const gap = shank.pave.count ? 0.22 : 0.1;
  const pitch = d + gap;
  const top = shankShape(shank, 0);
  const spacing = d + 0.14;
  const offsets = rows === 1 ? [0] : rows === 2 ? [-spacing / 2, spacing / 2] : [-spacing, 0, spacing];
  const start = phiFrom + (pitch * 0.55) / (R + top.t);
  const end = (shank.pave.end ?? 180) * DEG;
  // Beads (shared prongs) sit over the stones' edges between neighbours; rows side by side
  // share the beads between them.
  const beadV = [];
  for (const v of offsets) for (const e of [v - (d / 2 - 0.01), v + (d / 2 - 0.01)]) {
    const near = beadV.findIndex((b) => Math.abs(b - e) < d * 0.3);
    if (near >= 0) beadV[near] = (beadV[near] + e) / 2; else beadV.push(e);
  }
  const beadR = d * (shank.pave.count ? 0.17 : 0.15);
  for (const side of [1, -1]) {
    const phis = [];
    let phi = start;
    while (shank.pave.count ? phis.length < shank.pave.count : phi < end) {
      phis.push(phi);
      phi += pitch / (R + shankShape(shank, phi).t);
    }
    // No room for stones (a wide head, or arches reaching past the pavé's end): nothing to set.
    if (!phis.length) continue;
    for (const v of offsets) {
      for (const p of phis) {
        const { w, t } = shankShape(shank, p);
        const vv = v * (w / top.w);
        const surf = surfaceAt(shank, w, t, vv);
        const radial = [Math.sin(side * p), Math.cos(side * p), 0];
        const tilt = rows === 1 ? 0 : surf.tilt;
        const y = vec.unit(vec.add(vec.scale(radial, Math.cos(tilt)), [0, 0, Math.sin(tilt)]));
        const x = vec.unit(vec.cross(y, [0, 0, 1]));
        const z = vec.cross(x, y);
        out.push(matrix(x, y, z, d, vec.add(vec.scale(radial, R + surf.u - d * 0.03), [0, 0, vv])));
      }
    }
    for (let k = 0; k <= phis.length; k++) {
      const p = k === 0 ? phis[0] - (pitch / 2) / (R + top.t) : k === phis.length ? phis[k - 1] + (pitch / 2) / (R + top.t) : (phis[k - 1] + phis[k]) / 2;
      const { w, t } = shankShape(shank, p);
      const radial = [Math.sin(side * p), Math.cos(side * p), 0];
      for (const e of beadV) {
        const vv = Math.max(Math.min(e * (w / top.w), w / 2 - beadR), -(w / 2 - beadR));
        const surf = surfaceAt(shank, w, t, vv);
        bead(m, vec.add(vec.scale(radial, R + surf.u + beadR * 0.3), [0, 0, vv]), beadR, 6);
      }
    }
  }
}

/**
 * Where a channel's square stones go, and the groove that holds them: a slot along the top of
 * the shank, as wide as the stones, deep enough that their tables sit just below the band's top.
 */
function channelPlaces(R, shank, phiHead) {
  const { d, end } = shank.channel;
  const top = shankShape(shank, 0);
  const pitch = d + 0.03;
  const crown = cut('princess-accent').top * d;
  const phis = [];
  let phi = phiHead + (pitch * 0.6) / (R + top.t);
  while (phi < end * DEG) { phis.push(phi); phi += pitch / (R + shankShape(shank, phi).t); }
  const reach = (d / 2 + 0.06) / (R + top.t);
  const a0 = phis[0] - reach, a1 = phis[phis.length - 1] + reach;
  const depth = crown + 0.1;
  return {
    R, shank, d, phis, crown,
    half: d / 2 + 0.02,
    // Full depth along the stones, with steep end walls.
    depthAt: (a) => depth * smooth(a0 - 0.006, a0 + 0.006, a) * (1 - smooth(a1 - 0.006, a1 + 0.006, a)),
  };
}

/** Square stones side by side in the channel, tables just below the rails' tops. */
function channelRow({ R, shank, d, phis, crown }, out) {
  for (const side of [1, -1]) {
    for (const phi of phis) {
      const { t } = shankShape(shank, phi);
      const radial = [Math.sin(side * phi), Math.cos(side * phi), 0];
      const x = vec.unit(vec.cross(radial, [0, 0, 1]));
      out.push(matrix(x, radial, [0, 0, 1], d, vec.scale(radial, R + t - 0.05 - crown)));
    }
  }
}

/**
 * Cathedral shoulders: on each side an arm leaves the band and rises in an arch to the basket
 * rail beside the stone. Returns the band angle beyond which pavé on the band can start.
 */
function cathedralArms(m, R, shank, phiHead, rail, paveOut) {
  const phiStart = phiHead + 44 * DEG;
  const base = shankShape(shank, phiStart);
  const r0 = R + base.t / 2;
  const phiEnd = Math.atan2(rail.x, rail.y), r1 = Math.hypot(rail.x, rail.y);
  const ratio = (base.t * 0.92) / base.w;
  const N = 64;
  for (const side of [1, -1]) {
    const path = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const phi = phiStart + (phiEnd - phiStart) * u;
      // Rises slowly from the band, then steeply up to the head: an arch.
      const r = r0 + (r1 - r0) * u ** 1.75;
      path.push([side * r * Math.sin(phi), r * Math.cos(phi), 0]);
    }
    const halfWidth = (u) => (base.w / 2) * (1 - 0.22 * u);
    wire(m, path, { radius: halfWidth, sides: 24, section: [ratio, 1], up: [0, 0, 1] });
    if (paveOut) {
      // Pavé along the top of the arch.
      const d = shank.pave.d;
      const cum = [0];
      for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + vec.len(vec.sub(path[i], path[i - 1])));
      const total = cum[cum.length - 1];
      for (let s = total * 0.12 + d / 2; s < total * 0.86; s += d + 0.1) {
        let k = 0;
        while (cum[k + 1] < s) k++;
        const f = (s - cum[k]) / (cum[k + 1] - cum[k]);
        const P = vec.add(path[k], vec.scale(vec.sub(path[k + 1], path[k]), f));
        const T = vec.unit(vec.sub(path[k + 1], path[k]));
        let n = vec.unit([-T[1], T[0], 0]);
        if (vec.dot(n, P) < 0) n = vec.scale(n, -1);
        const u = s / total;
        const surface = vec.add(P, vec.scale(n, halfWidth(u) * ratio));
        const x = T, y = n, z = vec.cross(x, y);
        paveOut.push(matrix(x, y, z, d, vec.sub(surface, vec.scale(n, d * 0.03))));
        for (const e of [-1, 1]) bead(m, vec.add(vec.add(surface, vec.scale(T, (d + 0.1) / 2)), [0, 0, e * (d / 2 + 0.02)]), d * 0.15, 6);
      }
    }
  }
  return phiStart + 0.02;
}

export { HEADS as RING_HEADS, SHANKS as RING_SHANKS, METALS };
