/**
 * Line icons for the builders' choices, as SVG markup (stroke follows the text colour).
 * Stone shapes are drawn from the same outlines the cuts are made from.
 */
import { cut } from './cuts.mjs';

const svg = (body, size = 40) => `<svg viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const f = (x) => x.toFixed(2);
const poly = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + 'Z';

/** A stone seen from above, scaled so the largest dimension spans `span` of 40. */
export function shapeIcon(shape, span = 30) {
  const c = cut(shape);
  const longest = Math.max(1, c.ratio);
  const k = span / longest;
  const at = (t, s = 1) => {
    const { p } = c.outline.at(t);
    const cx = c.outline.centre?.[0] ?? 0, cz = c.outline.centre?.[1] ?? 0;
    return [20 + (cx + (p[0] - cx) * s) * k, 20 - (cz + (p[1] - cz) * s) * k];
  };
  const outer = Array.from({ length: 96 }, (_, i) => at((i / 96) * 2 * Math.PI));
  let body = `<path d="${poly(outer)}"/>`;
  if (shape === 'emerald') {
    for (const s of [0.78, 0.6]) body += `<path d="${poly(Array.from({ length: 96 }, (_, i) => at((i / 96) * 2 * Math.PI, s)))}" stroke-width="0.8"/>`;
  } else {
    const table = Array.from({ length: 8 }, (_, i) => at(((i + 0.5) / 8) * 2 * Math.PI, 0.5));
    body += `<path d="${poly(table)}" stroke-width="0.8"/>`;
    for (let i = 0; i < 8; i++) {
      const a = at(((i + 0.5) / 8) * 2 * Math.PI, 0.5), b = at((i / 8) * 2 * Math.PI), d = at(((i + 1) / 8) * 2 * Math.PI, 0.5);
      body += `<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}L${f(d[0])} ${f(d[1])}" stroke-width="0.6"/>`;
    }
  }
  return svg(body);
}

/** The shape at a size relative to the largest carat offered. */
export const caratIcon = (shape, carat, largest = 3) => shapeIcon(shape, 30 * Math.cbrt(carat / largest));

// Side view of a stone: girdle at y 17, table at 12, culet at 29.
const STONE = '<path d="M8 17L13 12H27L32 17L20 29Z"/><path d="M8 17H32" stroke-width="0.7"/>';
const prongs = (xs) => xs.map(([x0, x1]) => `<path d="M${x0} 34C${x0} 26 ${x1} 22 ${x1} 13"/>`).join('');
const dots = (pts, r = 1.6) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('');

export const HEAD_ICONS = {
  'four-prong': svg(STONE + prongs([[15, 9], [25, 31]]) + '<path d="M13 34H27"/>'),
  'six-prong': svg(STONE + prongs([[15, 9], [25, 31], [20, 20]]) + '<path d="M13 34H27"/>'),
  halo: svg(STONE + prongs([[15, 10], [25, 30]]) + dots([[5, 17], [35, 17]], 2) + '<path d="M13 34H27"/>'),
  'hidden-halo': svg(STONE + prongs([[15, 9], [25, 31]]) + dots([[12, 20.5], [16, 21], [20, 21.3], [24, 21], [28, 20.5]], 1.3) + '<path d="M13 34H27"/>'),
  'secret-halo': svg(STONE + prongs([[15, 9], [25, 31]]) + dots([[12, 20.5], [16, 21], [20, 21.3], [24, 21], [28, 20.5]], 1.3) + dots([[16, 28.5], [20, 29.5], [24, 28.5]], 1.1) + '<path d="M13 34H27"/>'),
  bezel: svg('<path d="M10 16L14 12H26L30 16L20 27Z"/><path d="M7 14H33V19H7Z"/><path d="M12 19L16 34H24L28 19"/>'),
  'secret-bezel': svg(STONE + prongs([[15, 9], [25, 31]]) + '<path d="M10 19H30" stroke-width="2.2"/><path d="M13 34H27"/>'),
  tulip: svg(STONE + prongs([[15, 9], [25, 31]]) + '<path d="M10 17C12 30 18 30 20 22C22 30 28 30 30 17"/><path d="M13 34H27"/>'),
};

// A ring seen from slightly above: band ellipse, with the head on top.
const RING = (w = 1.6) => `<ellipse cx="20" cy="23" rx="14" ry="9" stroke-width="${w}"/>`;
const HEAD = '<path d="M17 13.5L20 10L23 13.5L20 15.5Z" stroke-width="0.9"/>';
const along = (n, from, to, inset = 0, fn) => {
  let out = '';
  for (let i = 0; i < n; i++) {
    const t = from + ((to - from) * i) / (n - 1);
    const x = 20 + (14 - inset) * Math.cos(t), y = 23 + (9 - inset * 0.6) * Math.sin(t);
    out += fn(x, y, t);
  }
  return out;
};
const paveDots = (n = 9, r = 0.85, inset = 0) => along(n, Math.PI * 0.15, Math.PI * 0.85, inset, (x, y) => `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="currentColor" stroke="none"/>`);

export const SHANK_ICONS = {
  classic: svg(RING(2.2) + HEAD),
  'classic-round': svg(RING(2.6) + HEAD),
  petite: svg(RING(1.1) + HEAD),
  twist: svg(`<ellipse cx="20" cy="23" rx="14" ry="9" stroke-width="0.8"/>` + along(14, 0, Math.PI * 2 - 0.3, 0, (x, y, t) => `<path d="M${f(x - 1)} ${f(y - 1.2)}L${f(x + 1)} ${f(y + 1.2)}" stroke-width="1.1"/>`) + HEAD),
  braided: svg(`<ellipse cx="20" cy="23" rx="14.5" ry="9.4" stroke-width="0.7"/><ellipse cx="20" cy="23" rx="13.5" ry="8.6" stroke-width="0.7"/>` + along(18, 0, Math.PI * 2 - 0.3, 0, (x, y) => `<path d="M${f(x - 1)} ${f(y - 1)}L${f(x + 1)} ${f(y + 1)}M${f(x + 1)} ${f(y - 1)}L${f(x - 1)} ${f(y + 1)}" stroke-width="0.7"/>`) + HEAD),
  fluted: svg(RING(2.4) + along(15, Math.PI * 0.1, Math.PI * 0.9, 0, (x, y) => `<path d="M${f(x)} ${f(y - 1.2)}V${f(y + 1.2)}" stroke-width="0.6" stroke="var(--icon-bg, #fff)"/>`) + HEAD),
  cathedral: svg(RING(2) + '<path d="M9 17C13 17 15 15 17 13.5M31 17C27 17 25 15 23 13.5" stroke-width="1.6"/>' + HEAD),
  'cathedral-pave': svg(RING(2) + '<path d="M9 17C13 17 15 15 17 13.5M31 17C27 17 25 15 23 13.5" stroke-width="1.6"/>' + paveDots(9, 0.75) + HEAD),
  pave: svg(RING(2.2) + paveDots() + HEAD),
  'pave-edge': svg(RING(2.8) + paveDots(10, 0.6, -0.9) + paveDots(10, 0.6, 0.9) + HEAD),
  'knife-edge-pave': svg(RING(2.4) + '<ellipse cx="20" cy="23" rx="14" ry="9" stroke-width="0.5" stroke="var(--icon-bg, #fff)"/>' + paveDots(9, 0.6, -0.8) + paveDots(9, 0.6, 0.8) + HEAD),
  channel: svg(`<ellipse cx="20" cy="23" rx="15" ry="9.6" stroke-width="0.8"/><ellipse cx="20" cy="23" rx="13" ry="8.4" stroke-width="0.8"/>` + along(8, Math.PI * 0.18, Math.PI * 0.82, 0, (x, y) => `<rect x="${f(x - 0.9)}" y="${f(y - 0.9)}" width="1.8" height="1.8" fill="currentColor" stroke="none"/>`) + HEAD),
  'french-pave': svg(RING(2.2) + paveDots() + along(9, Math.PI * 0.15, Math.PI * 0.85, -1.6, (x, y) => `<path d="M${f(x - 0.8)} ${f(y - 0.5)}L${f(x)} ${f(y + 0.6)}L${f(x + 0.8)} ${f(y - 0.5)}" stroke-width="0.5"/>`) + HEAD),
  'u-pave': svg(RING(2.2) + paveDots() + along(9, Math.PI * 0.15, Math.PI * 0.85, -1.6, (x, y) => `<path d="M${f(x - 0.8)} ${f(y - 0.5)}Q${f(x)} ${f(y + 1)} ${f(x + 0.8)} ${f(y - 0.5)}" stroke-width="0.5"/>`) + HEAD),
  'eight-stone': svg(RING(2.4) + along(4, Math.PI * 1.15, Math.PI * 1.42, 0, (x, y) => `<circle cx="${f(x)}" cy="${f(y)}" r="1.2" fill="currentColor" stroke="none"/>`) + along(4, Math.PI * 1.58, Math.PI * 1.85, 0, (x, y) => `<circle cx="${f(x)}" cy="${f(y)}" r="1.2" fill="currentColor" stroke="none"/>`) + HEAD),
  'triple-pave': svg(RING(3.4) + paveDots(10, 0.5, -1.1) + paveDots(10, 0.5, 0) + paveDots(10, 0.5, 1.1) + HEAD),
};

/** A round swatch of a gem: three gradient stops, light to dark. */
export const gemSwatch = ([a, b, c]) => `radial-gradient(circle at 35% 30%, ${a}, ${b} 58%, ${c})`;
