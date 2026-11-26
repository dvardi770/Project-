/**
 * Icons for the wedding band builder's choices, as SVG markup. Lines follow the text colour
 * (currentColor); metal colours are passed in where an icon shows them. Plain strings, no DOM.
 */

const svg = (body, w = 56, h = 32) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const f = (x) => (Math.round(x * 100) / 100).toString();
const dots = (pts, r = 2.2, fill = 'currentColor') => pts.map(([x, y, rr = r]) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(rr)}" fill="${fill}" stroke="none"/>`).join('');
// The band seen from above: a strip running left to right.
const STRIP = '<rect x="3" y="8" width="50" height="16" rx="3"/>';

/** The ring seen along the finger: its outer shape. */
export function outlineIcon(shape) {
  const c = [28, 16], R = 12.5, r = 8.5;
  const path = (fn, n = 96) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI; const [x, y] = fn(a); return `${i ? 'L' : 'M'}${f(c[0] + x)} ${f(c[1] + y)}`; }).join('') + 'Z';
  const superE = (p, sx = 1, sy = 1) => (a) => { const cs = Math.cos(a), sn = Math.sin(a); return [R * sx * Math.sign(cs) * Math.abs(cs) ** (2 / p), R * sy * Math.sign(sn) * Math.abs(sn) ** (2 / p)]; };
  const poly = (n, rot) => (a) => { const sector = (2 * Math.PI) / n; const local = ((a - rot) % sector + sector) % sector - sector / 2; const k = Math.cos(sector / 2) / Math.cos(local); return [R * k * Math.cos(a), R * k * Math.sin(a)]; };
  const outer = {
    classic: (a) => [R * Math.cos(a), R * Math.sin(a)],
    square: superE(9), cushion: superE(4.5), octagon: poly(8, Math.PI / 8), hexagon: poly(6, 0),
    oval: (a) => [R * 1.15 * Math.cos(a), R * 0.92 * Math.sin(a)],
    wave: (a) => [R * Math.cos(a), R * Math.sin(a)],
    wavy: (a) => { const k = 1 + 0.07 * Math.sin(7 * a); return [R * k * Math.cos(a), R * k * Math.sin(a)]; },
  }[shape] ?? ((a) => [R * Math.cos(a), R * Math.sin(a)]);
  let body = `<path d="${path(outer)}" fill="var(--accent-soft)"/><circle cx="${c[0]}" cy="${c[1]}" r="${r}" fill="var(--bg, #fff)"/>`;
  if (shape === 'wave') body += `<path d="M14 6C20 10 36 2 42 6" stroke-width="1"/><path d="M14 26C20 30 36 22 42 26" stroke-width="1"/>`;
  return svg(body);
}

/** The band seen from above, split into its metal sections in their colours. */
export function sectionsIcon(colours, proportion = 'even') {
  const n = colours.length;
  const weights = colours.map((_, i) => {
    if (proportion === 'even' || n === 1) return 1;
    const middle = n === 2 ? i === 0 : i > 0 && i < n - 1;
    return middle ? (proportion === 'wide-centre' ? 2.2 : 0.45) : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let y = 8;
  const bands = weights.map((wt, i) => { const h = (16 * wt) / total; const r = `<rect x="3" y="${f(y)}" width="50" height="${f(h)}" fill="${colours[i]}" stroke="none"/>`; y += h; return r; }).join('');
  return svg(`<clipPath id="sc${n}${proportion}"><rect x="3" y="8" width="50" height="16" rx="3"/></clipPath><g clip-path="url(#sc${n}${proportion})">${bands}</g>${STRIP}`);
}

/** Two sections meeting, in cross-section. */
export function joinIcon(join) {
  const left = 'M6 22V12H28', right = 'M28 12H50V22';
  const mid = {
    flush: '<path d="M6 22V12H50V22Z" fill="var(--accent-soft)"/><path d="M28 12V22" stroke-dasharray="1 2"/>',
    line: '<path d="M6 22V12H27L28 13.5L29 12H50V22Z" fill="var(--accent-soft)"/>',
    groove: '<path d="M6 22V12H25L28 17L31 12H50V22Z" fill="var(--accent-soft)"/>',
    step: '<path d="M6 22V14H28V10H50V22Z" fill="var(--accent-soft)"/>',
  }[join] ?? `<path d="${left}"/><path d="${right}"/>`;
  return svg(`${mid}<path d="M6 22H50"/>`);
}

/** Decorative lines round the band, seen from above. */
export function groovesIcon(grooves) {
  const ys = { none: [], centre: [16], double: [13, 19], triple: [11.5, 16, 20.5] }[grooves] ?? [];
  return svg(`${STRIP}${ys.map((y) => `<path d="M5 ${y}H51" stroke-width="1.6"/>`).join('')}`);
}

/** An edge detail, in cross-section: the band's corner. */
export function edgeIcon(edge) {
  const fill = 'fill="var(--accent-soft)"';
  const body = {
    none: `<path d="M8 26V8H40Q46 8 46 14V26Z" ${fill}/>`,
    bevel: `<path d="M8 26V8H36L46 18V26Z" ${fill}/>`,
    step: `<path d="M8 26V8H36V14H46V26Z" ${fill}/>`,
    line: `<path d="M8 26V8H32L34 11L36 8H40Q46 8 46 14V26Z" ${fill}/>`,
    milgrain: `<path d="M8 26V8H34V13H46V26Z" ${fill}/>${dots([[37, 11.2, 1.8], [41, 11.2, 1.8], [45, 11.2, 1.8]])}`,
    rope: `<path d="M8 26V8H34V13H46V26Z" ${fill}/><path d="M35 12C37 8 39 13 41 10S45 12 46 10" stroke-width="1.6"/>`,
  }[edge] ?? '';
  return svg(body);
}

/** Which edges of the band get the detail, seen from above. */
export function edgeSideIcon(side) {
  const left = side !== 'right', right = side !== 'left';
  return svg(`${STRIP}${left ? '<path d="M5 9.5H51" stroke-width="2.4" stroke="var(--accent)"/>' : ''}${right ? '<path d="M5 22.5H51" stroke-width="2.4" stroke="var(--accent)"/>' : ''}`);
}

/** A finish as a round sample. */
export function finishIcon(finish) {
  const id = `fi-${finish}`;
  const clip = `<clipPath id="${id}"><circle cx="28" cy="16" r="12"/></clipPath>`;
  let marks = '';
  const lines = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');
  switch (finish) {
    case 'satin': marks = lines(9, (i) => `<path d="M14 ${f(6 + i * 2.5)}H42" stroke-width="0.6"/>`); break;
    case 'crossbrush': marks = lines(9, (i) => `<path d="M${f(18 + i * 2.5)} 3V29" stroke-width="0.6"/>`); break;
    case 'matte': marks = ''; break;
    case 'sand': marks = dots(Array.from({ length: 46 }, (_, i) => [17 + ((i * 37) % 23), 5 + ((i * 53) % 23), 0.45])); break;
    case 'frost': marks = lines(10, (i) => { const x = 17 + (i % 4) * 6, y = 7 + Math.floor(i / 4) * 7; return `<path d="M${x} ${y}l3 4l-4 1z" stroke-width="0.6"/>`; }); break;
    case 'hammered': marks = [[22, 11, 4], [33, 12, 4.5], [27, 21, 4], [38, 21, 3], [18, 20, 3]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" stroke-width="0.7"/>`).join(''); break;
    case 'florentine': marks = lines(7, (i) => `<path d="M${14 + i * 4} 4L${4 + i * 4} 30" stroke-width="0.5"/><path d="M${14 + i * 4} 30L${4 + i * 4} 4" stroke-width="0.5"/>`); break;
    case 'bark': marks = lines(6, (i) => `<path d="M14 ${8 + i * 3.4}C20 ${6 + i * 3.4} 24 ${11 + i * 3.4} 30 ${8 + i * 3.4}S38 ${6 + i * 3.4} 42 ${9 + i * 3.4}" stroke-width="0.7"/>`); break;
    default: marks = '<path d="M20 10Q26 6 32 9" stroke-width="2" stroke="#fff" opacity="0.9"/>';
  }
  const fill = finish === 'matte' || finish === 'sand' ? 'var(--accent-soft)' : 'url(#g-' + id + ')';
  return svg(`<defs><radialGradient id="g-${id}" cx="35%" cy="30%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="var(--accent-soft)"/></radialGradient>${clip}</defs><circle cx="28" cy="16" r="12" fill="${fill}"/><g clip-path="url(#${id})">${marks}</g><circle cx="28" cy="16" r="12"/>`);
}

/** Where stones go, on the band seen from above. */
export function arrangementIcon(kind) {
  const ring = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
  const body = {
    none: '',
    solitaire: dots([[28, 16, 3]]) + ring(28, 16, 4.6),
    trio: dots([[19, 16, 2.4], [28, 16, 3], [37, 16, 2.4]]),
    across: dots([[28, 11, 2], [28, 16, 2], [28, 21, 2]]),
    along: dots(Array.from({ length: 9 }, (_, i) => [8 + i * 5, 16, 1.8])),
    bezel: dots([[28, 16, 2.6]]) + '<circle cx="28" cy="16" r="5.4" stroke-width="2"/>',
    tension: '<path d="M25 8V24M31 8V24" stroke-width="1.6"/>' + dots([[28, 16, 2.6]]),
    scatter: dots([[12, 12, 1.6], [18, 19, 2.1], [25, 11, 1.2], [31, 18, 1.8], [37, 12, 1.4], [43, 19, 2], [47, 12, 1.1]]),
  }[kind] ?? '';
  return svg(STRIP + body);
}

/** How stones in a row are held. */
export function setStyleIcon(style) {
  const row = Array.from({ length: 5 }, (_, i) => [12 + i * 8, 16, 2.6]);
  if (style === 'channel') return svg(`${STRIP}<path d="M5 12H51M5 20H51" stroke-width="1.6"/>${dots(row)}`);
  if (style === 'flush') return svg(STRIP + dots(row) + row.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6"/>`).join(''));
  return svg(STRIP + dots(row) + row.slice(0, 4).map(([x]) => dots([[x + 4, 12, 0.9], [x + 4, 20, 0.9]])).join(''));
}

/** How far round the ring a row goes. */
export function spanIcon(fraction) {
  const n = 16, k = Math.round(n * fraction);
  const pts = Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i / n) * 2 * Math.PI; return [28 + 11 * Math.cos(a), 16 + 11 * Math.sin(a)]; });
  return svg(`<circle cx="28" cy="16" r="11" stroke-width="3.5" stroke="var(--accent-soft)"/>${dots(pts.slice(0, k).map(([x, y]) => [x, y, 1.5]))}`);
}

/** Gaps between stones. */
export function spacingIcon(spacing) {
  const gap = { touching: 0, close: 1.5, airy: 4.5, wide: 9 }[spacing] ?? 1.5;
  const pts = [];
  for (let x = 6; x < 51 && pts.length < 8; x += 5 + gap) pts.push([x + 2.5, 16, 2.5]);
  return svg(STRIP + dots(pts));
}

/** A row across the band, straight or slanting. */
export function tiltIcon(tilt) {
  const a = { straight: 0, left: -40, right: 40 }[tilt] ?? 0;
  const r = (a * Math.PI) / 180;
  return svg(STRIP + dots([-1, 0, 1].map((k) => [28 + k * 5 * Math.sin(r), 16 + k * 5 * Math.cos(r), 2.1])));
}

/** A scatter pattern, from the same layout the band uses. */
export function scatterIcon(points, L, width) {
  const kx = 46 / L, ky = 14 / width;
  return svg(STRIP + dots(points.map((p) => [28 + p.x * kx, 16 + p.y * ky, Math.max(0.8, p.r * Math.min(kx, ky) * 1.1)])));
}

/** Linked rings: two chain links joined, or apart when the rings are designed one by one. */
export function linkIcon(linked) {
  return linked
    ? '<svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="2" y="6" width="13" height="8" rx="4"/><rect x="13" y="6" width="13" height="8" rx="4"/></svg>'
    : '<svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="1" y="6" width="11" height="8" rx="4"/><rect x="16" y="6" width="11" height="8" rx="4"/><path d="M14 3V6M14 14V17"/></svg>';
}
