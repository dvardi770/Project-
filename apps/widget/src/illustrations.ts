/**
 * Drawn stand-ins for product photography.
 *
 * Most feed stones and many settings arrive without images. Rather than an
 * empty box, the builder draws the diamond's cut and a ring in the chosen
 * metal with the chosen stone set in it. A real photo, when there is one,
 * always takes precedence.
 *
 * Everything is inline SVG: no requests, no fonts, works in the shadow root.
 * Gradients are defined once by `illustrationDefs()`, which the component
 * renders at its root, and referenced by id from every drawing.
 */
import { html, svg, type SVGTemplateResult, type TemplateResult } from 'lit';

// ─── Shapes ──────────────────────────────────────────────────────────────────
// Each cut is drawn in a 100 × 100 box centred on 0,0: an outline plus a few
// facet lines that make it read as that cut at small sizes.

interface Cut {
  outline: string;
  facets: string;
}

const octagon = (rx: number, ry: number) =>
  Array.from({ length: 8 }, (_, i) => {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    return `${(Math.cos(a) * rx).toFixed(2)},${(Math.sin(a) * ry).toFixed(2)}`;
  });

function brilliant(rx: number, ry: number): Cut {
  const inner = octagon(rx * 0.5, ry * 0.5);
  const outer = octagon(rx, ry);
  const spokes = inner.map((p, i) => `M${p}L${outer[i]}`).join('');
  return {
    outline: `M${-rx},0A${rx},${ry} 0 1 0 ${rx},0A${rx},${ry} 0 1 0 ${-rx},0Z`,
    facets: `M${inner.join('L')}Z${spokes}`,
  };
}

/** A rectangle with cut corners, plus its inner steps (emerald, asscher, radiant). */
function stepCut(w: number, h: number, cut: number, diagonals: boolean): Cut {
  const box = (sw: number, sh: number, sc: number) =>
    `M${-sw + sc},${-sh}L${sw - sc},${-sh}L${sw},${-sh + sc}L${sw},${sh - sc}L${sw - sc},${sh}L${-sw + sc},${sh}L${-sw},${sh - sc}L${-sw},${-sh + sc}Z`;
  const steps = box(w * 0.68, h * 0.72, cut * 0.68) + box(w * 0.38, h * 0.46, cut * 0.4);
  const diag = diagonals ? `M${-w},${-h + cut}L${w},${h - cut}M${w},${-h + cut}L${-w},${h - cut}` : '';
  return { outline: box(w, h, cut), facets: steps + diag };
}

const scalePath = (d: string, k: number) => d.replace(/-?\d+(\.\d+)?/g, (n) => (Number(n) * k).toFixed(2));

function curved(outline: string, extra = ''): Cut {
  return { outline, facets: scalePath(outline, 0.52) + extra };
}

const CUTS: Record<string, Cut> = {
  ROUND: brilliant(48, 48),
  OVAL: brilliant(34, 48),
  CUSHION: {
    outline: 'M-20,-46H20C38,-46 46,-38 46,-20V20C46,38 38,46 20,46H-20C-38,46 -46,38 -46,20V-20C-46,-38 -38,-46 -20,-46Z',
    facets: 'M-10,-23H10C19,-23 23,-19 23,-10V10C23,19 19,23 10,23H-10C-19,23 -23,19 -23,10V-10C-23,-19 -19,-23 -10,-23ZM-23,-23L-40,-40M23,-23L40,-40M23,23L40,40M-23,23L-40,40',
  },
  PRINCESS: {
    outline: 'M-45,-45H45V45H-45Z',
    facets: 'M-45,-45L45,45M45,-45L-45,45M-20,-20H20V20H-20Z',
  },
  EMERALD: stepCut(32, 47, 12, false),
  ASSCHER: stepCut(45, 45, 18, false),
  RADIANT: stepCut(34, 46, 10, true),
  PEAR: curved('M0,-48C20,-30 36,-6 36,14C36,34 20,46 0,46C-20,46 -36,34 -36,14C-36,-6 -20,-30 0,-48Z', 'M0,-48L0,-25'),
  MARQUISE: curved('M0,-48C26,-26 26,26 0,48C-26,26 -26,-26 0,-48Z', 'M0,-48L0,-25M0,48L0,25'),
  HEART: curved(
    'M0,44C-18,30 -46,12 -46,-12C-46,-32 -30,-44 -16,-44C-6,-44 0,-36 0,-30C0,-36 6,-44 16,-44C30,-44 46,-32 46,-12C46,12 18,30 0,44Z',
  ),
};

const cutFor = (shape: string): Cut => CUTS[shape] ?? CUTS.ROUND!;

/** A stone drawn at x,y with the given height in user units. */
export function stone(shape: string, x: number, y: number, size: number): SVGTemplateResult {
  const k = size / 100;
  const c = cutFor(shape);
  return svg`
    <g transform="translate(${x} ${y}) scale(${k})">
      <path d=${c.outline} fill="url(#jc-stone)" stroke="var(--_stone-edge)" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <path d=${c.facets} fill="none" stroke="var(--_stone-edge)" stroke-width="0.75" stroke-opacity="0.55" vector-effect="non-scaling-stroke" />
      <ellipse cx="-14" cy="-18" rx="11" ry="6" fill="#ffffff" fill-opacity="0.75" transform="rotate(-30 -14 -18)" />
    </g>
  `;
}

/** A small stand-alone drawing of a cut, for filter chips and the stone list. */
export function stoneIcon(shape: string, label?: string): TemplateResult {
  return html`<svg class="ill stone-ill" viewBox="-56 -56 112 112" role=${label ? 'img' : 'presentation'} aria-label=${label ?? ''} aria-hidden=${label ? 'false' : 'true'}>
    ${stone(shape, 0, 0, 100)}
  </svg>`;
}

// ─── Metals ──────────────────────────────────────────────────────────────────

export type MetalTone = 'white' | 'yellow' | 'rose';

export const metalTone = (metal: string): MetalTone =>
  metal.startsWith('YELLOW') ? 'yellow' : metal.startsWith('ROSE') ? 'rose' : 'white';

const METAL_STOPS: Record<MetalTone, [string, string, string]> = {
  white: ['#fbfbfc', '#b9bfc8', '#eef0f3'],
  yellow: ['#fbe8ad', '#c99a35', '#f2d68a'],
  rose: ['#f9dccf', '#c9826d', '#f0c2b0'],
};

/** Shared gradients. Render once, near the top of the shadow root. */
export function illustrationDefs(): TemplateResult {
  return html`<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="jc-stone" cx="38%" cy="32%" r="78%">
        <stop offset="0" stop-color="#ffffff" />
        <stop offset="0.55" stop-color="#eef3f7" />
        <stop offset="1" stop-color="#c9d4de" />
      </radialGradient>
      ${(Object.keys(METAL_STOPS) as MetalTone[]).map(
        (tone) => svg`
          <linearGradient id="jc-metal-${tone}" x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stop-color=${METAL_STOPS[tone][0]} />
            <stop offset="0.55" stop-color=${METAL_STOPS[tone][1]} />
            <stop offset="1" stop-color=${METAL_STOPS[tone][2]} />
          </linearGradient>
        `,
      )}
    </defs>
  </svg>`;
}

// ─── Rings ───────────────────────────────────────────────────────────────────

export interface RingOptions {
  /** Mounting style, e.g. SOLITAIRE, HALO. */
  style: string;
  /** Metal of the chosen variant, e.g. ROSE_GOLD_14K. */
  metal: string;
  /** Centre stone cut. */
  shape: string;
  /** Centre stone weight; scales the stone a little. */
  carat?: number;
  label?: string;
}

const CX = 120;
const CY = 132;
const RX = 66;
const RY = 40;

/** Point on the band's ellipse at angle a (0 = top centre, positive = clockwise). */
const onBand = (a: number) => [CX + Math.sin(a) * RX, CY - Math.cos(a) * RY] as const;

/** A three-quarter view of a ring in the chosen metal with the chosen stone set in it. */
export function ringIllustration(o: RingOptions): TemplateResult {
  const metal = `url(#jc-metal-${metalTone(o.metal)})`;
  const carat = Math.min(Math.max(o.carat ?? 1, 0.3), 4);
  const size = 46 + carat * 12; // stone height in user units
  const sx = CX;
  const sy = CY - RY - size * 0.3;
  const style = o.style.toUpperCase();
  const accents: SVGTemplateResult[] = [];
  const dots = (angles: number[], r: number) =>
    angles.map((a) => {
      const [x, y] = onBand(a);
      return svg`<circle cx=${x} cy=${y} r=${r} fill="url(#jc-stone)" stroke="var(--_stone-edge)" stroke-width="0.6" />`;
    });

  // Shoulders: small stones along the front of the band.
  if (style === 'PAVE' || style === 'SIDE_STONE' || style === 'HIDDEN_HALO') {
    accents.push(...dots([-0.95, -0.8, -0.65, -0.5, -0.36, 0.36, 0.5, 0.65, 0.8, 0.95], 2.6));
  }
  if (style === 'VINTAGE') {
    accents.push(...dots([-1.1, -0.85, -0.6, -0.38, 0.38, 0.6, 0.85, 1.1], 1.6));
  }

  // Cathedral arches rise from the shoulders to the head.
  const arches =
    style === 'CATHEDRAL'
      ? svg`<path d="M${onBand(-0.62).join(',')}C${CX - 34},${sy - 6} ${CX - 12},${sy + size * 0.2} ${CX - 4},${sy + size * 0.32}M${onBand(0.62).join(',')}C${CX + 34},${sy - 6} ${CX + 12},${sy + size * 0.2} ${CX + 4},${sy + size * 0.32}" fill="none" stroke=${metal} stroke-width="5" stroke-linecap="round" />`
      : null;

  // Prongs: four claws gripping the stone.
  const prongs =
    style === 'BEZEL'
      ? null
      : svg`<g stroke=${metal} stroke-width="3.2" stroke-linecap="round">
          ${[-0.36, -0.14, 0.14, 0.36].map((t) => svg`<line x1=${sx + t * size} y1=${sy + size * 0.12} x2=${sx + t * size * 0.55} y2=${CY - RY + 3} />`)}
        </g>`;

  const halo =
    style === 'HALO'
      ? Array.from({ length: 16 }, (_, i) => {
          const a = (Math.PI * 2 * i) / 16;
          return svg`<circle cx=${sx + Math.cos(a) * size * 0.64} cy=${sy + Math.sin(a) * size * 0.64} r="3" fill="url(#jc-stone)" stroke="var(--_stone-edge)" stroke-width="0.6" />`;
        })
      : null;

  const sideStones =
    style === 'THREE_STONE'
      ? [stone(o.shape, sx - size * 0.82, sy + size * 0.16, size * 0.6), stone(o.shape, sx + size * 0.82, sy + size * 0.16, size * 0.6)]
      : null;

  const bezel = style === 'BEZEL' ? svg`<g transform="translate(${sx} ${sy}) scale(${(size * 1.16) / 100})"><path d=${cutFor(o.shape).outline} fill=${metal} /></g>` : null;

  return html`<svg class="ill ring-ill" viewBox="0 0 240 200" role=${o.label ? 'img' : 'presentation'} aria-label=${o.label ?? ''} aria-hidden=${o.label ? 'false' : 'true'}>
    <ellipse cx=${CX} cy="186" rx="62" ry="6" fill="var(--_shadow)" />
    <!-- back of the band, then the front, drawn as one shaded ellipse -->
    <ellipse cx=${CX} cy=${CY} rx=${RX} ry=${RY} fill="none" stroke=${metal} stroke-width="12" />
    <ellipse cx=${CX} cy=${CY + 2} rx=${RX - 6} ry=${RY - 5} fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5" />
    ${arches} ${accents} ${prongs} ${bezel} ${halo} ${sideStones} ${stone(o.shape, sx, sy, size)}
  </svg>`;
}
