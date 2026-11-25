/**
 * The wedding band builder's design engine. A band is a cross-section (profile) swept round the
 * finger: width, thickness, outer shape, one or two metals laid out across it, a finish for each
 * metal, grooves, diamonds and an engraving inside. Everything is in millimetres, and metal
 * weights come from the cross-section's area (Pappus' theorem), so the price follows the design.
 *
 * Axes as in geometry.mjs: finger along z, band in the x-y plane, φ measured from the top.
 */
import { cut, caratsOf } from './cuts.mjs';
import { Mesh, grid, bead, wire, matrix, vec } from './geometry.mjs';
import { GEMS, gramsOf, metalLabel, euToDiameter } from './materials.mjs';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const DEG = Math.PI / 180;

export const PROFILES = {
  'flat-court': { label: 'Flat court' },
  round: { label: 'Round' },
  cushion: { label: 'Cushion' },
  dome: { label: 'Dome' },
  'knife-edge': { label: 'Knife-edge' },
  beveled: { label: 'Beveled' },
  comfort: { label: 'Comfort' },
  flat: { label: 'Flat' },
};

export const BAND_SHAPES = {
  classic: { label: 'Classic' },
  wave: { label: 'Wave' },
  oval: { label: 'Oval' },
  cushion: { label: 'Cushion' },
  hexagon: { label: 'Hexagon' },
  octagon: { label: 'Octagon' },
  wavy: { label: 'Wavy' },
};

// Two metals: where the second goes across the band.
export const LAYOUTS = {
  single: { label: 'One metal' },
  split: { label: 'Half and half' },
  stripe: { label: 'Centre stripe' },
  edges: { label: 'Edges' },
  inside: { label: 'Inside' },
};

export const GROOVES = { none: { label: 'None' }, centre: { label: 'Centre' }, double: { label: 'Two' }, seams: { label: 'At the seams' } };

export const SETTINGS = {
  none: { label: 'No diamonds' },
  solitaire: { label: 'Solitaire' },
  three: { label: 'Three stones' },
  'channel-half': { label: 'Channel, half way' },
  'channel-full': { label: 'Channel, all round' },
  'pave-half': { label: 'Pavé line, half way' },
  'pave-full': { label: 'Pavé line, all round' },
};

export const WIDTH_NAMES = [[0, 'Thin'], [2.8, 'Slim'], [3.6, 'Regular'], [5.5, 'Wide'], [7.5, 'Bold']];
export const widthName = (w) => WIDTH_NAMES.filter(([min]) => w >= min).pop()[1];
/** Thickness that suits a width ("auto-match thickness to width"). */
export const autoThickness = (w) => round(clamp(1.25 + 0.12 * w, 1.4, 2.4), 2);

export const EU_SIZES = Array.from({ length: 27 }, (_, i) => 44 + i);

export const DEFAULT_BAND = {
  profile: 'cushion', width: 4, thickness: autoThickness(4), autoThickness: true, shape: 'classic', size: 52,
  metal: 'yellow', metal2: 'white', karat: '14k', layout: 'single', finish: 'polished', finish2: 'satin',
  grooves: 'none', setting: 'none', stoneSize: 1.5, stonePosition: 0, engraving: '', font: 'serif',
};

// ─── Cross-section ──────────────────────────────────────────────────────────

/**
 * The profile as a closed loop in normalised coordinates: s across the band (−1 to 1), q
 * outwards (0 inner surface, 1 outer surface at its highest). Each point carries which surface
 * it is on (inner, outer, side) so that metals and finishes can be assigned per surface.
 */
function profileLoop(kind, grooves, seams) {
  const N = 72;
  const outer = [], inner = [];
  // Outer surface, s from −1 to 1.
  const top = (s) => {
    const a = Math.abs(s);
    switch (kind) {
      case 'flat': return a < 0.92 ? 1 : 1 - (a - 0.92) * 1.2;
      case 'flat-court': return a < 0.6 ? 1 : 1 - 0.32 * ((a - 0.6) / 0.4) ** 2.2;
      case 'round': return 0.18 + 0.82 * Math.sqrt(Math.max(1 - a * a, 0));
      case 'cushion': return 0.12 + 0.88 * (1 - a ** 4) ** 0.25;
      case 'dome': return 0.32 + 0.68 * Math.sqrt(Math.max(1 - a * a, 0));
      case 'knife-edge': return 0.3 + 0.7 * (1 - a) ** 0.9;
      case 'beveled': return a < 0.55 ? 1 : 1 - (a - 0.55) * 1.3;
      case 'comfort': return 0.2 + 0.8 * (1 - a ** 2.4) ** (1 / 2.4);
      default: return 1;
    }
  };
  const groove = (s) => {
    const at = grooves === 'centre' ? [0] : grooves === 'double' ? [-0.34, 0.34] : grooves === 'seams' ? seams : [];
    let d = 0;
    for (const g of at) d = Math.max(d, 0.13 * Math.max(0, 1 - Math.abs(s - g) / 0.07));
    return d;
  };
  for (let i = 0; i <= N; i++) {
    const s = -1 + (2 * i) / N;
    outer.push([s, Math.max(top(s) - groove(s), 0.05), 'outer']);
  }
  // Inner surface (comfort fit for court-type profiles), s from 1 back to −1.
  const comfort = kind === 'comfort' || kind === 'flat-court' || kind === 'cushion' ? 0.14 : 0.04;
  for (let i = 0; i <= N; i++) {
    const s = 1 - (2 * i) / N;
    inner.push([s, -comfort * (1 - s * s), 'inner']);
  }
  return [...outer, ...inner];
}

/** A profile's cross-section in mm (closed loop of [across, outwards]), for previews. */
export function profilePoints(kind, width = 4, thickness = autoThickness(width), grooves = 'none') {
  return profileLoop(kind, grooves, [0]).map(([s, q]) => [s * width / 2, q * thickness]);
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
    case 'cushion': {
      const p = 4.5;
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

// ─── Band ───────────────────────────────────────────────────────────────────

/**
 * Builds one band. Returns surfaces grouped by metal and finish (parts), stone placements,
 * specs (grams per metal, stones, carats) and the engraving's place on the inner surface.
 */
export function buildBand(input = {}) {
  const o = { ...DEFAULT_BAND, ...input };
  const R = euToDiameter(o.size) / 2;
  const w = clamp(o.width, 2, 10);
  const t = o.autoThickness ? autoThickness(w) : clamp(o.thickness, 1.2, 3);
  const hw = w / 2;

  // Where the second metal goes, as ranges of s.
  const zones = {
    single: [[-1, 1, 1]],
    split: [[-1, 0, 1], [0, 1, 2]],
    stripe: [[-1, -0.34, 1], [-0.34, 0.34, 2], [0.34, 1, 1]],
    edges: [[-1, -0.66, 2], [-0.66, 0.66, 1], [0.66, 1, 2]],
    inside: [[-1, 1, 1]],
  }[o.layout] ?? [[-1, 1, 1]];
  const seams = zones.slice(1).map((z) => z[0]);
  const loop = profileLoop(o.profile, o.grooves, seams);

  // φ-dependent placement: wave shapes move the band along the finger; wavy ones change width.
  const segments = o.shape === 'wavy' || o.shape === 'wave' ? 384 : o.shape === 'classic' ? 256 : 320;
  const place = (phi, s, q) => {
    let v = s * hw, k = shapeFactor(o.shape, phi, R, t);
    if (o.shape === 'wave') v += 0.32 * w * Math.sin(2 * phi);
    if (o.shape === 'wavy') v = s * hw * (1 + 0.16 * Math.sin(9 * phi)) + 0.12 * w * Math.sin(9 * phi);
    // The outer surface follows the shape; the inside stays round.
    const u = q >= 0 ? q * t * (1 + (k - 1) * clamp(q / 0.3, 0, 1)) : q * t;
    const r = R + u;
    return [r * Math.sin(phi), r * Math.cos(phi), v];
  };

  // Surfaces: the outer surface split at the metal seams, the two side walls, and the inside.
  // Each becomes a run of the profile with hard edges where runs meet.
  const zoneAt = (sv) => zones.find(([lo, hi]) => sv >= lo - 1e-9 && sv <= hi + 1e-9)?.[2] ?? 1;
  const outerPts = [], innerPts = loop.filter((p) => p[2] === 'inner');
  const outerLoop = loop.filter((p) => p[2] === 'outer');
  for (let i = 0; i < outerLoop.length; i++) {
    const a = outerLoop[i], b = outerLoop[i + 1];
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
  runs.push({ key: o.layout === 'inside' ? 'inner:2' : 'inner:1', points: innerPts });
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

  // ── Diamonds ──
  const stones = [];
  const extra = new Mesh();
  let stoneCut = 'round-accent';
  const d = clamp(o.stoneSize, 1, 3);
  if (o.setting !== 'none') {
    const s0 = clamp(o.stonePosition, -0.6, 0.6) * Math.max(0, 1 - (d + 0.6) / w);
    const surfQ = (s) => {
      let best = 0;
      for (let i = 0; i < loop.length; i++) if (loop[i][2] === 'outer' && Math.abs(loop[i][0] - s) < 0.03) best = Math.max(best, loop[i][1]);
      return best || 1;
    };
    const q = surfQ(s0);
    const at = (phi) => {
      const k = shapeFactor(o.shape, phi, R, t);
      const p = place(phi, s0, q);
      const radial = [Math.sin(phi), Math.cos(phi), 0];
      return { p: vec.sub(p, vec.scale(radial, 0.02)), radial, k };
    };
    const put = (phi, size, cutKey) => {
      const { p, radial } = at(phi);
      const x = vec.unit(vec.cross(radial, [0, 0, 1]));
      stones.push(matrix(x, radial, vec.cross(x, radial), size, vec.sub(p, vec.scale(radial, cut(cutKey).top * size * 0.4))));
    };
    if (o.setting === 'solitaire' || o.setting === 'three') {
      // Flush ("gypsy") set: sunk into the band with a polished rim round each stone.
      const list = o.setting === 'solitaire' ? [0] : [-(d + 0.6) / (R + t), 0, (d + 0.6) / (R + t)];
      for (const phi of list) {
        const size = o.setting === 'three' && phi !== 0 ? d * 0.8 : d;
        put(phi, size, 'round-accent');
        const { p, radial } = at(phi);
        const ring = [];
        const x = vec.unit(vec.cross(radial, [0, 0, 1]));
        const z = vec.cross(x, radial);
        for (let k = 0; k < 40; k++) {
          const a = (k / 40) * 2 * Math.PI;
          ring.push(vec.add(p, vec.add(vec.scale(x, Math.cos(a) * size * 0.53), vec.scale(z, Math.sin(a) * size * 0.53))));
        }
        wire(extra, ring, { radius: size * 0.07, closed: true, sides: 8 });
      }
    } else {
      const channel = o.setting.startsWith('channel');
      const full = o.setting.endsWith('full');
      stoneCut = channel ? 'princess-accent' : 'round-accent';
      const size = channel ? d : Math.min(d, 1.6);
      const pitch = channel ? size + 0.02 : size + 0.1;
      const arc = full ? 2 * Math.PI : Math.PI * 1.02;
      const count = Math.floor((arc * (R + t)) / pitch);
      const step = arc / count;
      const startPhi = full ? 0 : -arc / 2 + step / 2;
      for (let k = 0; k < count; k++) put(startPhi + k * step, size, stoneCut);
      if (channel) {
        // The channel's walls: low rails either side of the stones.
        for (const side of [-1, 1]) {
          const path = [];
          const steps = full ? 360 : 180;
          for (let i = 0; i <= (full ? steps - 1 : steps); i++) {
            const phi = full ? (i / steps) * 2 * Math.PI : -arc / 2 + (arc * i) / steps;
            const { p, radial } = at(phi);
            path.push(vec.add(vec.add(p, vec.scale(radial, 0.08)), [0, 0, side * (size / 2 + 0.12)]));
          }
          wire(extra, path, { radius: 0.16, sides: 8, closed: full, section: [1, 1.2] });
        }
      } else {
        // Beads between neighbours, on both sides of the line.
        for (let k = 0; k < (full ? count : count + 1); k++) {
          const phi = startPhi + (k - 0.5) * step;
          const { p, radial } = at(phi);
          for (const side of [-1, 1]) bead(extra, vec.add(vec.add(p, vec.scale(radial, 0.06)), [0, 0, side * (size / 2 + 0.04)]), size * 0.17, 6);
        }
      }
    }
  }

  // ── Volumes and weights (Pappus: area × path of its centroid) ──
  const volumes = { 1: 0, 2: 0 };
  const steps = 180;
  for (let i = 0; i < steps; i++) {
    const phi = ((i + 0.5) / steps) * 2 * Math.PI;
    const k = shapeFactor(o.shape, phi, R, t);
    const tt = t * (0.5 + 0.5 * k);    // average thickness scale across the profile at this angle
    const width = o.shape === 'wavy' ? hw * (1 + 0.16 * Math.sin(9 * phi)) : hw;
    if (o.layout === 'inside') {
      // A layer 0.35 mm thick on the inside in the second metal, the rest in the first.
      const all = areaOf(loop, width, tt);
      const layer = Math.min(0.35 / tt, 0.5);
      const lining = all.area * layer * 1.05;
      volumes[2] += lining * (R) * (2 * Math.PI / steps);
      volumes[1] += (all.area - lining) * (R + all.centroid) * (2 * Math.PI / steps);
    } else {
      for (const [lo, hi, metal] of zones) {
        const { area, centroid } = areaOf(clipS(loop, lo, hi), width, tt);
        volumes[metal] += area * (R + centroid) * ((2 * Math.PI) / steps);
      }
    }
  }
  volumes[1] += extra.volume;

  const metals = [{ zone: 1, metal: o.metal }];
  if (o.layout !== 'single') metals.push({ zone: 2, metal: o.metal2 });
  const metalSpecs = metals.map(({ zone, metal }) => ({ metal, label: metalLabel(metal, o.karat), grams: round(gramsOf(volumes[zone], metal, o.karat)) }));
  const stoneCarats = stones.reduce((s, m) => s + caratsOf(stoneCut, Math.hypot(m[0], m[1], m[2]), GEMS.diamond.density), 0);
  const finishes = o.layout === 'single' ? [o.finish] : [o.finish, o.finish2];

  // Parts for the stage: each surface with its metal and finish.
  const parts = [];
  // The surface's size in mm (round the band, across it), so finish textures keep real scale.
  const uvSize = [2 * Math.PI * (R + t), w];
  for (const [key, m] of meshes) {
    const zone = Number(key.split(':')[1]);
    const inner = key.startsWith('inner');
    // The inside and the side walls are polished, as on a real band.
    const polished = inner || key.startsWith('wall');
    parts.push({
      geometry: m.finish(),
      metal: zone === 2 ? o.metal2 : o.metal,
      finish: polished ? 'polished' : zone === 2 ? o.finish2 : o.finish,
      inner, uvSize,
    });
  }
  if (extra.count) parts.push({ geometry: extra.finish(), metal: o.metal, finish: 'polished' });

  return {
    options: { ...o, width: w, thickness: t },
    parts,
    stones: stones.length ? [{ cut: stoneCut, gem: 'diamond', role: 'accent', matrices: stones }] : [],
    specs: {
      width: round(w), thickness: round(t), size: o.size, profile: o.profile, shape: o.shape,
      metals: metalSpecs, grams: round(metalSpecs.reduce((s, m) => s + m.grams, 0)), karat: o.karat,
      finishes, grooves: o.grooves === 'none' ? 0 : o.grooves === 'double' ? 2 : o.grooves === 'centre' ? 1 : seams.length,
      stones: { count: stones.length, carats: round(stoneCarats) },
      engraving: o.engraving.trim(),
    },
    frame: { floor: -(R + t), radius: R + t, inner: R, width: w, shadowReach: 0.4 },
    profileOutline: loop.map(([s, q]) => [s * hw, q * t]),
  };
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
