/**
 * Prices for designed rings and wedding bands, from what they are made of: grams of metal,
 * carats of each kind of stone, and the work of making and setting. Every figure comes from a
 * price list the jeweller sets; the defaults below are sample figures (USD), not quotes.
 *
 * In the storefront the centre stone of an engagement ring is normally a real, certified stone
 * from the diamond feed with its own price; centreFromList prices it from the list instead,
 * for designing before a stone is chosen.
 */
import { GEMS, metalLabel } from './materials.mjs';

export const PRICE_LIST = {
  currency: 'USD',
  // Per gram of finished metal, including casting and finishing.
  metalPerGram: { '14k': 92, '18k': 124, platinum: 118 },
  // Centre stones: price per carat at 1 ct, and how fast the per-carat price grows with size.
  centre: {
    diamond: { perCarat: 5200, growth: 0.75 },
    lab: { perCarat: 780, growth: 0.35 },
    moissanite: { perCarat: 420, growth: 0.1 },
    emerald: { perCarat: 2900, growth: 0.5 },
    sapphire: { perCarat: 2300, growth: 0.45 },
    ruby: { perCarat: 3300, growth: 0.55 },
    pinkdiamond: { perCarat: 41000, growth: 0.9 },
    yellowsapphire: { perCarat: 1150, growth: 0.3 },
    tanzanite: { perCarat: 640, growth: 0.25 },
  },
  // Small stones (pavé, halo, channel), per carat.
  accentPerCarat: { diamond: 1600, lab: 420, moissanite: 300, emerald: 1300, sapphire: 1100, ruby: 1400, pinkdiamond: 9000, yellowsapphire: 700, tanzanite: 500 },
  // Making the piece, and setting each small stone.
  making: { ring: 340, band: 160, perAccent: 9, engraving: 45, twoTone: 70, finish: 25, groove: 20 },
  // Extra work for some heads and shanks.
  heads: { halo: 220, 'hidden-halo': 160, 'secret-halo': 240, bezel: 90, 'secret-bezel': 110, tulip: 120 },
  shanks: { twist: 90, braided: 140, fluted: 80, cathedral: 60, 'cathedral-pave': 90, channel: 120, 'french-pave': 110, 'u-pave': 110, 'knife-edge-pave': 80 },
};

const round = (x) => Math.round(x);

/** Price of a centre stone from the list. */
export function centreFromList(gem, carats, list = PRICE_LIST) {
  const p = list.centre[gem] ?? list.centre.diamond;
  return round(p.perCarat * carats * carats ** p.growth);
}

/** Price breakdown of a designed engagement ring (specs from ring.mjs). */
export function priceRing(specs, { list = PRICE_LIST, centrePrice = null } = {}) {
  const lines = [];
  const centre = centrePrice ?? centreFromList(specs.centre.gem, specs.centre.size, list);
  lines.push({ key: 'centre', label: `${specs.centre.size.toFixed(2)} ct ${specs.centre.label} ${GEMS[specs.centre.gem].label.toLowerCase()}`, amount: centre });
  const karatOf = (label) => (label.startsWith('18k') ? '18k' : label.startsWith('14k') ? '14k' : 'platinum');
  const metal = ['head', 'shank'].reduce((s, k) => s + specs.metal[k].grams * list.metalPerGram[karatOf(specs.metal[k].label)], 0);
  const sameMetal = specs.metal.head.label === specs.metal.shank.label;
  lines.push({ key: 'metal', label: sameMetal ? `${specs.metal.grams.toFixed(1)} g ${specs.metal.shank.label}` : `${specs.metal.grams.toFixed(1)} g ${specs.metal.shank.label} and ${specs.metal.head.label}`, amount: round(metal) });
  if (specs.accents.count) {
    lines.push({ key: 'accents', label: `${specs.accents.count} accent stones, ${specs.accents.carats.toFixed(2)} ct`, amount: round(specs.accents.carats * (list.accentPerCarat[specs.accents.gem] ?? list.accentPerCarat.diamond)) });
  }
  const making = list.making.ring + (list.heads[specs.head] ?? 0) + (list.shanks[specs.shank] ?? 0) + specs.accents.count * list.making.perAccent + (sameMetal ? 0 : list.making.twoTone);
  lines.push({ key: 'making', label: 'Making and setting', amount: round(making) });
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0), currency: list.currency };
}

/** Price breakdown of one wedding band (specs from band.mjs). */
export function priceBand(specs, { list = PRICE_LIST } = {}) {
  const lines = [];
  const metal = specs.metals.reduce((s, m) => s + m.grams * list.metalPerGram[m.metal === 'platinum' ? 'platinum' : specs.karat], 0);
  lines.push({ key: 'metal', label: specs.metals.map((m) => `${m.grams.toFixed(1)} g ${metalLabel(m.metal, specs.karat)}`).join(' + '), amount: round(metal) });
  if (specs.stones.count) {
    lines.push({ key: 'stones', label: `${specs.stones.count} diamonds, ${specs.stones.carats.toFixed(2)} ct`, amount: round(specs.stones.carats * list.accentPerCarat.diamond) });
  }
  let making = list.making.band + specs.stones.count * list.making.perAccent;
  if (specs.metals.length > 1) making += list.making.twoTone;
  if (specs.finishes.some((f) => f !== 'polished')) making += list.making.finish;
  if (specs.grooves) making += list.making.groove * specs.grooves;
  lines.push({ key: 'making', label: 'Making and finishing', amount: round(making) });
  if (specs.engraving) lines.push({ key: 'engraving', label: `Engraving “${specs.engraving}”`, amount: list.making.engraving });
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0), currency: list.currency };
}

export const money = (amount, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
