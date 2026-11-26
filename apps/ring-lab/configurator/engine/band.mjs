/**
 * The wedding band builder's design engine. A band is a cross-section (profile) swept round the
 * finger: width, thickness, outer shape, one to five metal sections across it (each with its own
 * metal and finish, and a choice of join between them), an inside lining, edge details,
 * decorative lines, stones in many arrangements (rows, eternity, collet, tension, scatter, gold
 * beads), and an engraving inside with an optional hidden stone. Everything is in millimetres,
 * and metal weights come from the cross-section's area (Pappus' theorem), so the price follows
 * the design.
 *
 * Axes as in geometry.mjs: finger along z, band in the x-y plane, φ measured from the top.
 */
import { cut, caratsOf } from './cuts.mjs';
import { Mesh, grid, bead, wire, matrix, vec } from './geometry.mjs';
import { GEMS, gramsOf, metalLabel, euToDiameter } from './materials.mjs';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smoothstep = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const DEG = Math.PI / 180;

// Menus list options in these orders.
export const PROFILES = {
  comfort: { label: 'Comfort' },
  dome: { label: 'Dome' },
  flat: { label: 'Flat' },
  'flat-court': { label: 'Flat court' },
  stepped: { label: 'Stepped' },
  beveled: { label: 'Bevelled' },
  concave: { label: 'Concave' },
  cushion: { label: 'Cushion' },
  'knife-edge': { label: 'Knife edge' },
  round: { label: 'Half round' },
};

export const BAND_SHAPES = {
  classic: { label: 'Classic' },
  square: { label: 'Soft square' },
  cushion: { label: 'Cushion' },
  octagon: { label: 'Octagon' },
  hexagon: { label: 'Hexagon' },
  oval: { label: 'Oval' },
  wave: { label: 'Twist' },
  wavy: { label: 'Ripple' },
};

/** How the band's width is shared between its metal sections. */
export const PROPORTIONS = { even: { label: 'Even' }, 'wide-centre': { label: 'Wide middle' }, 'slim-centre': { label: 'Slim middle' } };
/** How neighbouring sections meet. */
export const JOINS = { flush: { label: 'Seamless' }, line: { label: 'Fine line' }, groove: { label: 'V-groove' }, step: { label: 'Raised' } };
/** Decorative lines cut round the band. */
export const GROOVES = { none: { label: 'None' }, centre: { label: 'One line' }, double: { label: 'Two lines' }, triple: { label: 'Three lines' } };
export const EDGES = { none: { label: 'Plain' }, bevel: { label: 'Chamfer' }, step: { label: 'Shoulder' }, line: { label: 'Edge line' }, milgrain: { label: 'Milgrain' }, rope: { label: 'Rope' } };
export const EDGE_SIDES = { both: { label: 'Both edges' }, left: { label: 'Left edge' }, right: { label: 'Right edge' } };

/** Where stones go. */
export const ARRANGEMENTS = {
  none: { label: 'No stones' },
  solitaire: { label: 'Single' },
  trio: { label: 'Trio' },
  across: { label: 'Row across' },
  along: { label: 'Row along' },
  bezel: { label: 'Collet' },
  tension: { label: 'Tension' },
  scatter: { label: 'Scatter' },
};
export const SET_STYLES = { pave: { label: 'Pavé' }, channel: { label: 'Channel' }, flush: { label: 'Flush' } };
export const SPANS = {
  quarter: { label: '¼ round', f: 0.25 }, third: { label: '⅓ round', f: 1 / 3 }, half: { label: '½ round', f: 0.5 },
  threequarter: { label: '¾ round', f: 0.75 }, full: { label: 'All round', f: 1 },
};
export const SPACINGS = {
  touching: { label: 'Touching', gap: () => 0.05 }, close: { label: 'Close', gap: (d) => 0.3 * d },
  airy: { label: 'Airy', gap: (d) => d }, wide: { label: 'Spread', gap: (d) => 2.2 * d },
};
export const TILTS = { straight: { label: 'Straight', deg: 0 }, left: { label: 'Slant left', deg: -40 }, right: { label: 'Slant right', deg: 40 } };
export const SCATTER_PATTERNS = {
  sprinkle: { label: 'Sprinkle' }, starry: { label: 'Starry' }, cluster: { label: 'Cluster' },
  comet: { label: 'Comet' }, wave: { label: 'Wave' }, rain: { label: 'Rain' },
};
export const SCATTER_TYPES = { diamonds: { label: 'Stones' }, beads: { label: 'Gold beads' }, mixed: { label: 'Mixed' } };
/** Stone colours offered for the band's stones, as GEMS keys. */
export const STONE_COLOURS = ['diamond', 'blackdiamond', 'champagne', 'yellowdiamond', 'pinkdiamond', 'bluediamond', 'ruby', 'sapphire', 'emerald'];
/** The hidden stone inside the band. */
export const INNER_STONES = ['none', 'diamond', 'blackdiamond', 'pinkdiamond', 'bluediamond', 'ruby', 'sapphire', 'emerald'];
export const ENGRAVING_SIZES = { small: { label: 'Small', k: 0.75 }, medium: { label: 'Medium', k: 1 }, large: { label: 'Large', k: 1.25 } };

export const WIDTH_NAMES = [[0, 'Thin'], [2.8, 'Slim'], [3.6, 'Regular'], [5.5, 'Wide'], [7.5, 'Bold']];
export const widthName = (w) => WIDTH_NAMES.filter(([min]) => w >= min).pop()[1];
/** Thickness that suits a width ("auto-match thickness to width"). */
export const autoThickness = (w) => round(clamp(1.25 + 0.12 * w, 1.4, 2.4), 2);

export const EU_SIZES = Array.from({ length: 27 }, (_, i) => 44 + i);

export const DEFAULT_BAND = {
  profile: 'cushion', width: 4, thickness: autoThickness(4), autoThickness: true, shape: 'classic', size: 52, karat: '14k',
  sections: 1, proportion: 'even',
  metal: 'yellow', metal2: 'white', metal3: 'yellow', metal4: 'white', metal5: 'yellow',
  finish: 'polished', finish2: 'satin', finish3: 'polished', finish4: 'satin', finish5: 'polished',
  insidePolished: true, lining: false, liningMetal: 'white',
  join: 'flush', grooves: 'none', edge: 'none', edgeSide: 'both',
  arrangement: 'none', setStyle: 'pave', stoneSize: 1.5, stoneCount: 3, span: 'half', spacing: 'close', tilt: 'straight',
  stonePosition: 0, stoneAngle: 0, stoneColour: 'diamond',
  scatterPattern: 'sprinkle', scatterRepeat: 3, scatterCount: 7, scatterType: 'diamonds',
  engraving: '', font: 'serif', engravingSize: 'medium', engravingAngle: 0, innerStone: 'none',
};

/** Each section's metal and finish keys, in order across the band. */
export const SECTION_KEYS = [['metal', 'finish'], ['metal2', 'finish2'], ['metal3', 'finish3'], ['metal4', 'finish4'], ['metal5', 'finish5']];

/**
 * Options with defaults filled in. Older designs (shared links) named their layout and diamonds
 * differently: those are translated here.
 */
export function bandOptions(input = {}) {
  const o = { ...DEFAULT_BAND, ...input };
  if (input.sections == null && input.layout) {
    const [a, b, fa, fb] = [o.metal, o.metal2, o.finish, o.finish2];
    if (input.layout === 'split') o.sections = 2;
    else if (input.layout === 'stripe') Object.assign(o, { sections: 3, metal3: a, finish3: fa });
    else if (input.layout === 'edges') Object.assign(o, { sections: 3, metal: b, metal2: a, metal3: b, finish: fb, finish2: fa, finish3: fb });
    else if (input.layout === 'inside') Object.assign(o, { sections: 1, lining: true, liningMetal: b });
    else o.sections = 1;
  }
  if (input.arrangement == null && input.setting) {
    const [arrangement, setStyle, span] = {
      solitaire: ['solitaire'], three: ['trio'], 'channel-half': ['along', 'channel', 'half'], 'channel-full': ['along', 'channel', 'full'],
      'pave-half': ['along', 'pave', 'half'], 'pave-full': ['along', 'pave', 'full'],
    }[input.setting] ?? ['none'];
    Object.assign(o, { arrangement }, setStyle ? { setStyle } : {}, span ? { span } : {}, setStyle === 'channel' ? { spacing: 'touching' } : {});
  }
  if (input.grooves === 'seams') Object.assign(o, { grooves: 'none', join: 'groove' });
  o.sections = clamp(Math.round(Number(o.sections) || 1), 1, 5);
  if (!PROFILES[o.profile]) o.profile = DEFAULT_BAND.profile;
  if (!BAND_SHAPES[o.shape]) o.shape = DEFAULT_BAND.shape;
  if (!ARRANGEMENTS[o.arrangement]) o.arrangement = 'none';
  if (!SPANS[o.span]) o.span = 'half';
  if (!SPACINGS[o.spacing]) o.spacing = 'close';
  if (!SET_STYLES[o.setStyle]) o.setStyle = 'pave';
  if (!TILTS[o.tilt]) o.tilt = 'straight';
  if (!GEMS[o.stoneColour]) o.stoneColour = 'diamond';
  return o;
}

/** The sections across the band as ranges of s (−1 to 1) with their index. */
export function sectionZones(count, proportion = 'even') {
  const weights = Array.from({ length: count }, (_, i) => {
    if (proportion === 'even' || count === 1) return 1;
    const middle = count === 2 ? i === 0 : i > 0 && i < count - 1;
    return middle ? (proportion === 'wide-centre' ? 2.2 : 0.45) : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let at = -1;
  return weights.map((x, i) => { const lo = at; at = i === count - 1 ? 1 : at + (2 * x) / total; return [lo, at, i]; });
}

// ─── Cross-section ──────────────────────────────────────────────────────────

/**
 * The profile as a closed loop in normalised coordinates: s across the band (−1 to 1), q
 * outwards (0 inner surface, 1 outer surface at its highest). Each point carries which surface
 * it is on (inner, outer) so that metals and finishes can be assigned per surface.
 */
function profileLoop(kind, opts = {}) {
  const { grooves = 'none', seams = [], join = 'flush', zoneOf = () => 0, edge = 'none', edgeSide = 'both' } = opts;
  const N = 72;
  const base = (a) => {
    switch (kind) {
      case 'flat': return a < 0.92 ? 1 : 1 - (a - 0.92) * 1.2;
      case 'flat-court': return a < 0.6 ? 1 : 1 - 0.32 * ((a - 0.6) / 0.4) ** 2.2;
      case 'round': return 0.18 + 0.82 * Math.sqrt(Math.max(1 - a * a, 0));
      case 'cushion': return 0.12 + 0.88 * (1 - a ** 4) ** 0.25;
      case 'dome': return 0.32 + 0.68 * Math.sqrt(Math.max(1 - a * a, 0));
      case 'knife-edge': return 0.3 + 0.7 * (1 - a) ** 0.9;
      case 'beveled': return a < 0.55 ? 1 : 1 - (a - 0.55) * 1.3;
      case 'comfort': return 0.2 + 0.8 * (1 - a ** 2.4) ** (1 / 2.4);
      // Edges higher than the middle, rounded off at the very edge.
      case 'concave': return (0.8 + 0.2 * Math.min(a, 0.9) ** 2) * (a < 0.9 ? 1 : 1 - (a - 0.9) * 3.2);
      // A raised band down the middle with lower shoulders either side.
      case 'stepped': return (a < 0.4 ? 1 : 0.78 + 0.22 * (1 - smoothstep(0.4, 0.45, a))) * (a < 0.93 ? 1 : 1 - (a - 0.93) * 3);
      default: return 1;
    }
  };
  const edgeOn = (s) => edge !== 'none' && (edgeSide === 'both' || (edgeSide === 'left' ? s < 0 : s > 0));
  const lineAt = (list, s, depth, half) => list.reduce((g, x) => Math.max(g, depth * Math.max(0, 1 - Math.abs(s - x) / half)), 0);
  const decor = { centre: [0], double: [-0.34, 0.34], triple: [-0.5, 0, 0.5] }[grooves] ?? [];
  // Raised join: every second section stands a little proud of its neighbours.
  const raised = (s) => {
    for (const x of seams) if (Math.abs(s - x) < 0.014) {
      const l = zoneOf(x - 0.02) % 2, r = zoneOf(x + 0.02) % 2;
      return l + (r - l) * smoothstep(x - 0.012, x + 0.012, s);
    }
    return zoneOf(s) % 2;
  };
  const top = (s) => {
    const a = Math.abs(s);
    let q = base(a);
    if (edgeOn(s)) {
      if (edge === 'bevel' && a > 0.78) q = Math.min(q, base(0.78) - (a - 0.78) * 1.7);
      if (edge === 'step') q -= base(0.84) * 0.2 * smoothstep(0.835, 0.855, a);
      if (edge === 'line') q -= lineAt([0.8], a, 0.1, 0.035);
      // Milgrain and rope sit on a little ledge along the edge.
      if (edge === 'milgrain' || edge === 'rope') q -= 0.12 * smoothstep(0.835, 0.86, a);
    }
    let g = lineAt(decor, s, 0.13, 0.07);
    if (join === 'groove') g = Math.max(g, lineAt(seams, s, 0.13, 0.07));
    if (join === 'line') g = Math.max(g, lineAt(seams, s, 0.04, 0.022));
    q -= g;
    if (join === 'step' && seams.length) q += 0.07 * raised(s);
    return Math.max(q, 0.05);
  };
  // Even samples, plus close ones where the profile turns sharply (seams, edge details).
  const S = new Set();
  for (let i = 0; i <= N; i++) S.add(round(-1 + (2 * i) / N, 6));
  const near = (x, steps = [-0.03, -0.02, -0.012, -0.006, 0, 0.006, 0.012, 0.02, 0.03]) => { for (const d of steps) if (x + d > -1 && x + d < 1) S.add(round(x + d, 6)); };
  if (join !== 'flush') seams.forEach((x) => near(x));
  else seams.forEach((x) => S.add(round(x, 6)));
  if (edge !== 'none') for (const x of [0.8, 0.845, 0.86]) { near(x); near(-x); }
  const outer = [...S].sort((a, b) => a - b).map((s) => [s, top(s), 'outer']);
  // Inner surface (comfort fit for court-type profiles), s from 1 back to −1.
  const comfort = kind === 'comfort' || kind === 'flat-court' || kind === 'cushion' ? 0.14 : 0.04;
  const inner = [];
  for (let i = 0; i <= N; i++) {
    const s = 1 - (2 * i) / N;
    inner.push([s, -comfort * (1 - s * s), 'inner']);
  }
  return [...outer, ...inner];
}

/** A profile's cross-section in mm (closed loop of [across, outwards]), for previews. */
export function profilePoints(kind, width = 4, thickness = autoThickness(width), opts = {}) {
  const o = typeof opts === 'string' ? { grooves: opts } : opts;
  return profileLoop(kind, o).map(([s, q]) => [s * width / 2, q * thickness]);
}

/** Clips a closed polygon (points [s, q, …]) to s in [lo, hi]. */
function clipS(poly, lo, hi) {
  const clip = (pts, keep, edge) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ka = keep(a[0]), kb = keep(b[0]);
      if (ka) out.push(a);
      if (ka !== kb) { const t = (edge - a[0]) / (b[0] - a[0]); out.push([edge, a[1] + (b[1] - a[1]) * t, 'seam']); }
    }
    return out;
  };
  return clip(clip(poly, (s) => s >= lo, lo), (s) => s <= hi, hi);
}

/** Area and centroid height of a polygon in (s, q), scaled to mm by half-width hw and thickness t. */
function areaOf(poly, hw, t) {
  let A = 0, cq = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const c = x0 * y1 - x1 * y0;
    A += c; cq += (y0 + y1) * c;
  }
  A /= 2;
  return { area: Math.abs(A) * hw * t, centroid: A ? (cq / (6 * A)) * t : 0 };
}

// ─── Outer shape round the finger ───────────────────────────────────────────

/** How much thicker than usual the band is at angle φ, so its outside makes the shape. */
function shapeFactor(shape, phi, R, t) {
  const Ro = R + t;
  const thick = (r) => (r - R) / t;
  switch (shape) {
    case 'oval': {
      const a = Ro * 1.1, b = Ro;
      return thick((a * b) / Math.hypot(b * Math.sin(phi), a * Math.cos(phi)));
    }
    case 'cushion': case 'square': {
      const p = shape === 'square' ? 9 : 4.5;
      return thick(Ro / (Math.abs(Math.cos(phi)) ** p + Math.abs(Math.sin(phi)) ** p) ** (1 / p));
    }
    case 'hexagon': case 'octagon': {
      const n = shape === 'hexagon' ? 6 : 8;
      const sector = (2 * Math.PI) / n;
      const local = ((phi % sector) + sector) % sector - sector / 2;
      // Rounded corners: blend the polygon with a circle near each corner.
      const r = Ro / Math.cos(local);
      const corner = Ro / Math.cos(sector / 2);
      return thick(Math.min(r, corner - (corner - Ro) * 0.25));
    }
    default: return 1;
  }
}

// ─── Scatter patterns ───────────────────────────────────────────────────────

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * Stones for one repeat of a scatter pattern, in mm: x round the band (−L/2 to L/2), y across
 * it, k the stone's size relative to the chosen size. Stones never overlap or leave the band.
 */
export function scatterLayout(pattern, count, d, width, L, seed = 1) {
  const rnd = rng(seed * 7919 + count * 31 + Object.keys(SCATTER_PATTERNS).indexOf(pattern) * 101);
  const ymax = width / 2;
  const pts = [];
  const add = (x, y, k) => {
    const r = (d * k) / 2;
    if (Math.abs(y) > ymax - r - 0.25 || Math.abs(x) > L / 2 - r) return false;
    if (pts.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + 0.15)) return false;
    pts.push({ x, y, k, r });
    return true;
  };
  const room = ymax - d * 0.5 - 0.25;
  const fill = (make, limit = count * 60) => { for (let i = 0, tries = 0; pts.length < count && tries < limit; tries++) if (make(i, tries)) i++; };
  switch (pattern) {
    case 'starry':
      // A few larger stars in a dust of small ones.
      fill((i) => add((rnd() - 0.5) * L, (rnd() * 2 - 1) * room, i < Math.max(1, Math.round(count / 5)) ? 1.25 : 0.5));
      break;
    case 'cluster': {
      add(0, 0, 1.15);
      const golden = Math.PI * (3 - Math.sqrt(5));
      fill((i) => { const k = Math.max(0.5, 1 - 0.07 * i), rr = d * (0.75 + 0.55 * Math.sqrt(i + 1)); return add(rr * Math.cos(i * golden), rr * Math.sin(i * golden) * 0.8, k); });
      break;
    }
    case 'comet': {
      add(-L / 2 + d * 0.75, 0, 1.2);
      let x = -L / 2 + d * 0.75;
      fill((i) => { const k = Math.max(0.45, 1.2 * 0.86 ** (i + 1)); x += d * k * 0.95 + 0.2; return add(x, room * 0.45 * Math.sin((i + 1) * 0.7), k); }, count * 4);
      break;
    }
    case 'wave':
      fill((i) => add(-L / 2 + (L * (i + 0.5)) / count, room * 0.8 * Math.sin((i / Math.max(1, count - 1)) * Math.PI * 2), i % 2 ? 0.75 : 1), count * 4);
      break;
    case 'rain': {
      // Short slanting streaks of three, largest first.
      const streaks = Math.max(1, Math.ceil(count / 3));
      for (let j = 0; j < streaks && pts.length < count; j++) {
        const x0 = -L / 2 + (L * (j + 0.5)) / streaks, y0 = room * (j % 2 ? -0.35 : 0.35);
        [1, 0.78, 0.58].forEach((k, n) => { if (pts.length < count) add(x0 + n * d * 0.75, y0 - n * d * 0.95 * Math.sign(y0 || 1), k); });
      }
      break;
    }
    default: // sprinkle
      fill((i) => add((rnd() - 0.5) * L, (rnd() * 2 - 1) * room, [1, 0.8, 0.65][i % 3]));
  }
  return pts;
}

// ─── Band ───────────────────────────────────────────────────────────────────

/**
 * Builds one band. Returns surfaces grouped by metal and finish (parts), stone placements,
 * specs (grams per metal, stones, carats) and the engraving's place on the inner surface.
 */
export function buildBand(input = {}) {
  const o = bandOptions(input);
  const R = euToDiameter(o.size) / 2;
  const w = clamp(o.width, 2, 10);
  const t = o.autoThickness ? autoThickness(w) : clamp(o.thickness, 1.2, 3);
  const hw = w / 2, Rt = R + t;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // Sections across the band, each with its metal and finish.
  const zones = sectionZones(o.sections, o.proportion);
  const sectionMetal = (i) => o[SECTION_KEYS[i][0]] ?? o.metal;
  const sectionFinish = (i) => o[SECTION_KEYS[i][1]] ?? o.finish;
  const seams = zones.slice(1).map((z) => z[0]);
  const zoneAt = (sv) => zones.find(([lo, hi]) => sv >= lo - 1e-9 && sv <= hi + 1e-9)?.[2] ?? 0;
  const loop = profileLoop(o.profile, { grooves: o.grooves, seams, join: o.join, zoneOf: zoneAt, edge: o.edge, edgeSide: o.edgeSide });
  const outerProfile = loop.filter((p) => p[2] === 'outer');
  // Height of the outer surface across the band (normalised), between samples.
  const surfQ = (sv) => {
    for (let i = 1; i < outerProfile.length; i++) {
      const a = outerProfile[i - 1], b = outerProfile[i];
      if (sv <= b[0]) return a[1] + ((b[1] - a[1]) * (sv - a[0])) / Math.max(b[0] - a[0], 1e-9);
    }
    return outerProfile[outerProfile.length - 1][1];
  };

  // ── Stones: what is cut into the band for them ──
  const arrangement = o.arrangement;
  const d = clamp(o.stoneSize, 0.8, 3.5);
  const phi0 = (Number(o.stoneAngle) || 0) * DEG;
  const s0 = clamp(o.stonePosition, -1, 1) * Math.max(0, 1 - (d + 0.6) / w);
  const tilt = TILTS[o.tilt].deg * DEG;
  // A row along the band: how many stones, how far apart, and how much of the band it covers.
  let row = null;
  if (arrangement === 'along') {
    const channel = o.setStyle === 'channel';
    const size = channel ? d : Math.min(d, 2.2);
    const gap = Math.max(channel ? 0.02 : 0.08, SPACINGS[o.spacing].gap(size));
    const pitch = size + gap;
    const full = SPANS[o.span].f >= 0.999;
    const count = Math.max(1, Math.floor(((full ? 2 * Math.PI : 2 * Math.PI * SPANS[o.span].f) * Rt) / pitch));
    const step = full ? (2 * Math.PI) / count : pitch / Rt;
    row = { channel, size, pitch, count, step, full, start: phi0 - (full ? 0 : ((count - 1) * step) / 2), cover: full ? 2 * Math.PI : count * step + 0.04 / Rt };
  }
  const groove = row?.channel ? {
    half: (row.size / 2 + 0.02) / hw,
    depth: cut('princess-accent').top * row.size + 0.1,
    // Full depth along the stones, with steep walls at the ends of a part-way channel.
    at: (phi) => {
      if (row.full) return 1;
      const a = wrap(phi - phi0), e = 0.006, h = row.cover / 2;
      return (1 - smoothstep(h - e, h + e, a)) * smoothstep(-h - e, -h + e, a);
    },
  } : null;
  // Tension: a slot across the band holds the stone by its girdle.
  const slot = arrangement === 'tension' ? { half: d * 0.31, depth: Math.min(cut('round').top * d + 0.28, t * 0.62), slope: Math.tan(tilt) } : null;
  const qStones = surfQ(s0);

  // φ-dependent placement: wave shapes move the band along the finger; wavy ones change width.
  const segments = slot ? 768 : o.shape === 'wavy' || o.shape === 'wave' || groove ? 384 : 256;
  const place = (phi, s, q, cutRecess = true) => {
    let v = s * hw;
    const k = shapeFactor(o.shape, phi, R, t);
    if (o.shape === 'wave') v += 0.22 * w * Math.sin(2 * phi);
    // Wavy: a gentle ripple round the band, as on a real wavy band.
    if (o.shape === 'wavy') v = s * hw * (1 + 0.05 * Math.sin(7 * phi)) + 0.07 * w * Math.sin(7 * phi);
    // The outer surface follows the shape; the inside stays round.
    const lift = (qq) => qq * t * (1 + (k - 1) * clamp(qq / 0.3, 0, 1));
    let u = q >= 0 ? lift(q) : q * t;
    if (groove && cutRecess && q > 0.2 && Math.abs(s - s0) < groove.half) {
      const g = groove.at(phi);
      if (g > 0) u = Math.min(u, lift(qStones) - groove.depth * g);
    }
    if (slot && cutRecess && q > 0.2) {
      const along = wrap(phi - phi0) * Rt - slot.slope * (s - s0) * hw;
      const g = 1 - smoothstep(slot.half, slot.half + 0.05, Math.abs(along));
      if (g > 0) u = Math.min(u, lift(q) - slot.depth * g);
    }
    const r = R + u;
    return [r * Math.sin(phi), r * Math.cos(phi), v];
  };

  // Surfaces: the outer surface split at the section seams, the two side walls, and the inside.
  // Each becomes a run of the profile with hard edges where runs meet.
  const innerPts = loop.filter((p) => p[2] === 'inner');
  const outerPts = [];
  for (let i = 0; i < outerProfile.length; i++) {
    const a = outerProfile[i], b = outerProfile[i + 1];
    // A point exactly on a seam is where one metal's run ends and the next begins.
    outerPts.push(seams.some((sm) => Math.abs(a[0] - sm) < 1e-9) && i > 0 && b ? [...a.slice(0, 3), 'seam'] : a);
    if (b) for (const sm of seams) if ((a[0] - sm) * (b[0] - sm) < 0) {
      const f = (sm - a[0]) / (b[0] - a[0]);
      outerPts.push([sm, a[1] + (b[1] - a[1]) * f, 'outer', 'seam']);
    }
  }
  const runs = [];
  let run = [outerPts[0]];
  for (let i = 1; i < outerPts.length; i++) {
    run.push(outerPts[i]);
    if (outerPts[i][3] === 'seam') { runs.push({ key: `outer:${zoneAt((run[0][0] + run[1][0]) / 2)}`, points: run }); run = [outerPts[i]]; }
  }
  runs.push({ key: `outer:${zoneAt((run[0][0] + run[1][0]) / 2)}`, points: run });
  const lastOuter = outerPts[outerPts.length - 1], firstOuter = outerPts[0];
  runs.push({ key: `wall:${zoneAt(1)}`, points: [lastOuter, innerPts[0]] });
  runs.push({ key: o.lining ? 'inner:lining' : 'inner:0', points: innerPts });
  runs.push({ key: `wall:${zoneAt(-1)}`, points: [innerPts[innerPts.length - 1], firstOuter] });

  const meshes = new Map();
  for (const r of runs) {
    if (!meshes.has(r.key)) meshes.set(r.key, new Mesh());
    const m = meshes.get(r.key);
    const n = r.points.length;
    // uv: round the band (0–1) and across it (0–1), for finishes and the engraving.
    grid(m, segments, n, (i, j) => place((i / segments) * 2 * Math.PI, r.points[j][0], r.points[j][1]),
      { wrapRows: true, uv: (i, j) => [i / segments, (r.points[j][0] + 1) / 2] });
  }
  // Every run follows the loop the same way round, so one check orients them all: the
  // outermost point's normal must point away from the finger.
  orientAll([...meshes.values()]);

  // ── Stones, beads and other metal details ──
  const groups = new Map();
  const addStone = (cutKey, gem, m) => {
    const key = `${cutKey}|${gem}`;
    if (!groups.has(key)) groups.set(key, { cut: cutKey, gem, role: 'accent', matrices: [] });
    groups.get(key).matrices.push(m);
  };
  const extras = new Map();
  const extraFor = (zone) => { if (!extras.has(zone)) extras.set(zone, new Mesh()); return extras.get(zone); };
  const surface = (phi, sv) => ({ p: place(phi, sv, surfQ(sv), false), radial: [Math.sin(phi), Math.cos(phi), 0] });
  const frameAt = (radial) => { const x = vec.unit(vec.cross(radial, [0, 0, 1])); return { x, z: vec.cross(x, radial) }; };
  const gem = o.stoneColour;
  const cutFor = (size) => (size >= 2.2 ? 'round' : 'round-accent');
  /** A stone on the outer surface, sunk by `sink` of its crown (1: table level with the metal). */
  const put = (phi, sv, size, { sink = 0.4, raise = 0, rim = 0, cutKey = cutFor(size) } = {}) => {
    const { p, radial } = surface(phi, sv);
    const { x, z } = frameAt(radial);
    addStone(cutKey, gem, matrix(x, radial, z, size, vec.add(p, vec.scale(radial, raise - cut(cutKey).top * size * sink))));
    if (rim) {
      // A polished rim round a flush-set stone.
      const ring = [];
      for (let k = 0; k < 40; k++) {
        const a = (k / 40) * 2 * Math.PI;
        ring.push(vec.add(vec.add(p, vec.scale(radial, raise)), vec.add(vec.scale(x, Math.cos(a) * size * 0.53), vec.scale(z, Math.sin(a) * size * 0.53))));
      }
      wire(extraFor(zoneAt(sv)), ring, { radius: size * rim, closed: true, sides: 8 });
    }
  };
  let beadCount = 0;
  const goldBead = (phi, sv, r) => {
    beadCount++;
    const { p, radial } = surface(phi, sv);
    bead(extraFor(zoneAt(sv)), vec.add(p, vec.scale(radial, r * 0.3)), r, 7);
  };

  if (arrangement === 'solitaire') put(phi0, s0, d, { rim: 0.07 });
  else if (arrangement === 'trio') {
    for (const k of [-1, 0, 1]) put(phi0 + (k * (d * 0.9 + 0.6)) / Rt, s0, k ? d * 0.8 : d, { rim: 0.07 });
  } else if (arrangement === 'across') {
    // A line of stones across the band, straight or slanting.
    const gap = Math.max(0.12, SPACINGS[o.spacing].gap(d) * 0.6);
    const pitch = d + gap;
    const dirAlong = Math.sin(tilt), dirAcross = Math.cos(tilt);
    const reach = Math.max(0, hw - d / 2 - 0.3) / Math.max(dirAcross, 0.2);
    const n = clamp(Math.round(o.stoneCount), 1, Math.max(1, Math.floor((2 * reach) / pitch) + 1));
    for (let k = 0; k < n; k++) {
      const m = (k - (n - 1) / 2) * pitch;
      put(phi0 + (m * dirAlong) / Rt, (m * dirAcross) / hw, d, { rim: 0.06 });
    }
  } else if (arrangement === 'along' && row) {
    if (row.channel) {
      // In the groove, tables just below the band's surface; the groove's walls hold them.
      const crown = cut('princess-accent').top * row.size;
      for (let k = 0; k < row.count; k++) {
        const phi = row.start + k * row.step;
        const { p, radial } = { p: place(phi, s0, qStones, false), radial: [Math.sin(phi), Math.cos(phi), 0] };
        const { x, z } = frameAt(radial);
        addStone('princess-accent', gem, matrix(x, radial, z, row.size, vec.sub(p, vec.scale(radial, 0.03 + crown))));
      }
    } else {
      for (let k = 0; k < row.count; k++) put(row.start + k * row.step, s0, row.size, { cutKey: 'round-accent', rim: o.setStyle === 'flush' ? 0.06 : 0 });
      if (o.setStyle === 'pave') {
        // Beads between neighbours, on both sides of the line.
        for (let k = 0; k < (row.full ? row.count : row.count + 1); k++) {
          const phi = row.start + (k - 0.5) * row.step;
          const { p, radial } = surface(phi, s0);
          for (const side of [-1, 1]) bead(extraFor(zoneAt(s0)), vec.add(vec.add(p, vec.scale(radial, 0.06)), [0, 0, side * (row.size / 2 + 0.04)]), row.size * 0.17, 6);
        }
      }
    }
  } else if (arrangement === 'bezel') {
    // A collet: the stone raised in a round collar of metal.
    const raise = 0.3;
    put(phi0, s0, d, { sink: 0.05, raise });
    const { p, radial } = surface(phi0, s0);
    const { x, z } = frameAt(radial);
    for (const [h, rr, wr] of [[raise + 0.02, 0.56, 0.11], [raise * 0.4, 0.58, 0.15], [0, 0.6, 0.17]]) {
      const ring = [];
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * 2 * Math.PI;
        ring.push(vec.add(vec.add(p, vec.scale(radial, h)), vec.add(vec.scale(x, Math.cos(a) * d * rr), vec.scale(z, Math.sin(a) * d * rr))));
      }
      wire(extraFor(zoneAt(s0)), ring, { radius: d * wr, closed: true, sides: 10 });
    }
  } else if (arrangement === 'tension' && slot) {
    // The stone sits in the slot, its table a little below the band's surface.
    const { p, radial } = surface(phi0, s0);
    const { x, z } = frameAt(radial);
    const c = cut(cutFor(d));
    addStone(cutFor(d), gem, matrix(x, radial, z, d, vec.sub(p, vec.scale(radial, c.top * d + 0.06))));
  } else if (arrangement === 'scatter') {
    const repeats = clamp(Math.round(o.scatterRepeat), 1, 8);
    const L = repeats === 1 ? Math.min(2 * Math.PI * Rt * 0.3, 18) : ((2 * Math.PI * Rt) / repeats) * 0.82;
    const pts = scatterLayout(o.scatterPattern, clamp(Math.round(o.scatterCount), 3, 18), d, w, L);
    let n = 0;
    for (let j = 0; j < repeats; j++) {
      const centre = phi0 + (j * 2 * Math.PI) / repeats;
      for (const pt of pts) {
        const phi = centre + pt.x / Rt, sv = clamp(pt.y / hw, -0.95, 0.95);
        const bead = o.scatterType === 'beads' || (o.scatterType === 'mixed' && n % 2 === 1);
        if (bead) goldBead(phi, sv, pt.r * 0.85);
        else put(phi, sv, d * pt.k, { sink: 0.6, cutKey: 'round-accent', rim: 0.05 });
        n++;
      }
    }
  }

  // Edge details made of metal: milgrain beads or a twisted rope along the chosen edges.
  const edgeSides = o.edge === 'milgrain' || o.edge === 'rope' ? (o.edgeSide === 'both' ? [-1, 1] : [o.edgeSide === 'left' ? -1 : 1]) : [];
  for (const side of edgeSides) {
    const sv = side * 0.925;
    const zone = zoneAt(sv);
    if (o.edge === 'milgrain') {
      const r = clamp(w * 0.045, 0.16, 0.26);
      const count = Math.floor((2 * Math.PI * Rt) / (r * 2.3));
      for (let k = 0; k < count; k++) {
        const phi = (k / count) * 2 * Math.PI;
        const { p, radial } = surface(phi, sv);
        bead(extraFor(zone), vec.add(p, vec.scale(radial, r * 0.35)), r, 5);
      }
    } else {
      const r = clamp(w * 0.035, 0.12, 0.2);
      const N = 900, twists = Math.round((2 * Math.PI * Rt) / (r * 7));
      for (const phase of [0, Math.PI]) {
        const path = [];
        for (let k = 0; k < N; k++) {
          const phi = (k / N) * 2 * Math.PI, th = phi * twists + phase;
          const { p, radial } = surface(phi, sv);
          path.push(vec.add(vec.add(p, vec.scale(radial, r * (1.1 + 0.9 * Math.sin(th)))), [0, 0, r * 0.95 * Math.cos(th)]));
        }
        wire(extraFor(zone), path, { radius: r, closed: true, sides: 8 });
      }
    }
  }

  // The hidden stone: set inside the band, just past the end of the engraving.
  if (o.innerStone && o.innerStone !== 'none' && GEMS[o.innerStone]) {
    const size = clamp(w * 0.32, 1, 1.6);
    const text = String(o.engraving ?? '').trim();
    const charMm = w * 0.5 * ENGRAVING_SIZES[o.engravingSize ?? 'medium'].k * 0.58;
    const phi = Math.PI + (Number(o.engravingAngle) || 0) * DEG - (text ? (text.length * charMm) / 2 + size + 0.8 : 0) / R;
    const inward = [-Math.sin(phi), -Math.cos(phi), 0];
    const p = place(phi, 0, profileInner(loop, 0), false);
    const x = vec.unit(vec.cross(inward, [0, 0, 1]));
    const c = cut('round-accent');
    const z = vec.cross(x, inward);
    const key = `round-accent|${o.innerStone}`;
    if (!groups.has(key)) groups.set(key, { cut: 'round-accent', gem: o.innerStone, role: 'accent', matrices: [] });
    groups.get(key).matrices.push(matrix(x, inward, z, size, vec.sub(p, vec.scale(inward, c.top * size * 0.85))));
    const ring = [];
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * 2 * Math.PI;
      ring.push(vec.add(p, vec.add(vec.scale(x, Math.cos(a) * size * 0.53), vec.scale(z, Math.sin(a) * size * 0.53))));
    }
    wire(extraFor('lining'), ring, { radius: size * 0.06, closed: true, sides: 6 });
  }

  // ── Volumes and weights (Pappus: area × path of its centroid) ──
  const volumes = new Map();
  const addVolume = (zone, v) => volumes.set(zone, (volumes.get(zone) ?? 0) + v);
  const steps = 180;
  for (let i = 0; i < steps; i++) {
    const phi = ((i + 0.5) / steps) * 2 * Math.PI;
    const k = shapeFactor(o.shape, phi, R, t);
    const tt = t * (0.5 + 0.5 * k);    // average thickness scale across the profile at this angle
    const width = o.shape === 'wavy' ? hw * (1 + 0.05 * Math.sin(7 * phi)) : hw;
    const dphi = (2 * Math.PI) / steps;
    if (o.lining) {
      // A layer 0.35 mm thick on the inside in the lining metal, the rest in the sections.
      const all = areaOf(loop, width, tt);
      const lining = all.area * Math.min(0.35 / tt, 0.5) * 1.05;
      addVolume('lining', lining * R * dphi);
      for (const [lo, hi, zone] of zones) {
        const { area, centroid } = areaOf(clipS(loop, lo, hi), width, tt);
        addVolume(zone, area * (1 - lining / all.area) * (R + centroid) * dphi);
      }
    } else {
      for (const [lo, hi, zone] of zones) {
        const { area, centroid } = areaOf(clipS(loop, lo, hi), width, tt);
        addVolume(zone, area * (R + centroid) * dphi);
      }
    }
  }
  for (const [zone, m] of extras) addVolume(zone, m.volume);
  // Metal cut away: the channel's groove and the tension slot.
  if (groove) addVolume(zoneAt(s0), -(row.size + 0.04) * groove.depth * Rt * row.cover);
  if (slot) addVolume(zoneAt(s0), -(2 * slot.half) * slot.depth * w * 0.9);

  const metalOfZone = (zone) => (zone === 'lining' ? o.liningMetal : sectionMetal(zone));
  // One line per metal, in order across the band.
  const byMetal = new Map();
  for (const zone of [...zones.map((z) => z[2]), 'lining']) {
    if (!volumes.has(zone)) continue;
    byMetal.set(metalOfZone(zone), (byMetal.get(metalOfZone(zone)) ?? 0) + Math.max(0, volumes.get(zone)));
  }
  const metalSpecs = [...byMetal].map(([metal, v]) => ({ metal, label: metalLabel(metal, o.karat), grams: round(gramsOf(v, metal, o.karat)) }));
  const stoneList = [...groups.values()];
  const stoneCount = stoneList.reduce((s, g) => s + g.matrices.length, 0);
  const stoneCarats = stoneList.reduce((s, g) => s + g.matrices.reduce((c, m) => c + caratsOf(g.cut, Math.hypot(m[0], m[1], m[2]), GEMS[g.gem]?.density ?? GEMS.diamond.density), 0), 0);
  const finishes = zones.map(([, , zone]) => sectionFinish(zone));

  // Parts for the stage: each surface with its metal and finish.
  const parts = [];
  // The surface's size in mm (round the band, across it), so finish textures keep real scale.
  const uvSize = [2 * Math.PI * Rt, w];
  for (const [key, m] of meshes) {
    const [kind, zoneKey] = key.split(':');
    const zone = zoneKey === 'lining' ? 'lining' : Number(zoneKey);
    const inner = kind === 'inner';
    // The side walls are polished, as on a real band; the inside unless asked otherwise.
    const polished = kind === 'wall' || (inner && (o.insidePolished || o.lining));
    parts.push({
      geometry: m.finish(),
      metal: metalOfZone(zone),
      finish: polished ? 'polished' : inner ? sectionFinish(0) : sectionFinish(zone),
      inner, uvSize,
    });
  }
  for (const [zone, m] of extras) if (m.count) parts.push({ geometry: m.finish(), metal: metalOfZone(zone), finish: 'polished' });

  const decorLines = { centre: 1, double: 2, triple: 3 }[o.grooves] ?? 0;
  return {
    options: { ...o, width: w, thickness: t },
    parts,
    stones: stoneList,
    specs: {
      width: round(w), thickness: round(t), size: o.size, profile: o.profile, shape: o.shape,
      metals: metalSpecs, grams: round(metalSpecs.reduce((s, m) => s + m.grams, 0)), karat: o.karat,
      sections: o.sections, finishes, edge: o.edge,
      grooves: decorLines + (o.join === 'groove' || o.join === 'line' ? seams.length : 0),
      stones: { count: stoneCount, carats: round(stoneCarats), gem: o.stoneColour },
      beads: beadCount,
      engraving: String(o.engraving ?? '').trim(), innerStone: o.innerStone,
    },
    frame: { floor: -Rt, radius: Rt, inner: R, width: w, shadowReach: 0.4 },
    profileOutline: loop.map(([s, q]) => [s * hw, q * t]),
  };
}

/** Height of the inner surface (normalised, ≤ 0) at s. */
function profileInner(loop, sv) {
  const inner = loop.filter((p) => p[2] === 'inner');
  let best = inner[0];
  for (const p of inner) if (Math.abs(p[0] - sv) < Math.abs(best[0] - sv)) best = p;
  return best[1];
}

/** Flips all surfaces if the outermost point's normal faces the finger. */
function orientAll(meshes) {
  let best = -1, bestM = null, bestK = 0;
  for (const m of meshes) for (let k = 0; k < m.count; k++) {
    const r = Math.hypot(m.p[k * 3], m.p[k * 3 + 1]);
    if (r > best) { best = r; bestM = m; bestK = k; }
  }
  if (!bestM) return;
  const p = [bestM.p[bestK * 3], bestM.p[bestK * 3 + 1], 0];
  const n = [bestM.n[bestK * 3], bestM.n[bestK * 3 + 1], bestM.n[bestK * 3 + 2]];
  if (vec.dot(n, vec.unit(p)) >= 0) return;
  for (const m of meshes) {
    for (let k = 0; k < m.i.length; k += 3) { const tmp = m.i[k + 1]; m.i[k + 1] = m.i[k + 2]; m.i[k + 2] = tmp; }
    for (let k = 0; k < m.n.length; k++) m.n[k] = -m.n[k];
  }
}

/**
 * A pair of bands placed side by side, standing, as in a product photo: her ring in front and
 * to the left, his behind and to the right. Returns each ring's world matrix.
 */
export function pairLayout(her, his) {
  const rot = (ay, az, p) => {
    const cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    // Rz then Ry (column-major).
    const m = [cy * cz, sz, -sy * cz, 0, -cy * sz, cz, sy * sz, 0, sy, 0, cy, 0, p[0], p[1], p[2], 1];
    return m;
  };
  const hisR = his.frame.radius, herR = her.frame.radius;
  return {
    his: rot(-38 * DEG, 0, [hisR * 0.62, hisR, -hisR * 0.35]),
    her: rot(28 * DEG, 5 * DEG, [-herR * 0.78, herR, herR * 0.55]),
  };
}
