import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module without type declarations
import { cut, caratsOf, widthForCarats, solidFromPlanes, SHAPES, SIDE_SHAPES } from '../configurator/engine/cuts.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { buildRing, HEADS, SHANKS } from '../configurator/engine/ring.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { buildBand, bandOptions, scatterLayout, PROFILES, BAND_SHAPES, ARRANGEMENTS, SET_STYLES, SPANS, EDGES, JOINS, SCATTER_PATTERNS, autoThickness } from '../configurator/engine/band.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { Mesh, band } from '../configurator/engine/geometry.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { priceRing, priceBand, centreFromList } from '../configurator/engine/pricing.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { usToDiameter, euToDiameter } from '../configurator/engine/materials.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { restingPose, samplePoints, posed } from '../configurator/engine/pose.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { shapeOfName } from '../configurator/engine/cad.mjs';

type Geometry = { positions: Float32Array; normals: Float32Array; index: Uint16Array | Uint32Array };

const allFinite = (a: ArrayLike<number>) => Array.prototype.every.call(a, Number.isFinite);

describe('gem cuts', () => {
  it('make closed convex solids whose corners lie inside every facet plane', () => {
    for (const key of [...Object.keys(SHAPES), 'round-accent', 'princess-accent']) {
      const c = cut(key);
      expect(c.volume, key).toBeGreaterThan(0);
      for (let i = 0; i < c.positions.length; i += 3) {
        for (let k = 0; k < c.planeCount; k++) {
          const d = c.planes[k * 4] * c.positions[i] + c.planes[k * 4 + 1] * c.positions[i + 1] + c.planes[k * 4 + 2] * c.positions[i + 2] - c.planes[k * 4 + 3];
          expect(d, key).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('weigh what real stones of that size weigh', () => {
    // A 1 ct round brilliant is about 6.4–6.5 mm across.
    expect(widthForCarats('round', 1)).toBeGreaterThan(6.3);
    expect(widthForCarats('round', 1)).toBeLessThan(6.6);
    expect(caratsOf('round', 6.5)).toBeCloseTo(1.05, 1);
    // A 1 ct oval is about 7.7 × 5.7 mm; an emerald cut about 7 × 5 mm.
    const oval = widthForCarats('oval', 1);
    expect(oval * cut('oval').ratio).toBeGreaterThan(7.4);
    expect(oval * cut('oval').ratio).toBeLessThan(8.1);
    const em = widthForCarats('emerald', 1);
    expect(em).toBeGreaterThan(4.8);
    expect(em).toBeLessThan(5.4);
  });

  it('have an excellent brilliant’s depth (about 60% of the width)', () => {
    for (const key of ['round', 'oval', 'cushion', 'pear', 'marquise']) {
      const c = cut(key);
      expect(c.top - c.bottom, key).toBeGreaterThan(0.57);
      expect(c.top - c.bottom, key).toBeLessThan(0.65);
    }
  });

  it('keep accent stones cheap to trace', () => {
    expect(cut('round-accent').planeCount).toBeLessThanOrEqual(40);
    expect(cut('round').planeCount).toBeLessThanOrEqual(128);
  });

  it('turn half-spaces into a cube', () => {
    const planes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((n) => ({ n, d: 1 }));
    const solid = solidFromPlanes(planes);
    expect(solid.corners).toHaveLength(8);
    expect(solid.facets).toHaveLength(6);
  });
});

describe('ring builder', () => {
  it('sets halo stones tight round the centre stone', () => {
    const r = buildRing({ head: 'halo', shank: 'classic' });
    const centre = r.stones.find((s: { role: string }) => s.role === 'centre').matrices[0];
    const width = Math.hypot(centre[0], centre[1], centre[2]);
    const halo = r.stones.find((s: { role: string }) => s.role === 'accent').matrices as number[][];
    for (const m of halo) {
      const d = Math.hypot(m[0], m[1], m[2]);
      // Gap between the centre stone's girdle and the halo stone's edge, in mm.
      const gap = Math.hypot(m[12], m[14]) - width / 2 - d / 2;
      expect(gap).toBeLessThan(0.25);
      expect(gap).toBeGreaterThan(-0.05);
    }
  });

  it('sets channel stones below the top of their rails', () => {
    const r = buildRing({ shank: 'channel', head: 'four-prong' });
    const ch = r.stones.find((s: { cut: string }) => s.cut === 'princess-accent').matrices as number[][];
    const R = usToDiameter(6) / 2;
    const [tBottom, tTop] = SHANKS.channel.t;
    for (const m of ch) {
      const d = Math.hypot(m[0], m[1], m[2]);
      const table = Math.hypot(m[12], m[13]) + 0.127 * d;
      // The shank's outer surface there (its thickness tapers from bottom to top).
      const phi = Math.atan2(Math.abs(m[12]), m[13]);
      const surface = R + tBottom + (tTop - tBottom) * (1 + Math.cos(phi)) / 2;
      expect(table).toBeLessThan(surface);
      expect(table).toBeGreaterThan(surface - 0.2);
    }
  });

  it('builds every head on every shank', () => {
    for (const head of Object.keys(HEADS)) {
      for (const shank of Object.keys(SHANKS)) {
        const r = buildRing({ head, shank });
        for (const part of [r.metal.head, r.metal.shank] as Geometry[]) {
          expect(part.index.length, `${head}/${shank}`).toBeGreaterThan(0);
          expect(allFinite(part.positions) && allFinite(part.normals), `${head}/${shank}`).toBe(true);
        }
        expect(r.specs.metal.grams, `${head}/${shank}`).toBeGreaterThan(1.2);
        expect(r.specs.metal.grams, `${head}/${shank}`).toBeLessThan(7);
      }
    }
  }, 30_000);

  it('sets the centre stone clear of the band', () => {
    for (const shape of Object.keys(SHAPES)) {
      for (const head of Object.keys(HEADS)) {
        const r = buildRing({ shape, head, carat: 2 });
        const m = r.stones.find((s: { role: string }) => s.role === 'centre').matrices[0];
        const width = Math.hypot(m[0], m[1], m[2]);
        const culet = m[13] + cut(shape).bottom * width;
        expect(culet, `${shape}/${head}`).toBeGreaterThan(r.frame.radius + 0.5);
      }
    }
  });

  it('sizes the stone from its carat and the band from the ring size', () => {
    const small = buildRing({ carat: 0.5 }), big = buildRing({ carat: 3 });
    expect(big.specs.centre.mm[1]).toBeGreaterThan(small.specs.centre.mm[1] * 1.6);
    const size4 = buildRing({ size: 4 }), size9 = buildRing({ size: 9 });
    expect(size9.frame.radius - size4.frame.radius).toBeCloseTo((usToDiameter(9) - usToDiameter(4)) / 2, 1);
  });

  it('sets side stones beside the centre in a three-stone head', () => {
    const r = buildRing({ head: 'three-stone', shank: 'classic', carat: 1 });
    const side = r.stones.find((s: { cut: string; role: string; matrices: number[][] }) => s.cut === 'round' && s.matrices.length === 2);
    expect(side).toBeTruthy();
    const halfWidth = r.specs.centre.mm[1] / 2;
    for (const m of side.matrices) {
      const ds = Math.hypot(m[0], m[1], m[2]);
      const [x, y] = [m[12], m[13]];
      // Close beside the centre stone: the side girdle starts just past the centre's.
      // The stone's length runs along the band: its z axis (towards the centre) lies in x-y.
      const inner = Math.abs(x) - Math.abs(m[8]) / 2;
      expect(inner - halfWidth).toBeGreaterThan(0);
      expect(inner - halfWidth).toBeLessThan(1);
      // Lower than the centre, leaning outwards with the band.
      expect(y).toBeLessThan(r.frame.head[1]);
      expect(Math.sign(m[4])).toBe(Math.sign(x));
      // Resting on the band: its culet a little above the band's top, not floating.
      const up = [m[4] / ds, m[5] / ds];
      const culet = [x + up[0] * cut('round').bottom * ds, y + up[1] * cut('round').bottom * ds];
      const above = Math.hypot(culet[0], culet[1]) - r.frame.radius;
      expect(above).toBeGreaterThan(0.2);
      expect(above).toBeLessThan(1.3);
    }
    // Side stones about a quarter of the centre's weight each (the default round sides).
    expect(r.specs.accents.carats).toBeGreaterThan(0.3);
    expect(r.specs.accents.carats).toBeLessThan(0.7);
  });

  it('offers every side stone shape, at a chosen size and angle, beside the centre', () => {
    for (const sideShape of Object.keys(SIDE_SHAPES)) for (const shank of ['classic', 'cathedral']) {
      const r = buildRing({ head: 'three-stone', shank, shape: 'oval', carat: 1.5, sideShape });
      for (const part of [r.metal.head, r.metal.shank] as Geometry[]) expect(allFinite(part.positions) && allFinite(part.normals), sideShape).toBe(true);
      const side = r.stones.find((s: { role: string; cut: string }) => s.cut === sideShape && s.role === 'centre' && sideShape !== 'oval') ?? r.stones.filter((s: { cut: string }) => s.cut === sideShape)[1];
      expect(side?.matrices.length, sideShape).toBe(2);
      expect(r.specs.sides.shape).toBe(sideShape);
    }
    const tb = buildRing({ head: 'three-stone', shape: 'round', carat: 4, sideShape: 'tapered-baguette', sideSize: 3, sideAngle: 25 });
    // A 5 × 3 tapered baguette, as on a jeweller's drawing, leaning 25°.
    expect(tb.specs.sides).toMatchObject({ width: 3, angle: 25 });
    expect(tb.specs.sides.length).toBeCloseTo(5, 0);
    // Its length runs along the band (x), its width along the finger (z).
    const m = tb.stones.find((s: { cut: string }) => s.cut === 'tapered-baguette').matrices[0];
    expect(Math.hypot(m[8], m[9])).toBeGreaterThan(Math.abs(m[10]) + 1);
    expect(Math.abs(m[2])).toBeGreaterThan(Math.abs(m[0]) + 1);
    expect(buildRing({ head: 'three-stone', sideAngle: 0 }).specs.sides.angle).toBe(0);
  });

  it('counts accent stones and their carats', () => {
    const plain = buildRing({ shank: 'classic', head: 'four-prong' });
    expect(plain.specs.accents.count).toBe(0);
    const pave = buildRing({ shank: 'pave', head: 'halo' });
    // A 1 ct round halo holds about 16–20 small stones; the pavé band about 22.
    expect(pave.specs.accents.count).toBeGreaterThan(30);
    // Pavé melee of about 1.2 mm weighs about 0.007 ct each.
    expect(pave.specs.accents.carats / pave.specs.accents.count).toBeGreaterThan(0.004);
    expect(pave.specs.accents.carats / pave.specs.accents.count).toBeLessThan(0.02);
  });

  it('weighs coloured stones by their own density', () => {
    const diamond = buildRing({ gem: 'diamond', carat: 1 }), ruby = buildRing({ gem: 'ruby', carat: 1 });
    expect(ruby.specs.centre.carats).toBeGreaterThan(diamond.specs.centre.carats);
  });
});

describe('band builder', () => {
  const finite = (b: { parts: { geometry: Geometry }[] }) => b.parts.every((p) => allFinite(p.geometry.positions) && allFinite(p.geometry.normals));

  it('builds every profile, shape, section count, join, edge and stone arrangement', () => {
    for (const profile of Object.keys(PROFILES)) for (const shape of Object.keys(BAND_SHAPES)) {
      const b = buildBand({ profile, shape });
      expect(b.parts.length).toBeGreaterThan(0);
      expect(finite(b)).toBe(true);
    }
    for (const sections of [1, 2, 3, 4, 5]) for (const join of Object.keys(JOINS)) {
      const b = buildBand({ sections, join, metal: 'yellow', metal2: 'white', metal3: 'rose', metal4: 'white', metal5: 'yellow' });
      expect(finite(b)).toBe(true);
      expect(b.specs.metals.length).toBe(Math.min(sections, 3));
    }
    for (const edge of Object.keys(EDGES)) for (const edgeSide of ['both', 'left', 'right']) expect(finite(buildBand({ edge, edgeSide }))).toBe(true);
    for (const arrangement of Object.keys(ARRANGEMENTS)) for (const setStyle of Object.keys(SET_STYLES)) {
      const b = buildBand({ arrangement, setStyle, width: 6 });
      expect(finite(b)).toBe(true);
      if (arrangement === 'none') expect(b.specs.stones.count).toBe(0);
      else expect(b.specs.stones.count).toBeGreaterThan(0);
    }
  }, 60_000);

  it('reads older shared designs: layouts and diamond settings', () => {
    expect(bandOptions({ layout: 'stripe', metal: 'yellow', metal2: 'white' })).toMatchObject({ sections: 3, metal: 'yellow', metal2: 'white', metal3: 'yellow' });
    expect(bandOptions({ layout: 'edges', metal: 'yellow', metal2: 'white' })).toMatchObject({ sections: 3, metal: 'white', metal2: 'yellow', metal3: 'white' });
    expect(bandOptions({ layout: 'inside', metal2: 'rose' })).toMatchObject({ sections: 1, lining: true, liningMetal: 'rose' });
    expect(bandOptions({ setting: 'channel-full' })).toMatchObject({ arrangement: 'along', setStyle: 'channel', span: 'full' });
    expect(buildBand({ setting: 'pave-half' }).specs.stones.count).toBeGreaterThan(5);
  });

  it('sets more stones the further round a row goes, and fewer the wider apart', () => {
    const count = (o: object) => buildBand({ arrangement: 'along', setStyle: 'pave', stoneSize: 1.2, ...o }).specs.stones.count;
    const spans = Object.keys(SPANS).map((span) => count({ span }));
    for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeGreaterThan(spans[i - 1]);
    expect(count({ span: 'half', spacing: 'touching' })).toBeGreaterThan(count({ span: 'half', spacing: 'wide' }) * 2);
  });

  it('keeps scattered stones on the band and apart from each other', () => {
    for (const pattern of Object.keys(SCATTER_PATTERNS)) {
      const pts = scatterLayout(pattern, 9, 1.4, 5, 16);
      expect(pts.length).toBeGreaterThan(2);
      for (const a of pts) {
        expect(Math.abs(a.y) + a.r).toBeLessThanOrEqual(2.5);
        for (const b of pts) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
    }
    const beads = buildBand({ arrangement: 'scatter', scatterType: 'beads', scatterRepeat: 2 }).specs;
    expect(beads.beads).toBeGreaterThan(0);
  });

  it('lines the inside in another metal and hides a stone there', () => {
    const b = buildBand({ lining: true, liningMetal: 'white', metal: 'yellow', innerStone: 'ruby', engraving: 'Always' });
    expect(b.specs.metals.map((m: { metal: string }) => m.metal)).toEqual(['yellow', 'white']);
    const inner = b.parts.find((p: { inner: boolean }) => p.inner);
    expect(inner.metal).toBe('white');
    const ruby = b.stones.find((g: { gem: string }) => g.gem === 'ruby');
    expect(ruby.matrices.length).toBe(1);
    // Inside the band: closer to the finger than the outer surface.
    const m = ruby.matrices[0];
    expect(Math.hypot(m[12], m[13])).toBeLessThan(b.frame.inner + 0.5);
  });

  it('weighs like a real band and shares the weight between two metals', () => {
    // A 4 mm, 1.7 mm thick 14k band in a mid size weighs about 4–6 g.
    const single = buildBand({ sections: 1, width: 4, size: 54 });
    expect(single.specs.grams).toBeGreaterThan(3.5);
    expect(single.specs.grams).toBeLessThan(7);
    const split = buildBand({ sections: 2, metal: 'yellow', metal2: 'yellow', width: 4, size: 54 });
    expect(split.specs.grams).toBeCloseTo(single.specs.grams, 0);
    expect(buildBand({ width: 7 }).specs.grams).toBeGreaterThan(buildBand({ width: 4 }).specs.grams * 1.6);
    expect(buildBand({ metal: 'platinum' }).specs.grams).toBeGreaterThan(buildBand({ metal: 'yellow' }).specs.grams * 1.4);
  });

  it('matches thickness to width when asked', () => {
    expect(buildBand({ width: 6, autoThickness: true }).specs.thickness).toBe(autoThickness(6));
    expect(buildBand({ width: 6, autoThickness: false, thickness: 2.8 }).specs.thickness).toBe(2.8);
  });

  it('faces its outer surface away from the finger', () => {
    const b = buildBand({ sections: 1 });
    const outer = b.parts.find((p: { inner: boolean }) => !p.inner).geometry as Geometry;
    let best = 0, bestN = 0;
    for (let k = 0; k < outer.positions.length; k += 3) {
      const r = Math.hypot(outer.positions[k], outer.positions[k + 1]);
      if (r > best) { best = r; bestN = (outer.normals[k] * outer.positions[k] + outer.normals[k + 1] * outer.positions[k + 1]) / r; }
    }
    expect(bestN).toBeGreaterThan(0.5);
    expect(best).toBeGreaterThan(euToDiameter(52) / 2);
  });
});

describe('poses for photos and the 360° video', () => {
  const asDesign = (r: ReturnType<typeof buildRing>) => ({
    groups: [{ parts: [{ geometry: r.metal.shank }, { geometry: r.metal.head }], stones: r.stones }],
    frame: r.frame,
  });

  it('lays a ring on its side, resting on both its band and its head', () => {
    for (const head of ['four-prong', 'halo', 'three-stone']) {
      const ring = buildRing({ head, shank: 'pave' });
      const design = asDesign(ring);
      const lying = posed(design, restingPose(design, ring.frame.radius + 0.3));
      const pts = samplePoints(lying) as number[][];
      const lowest = Math.min(...pts.map((p) => p[1]));
      expect(lowest, head).toBeCloseTo(0, 3);
      // The finger axis now stands almost upright (tipped only as far as the head needs).
      const m = lying.groups[0].matrix;
      expect(Math.abs(m[9]), head).toBeGreaterThan(0.7);
      // Head and band both touch the table: the lowest head point is as low as the band's.
      const upright = samplePoints(design) as number[][];
      const headLow = Math.min(...pts.filter((_, i) => upright[i][1] > ring.frame.radius + 0.3).map((p) => p[1]));
      expect(headLow, head).toBeLessThan(0.05);
    }
  });
});

describe('CAD rings', () => {
  it('knows a stone block’s shape from its name', () => {
    expect(shapeOfName('Diamond_Oval')).toBe('oval');
    expect(shapeOfName('Diamond_Cushion')).toBe('cushion');
    expect(shapeOfName('Radiant 7x5')).toBe('cushion');
    expect(shapeOfName('Block 12')).toBeNull();
  });
});

describe('geometry', () => {
  it('measures a swept band’s volume as area × path of its centroid', () => {
    const m = new Mesh();
    // A 2 × 4 mm rectangle swept round a 9 mm radius: 8 mm² × 2π × 10 mm.
    const rect = [[0, -2], [2, -2], [2, 2], [0, 2]];
    band(m, { r: 9, segments: 512, profile: () => rect, sharp: [0, 1, 2, 3] });
    expect(m.volume).toBeCloseTo(8 * 2 * Math.PI * 10, -1);
  });
});

describe('pricing', () => {
  it('adds up its lines and follows the design', () => {
    const ring = buildRing({});
    const p = priceRing({ ...ring.specs, karat: '14k' });
    expect(p.total).toBe(p.lines.reduce((s: number, l: { amount: number }) => s + l.amount, 0));
    const bigger = priceRing({ ...buildRing({ carat: 2 }).specs, karat: '14k' });
    expect(bigger.total).toBeGreaterThan(p.total);
    expect(centreFromList('diamond', 2)).toBeGreaterThan(2 * centreFromList('diamond', 1));
    const band = priceBand(buildBand({ engraving: 'Always' }).specs);
    expect(band.lines.some((l: { key: string }) => l.key === 'engraving')).toBe(true);
  });
});
