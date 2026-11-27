/**
 * Rings and wedding bands designed in the 3D builders (apps/ring-lab/configurator), priced on the
 * server with the builders' own engine and price list, so the cart shows exactly the price the
 * shopper saw and nothing the browser sends about price is trusted.
 *
 * The engine is plain ES modules with no three.js (geometry, carats, grams and prices); the same
 * files are served to the browser by routes/builder.ts.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MetalType } from '@jewelry/db';

/** apps/ring-lab/configurator in this repository (and in the Docker image). */
export const DEFAULT_BUILDER_DIR = resolve(fileURLToPath(new URL('../../../ring-lab/configurator', import.meta.url)));

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine is untyped JavaScript */
interface Engine {
  ring: { buildRing(o: Record<string, unknown>): { specs: any }; DEFAULT_RING: Record<string, unknown>; HEADS: Record<string, { label: string }>; SHANKS: Record<string, { label: string }> };
  band: { buildBand(o: Record<string, unknown>): { specs: any }; DEFAULT_BAND: Record<string, unknown>; PROFILES?: Record<string, { label: string }> };
  pricing: { priceRing(specs: any): PriceBreakdown; priceBand(specs: any): PriceBreakdown };
}
interface PriceBreakdown { lines: { key: string; label: string; amount: number }[]; total: number; currency: string }

const engines = new Map<string, Promise<Engine>>();
function loadEngine(dir: string): Promise<Engine> {
  let e = engines.get(dir);
  if (!e) {
    const mod = (file: string) => import(pathToFileURL(join(dir, 'engine', file)).href);
    e = Promise.all([mod('ring.mjs'), mod('band.mjs'), mod('pricing.mjs')]).then(([ring, band, pricing]) => ({ ring, band, pricing }) as Engine);
    e.catch(() => engines.delete(dir));
    engines.set(dir, e);
  }
  return e;
}

export type DesignKind = 'ring' | 'band';

export interface PricedDesign {
  kind: DesignKind;
  /** The design as built: only the builder's own options, with their own types. */
  design: Record<string, string | number | boolean>;
  lines: PriceBreakdown['lines'];
  total: number;
  currency: string;
  title: string;
  sku: string;
  /** Shopper-visible line-item properties (what to make). */
  properties: Record<string, string>;
  ringSize: number | null;
  engraving: string | null;
  /** The metal as a stocked metal, when the piece is in one metal that is one. */
  metal: MetalType | null;
  /** Grams, carats and stone counts the workshop needs. */
  specs: Record<string, unknown>;
  hasStones: boolean;
  hasCentre: boolean;
}

export class InvalidDesign extends Error {}

const ENGRAVING = /^[\p{L}\p{N}\p{P}\p{Zs}♥+&]*$/u;

/** Only the builder's own options, each of the type its default has. */
function pick(input: unknown, defaults: Record<string, unknown>): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidDesign('design must be an object');
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(k in defaults)) continue;
    const want = typeof defaults[k];
    if (want === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (want === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
    else if (want === 'string' && typeof v === 'string' && v.length <= 80) out[k] = v;
    else if (want === 'boolean' && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function stockedMetal(metal: string, karat: string): MetalType | null {
  if (metal === 'platinum') return 'PLATINUM_950';
  const k = karat === '18k' ? '18K' : '14K';
  if (metal === 'white' || metal === 'yellow' || metal === 'rose') return `${metal.toUpperCase()}_GOLD_${k}` as MetalType;
  return null;
}

const label = (labels: Record<string, { label: string }> | undefined, key: unknown) => labels?.[String(key)]?.label ?? String(key);
const ct = (n: number) => `${n.toFixed(2)} ct`;

/** Builds and prices a design; throws InvalidDesign for anything the builder would not make. */
export async function priceDesign(builderDir: string, kind: DesignKind, input: unknown): Promise<PricedDesign> {
  const e = await loadEngine(builderDir);
  if (kind === 'ring') {
    const design = pick(input, e.ring.DEFAULT_RING);
    let built;
    try {
      built = e.ring.buildRing(design);
    } catch (err) {
      throw new InvalidDesign((err as Error).message);
    }
    const s = built.specs;
    const price = e.pricing.priceRing(s);
    const metalText = s.metal.head.label === s.metal.shank.label ? s.metal.shank.label : `${s.metal.shank.label} band, ${s.metal.head.label} head`;
    const head = label(e.ring.HEADS, s.head), shank = label(e.ring.SHANKS, s.shank);
    const properties: Record<string, string> = {
      'Centre stone': `${ct(s.centre.size)} ${s.centre.label} ${s.centre.gem === 'diamond' ? 'diamond' : s.centre.gem}`,
      Head: head,
      Band: shank,
      Metal: metalText,
      'Ring size': `US ${s.size}`,
    };
    if (s.sides) properties['Side stones'] = `2 × ${s.sides.shape} ${s.sides.length.toFixed(1)} × ${s.sides.width.toFixed(1)} mm`;
    if (s.accents.count) properties['Accent stones'] = `${s.accents.count}, ${ct(s.accents.carats)} total`;
    const one = s.metal.head.metal === s.metal.shank.metal;
    return {
      kind, design, lines: price.lines, total: price.total, currency: price.currency,
      title: `Custom ring: ${ct(s.centre.size)} ${s.centre.label} ${head} in ${metalText}`,
      sku: `CUSTOM-RING-${String(s.head).toUpperCase()}`,
      properties, ringSize: Number(s.size), engraving: null,
      metal: one ? stockedMetal(s.metal.shank.metal, String(design.karat ?? e.ring.DEFAULT_RING.karat)) : null,
      specs: { centre: s.centre, accents: s.accents, sides: s.sides ?? null, metal: s.metal, head: s.head, shank: s.shank, size: s.size, totalCarats: s.totalCarats },
      hasStones: true, hasCentre: true,
    };
  }

  const design = pick(input, e.band.DEFAULT_BAND);
  const engraving = typeof design.engraving === 'string' ? design.engraving.trim() : '';
  if (engraving.length > 40 || !ENGRAVING.test(engraving)) throw new InvalidDesign('engraving has unsupported characters or is too long');
  let built;
  try {
    built = e.band.buildBand(design);
  } catch (err) {
    throw new InvalidDesign((err as Error).message);
  }
  const s = built.specs;
  const price = e.pricing.priceBand(s);
  const metals: string = s.metals.map((m: { label: string }) => m.label).join(' and ');
  const profile = label(e.band.PROFILES, s.profile);
  const properties: Record<string, string> = {
    Band: `${Number(s.width).toFixed(1)} mm ${profile}, ${Number(s.thickness).toFixed(2)} mm thick`,
    Metal: metals,
    'Ring size': `EU ${s.size}`,
  };
  if (s.stones.count) properties.Stones = `${s.stones.count} diamonds, ${ct(s.stones.carats)} total`;
  if (s.sections > 1) properties.Sections = String(s.sections);
  if (engraving) properties.Engraving = engraving;
  return {
    kind, design, lines: price.lines, total: price.total, currency: price.currency,
    title: `Wedding band: ${Number(s.width).toFixed(1)} mm ${profile} in ${metals}`,
    sku: `CUSTOM-BAND-${String(s.profile).toUpperCase()}`,
    properties, ringSize: Number(s.size), engraving: engraving || null,
    metal: s.metals.length === 1 ? stockedMetal(s.metals[0].metal, s.karat) : null,
    specs: { width: s.width, thickness: s.thickness, size: s.size, profile: s.profile, shape: s.shape, metals: s.metals, karat: s.karat, sections: s.sections, finishes: s.finishes, edge: s.edge, grooves: s.grooves, stones: s.stones, beads: s.beads, innerStone: s.innerStone },
    hasStones: s.stones.count > 0 || s.innerStone !== 'none', hasCentre: false,
  };
}
