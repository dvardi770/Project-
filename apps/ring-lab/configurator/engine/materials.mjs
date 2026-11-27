/**
 * Gems and metals: how they look (for the renderer) and what they weigh (for prices and specs).
 * Plain data, shared by the ring builder, the band builder and their tests.
 */

/**
 * ior: refractive index (yellow light). dispersion: half the spread between red and blue light
 * (diamond's "fire"). absorption: how much red, green and blue is lost per millimetre inside
 * (linear, per mm). density: specific gravity, for carat weights.
 */
export const GEMS = {
  diamond:        { label: 'White diamond', ior: 2.417, dispersion: 0.022, absorption: [0, 0, 0], density: 3.52, swatch: ['#ffffff', '#dfe6ee', '#a9b5c2'] },
  lab:            { label: 'Lab diamond', ior: 2.417, dispersion: 0.022, absorption: [0, 0, 0], density: 3.52, swatch: ['#ffffff', '#e2e8f0', '#b3bfcc'] },
  emerald:        { label: 'Emerald', ior: 1.58, dispersion: 0.007, absorption: [1.15, 0.1, 0.85], density: 2.72, swatch: ['#a6f0c4', '#14935a', '#064a2b'] },
  sapphire:       { label: 'Blue sapphire', ior: 1.77, dispersion: 0.009, absorption: [1.35, 0.75, 0.07], density: 4.0, swatch: ['#8fa8ff', '#2747b8', '#101e5c'] },
  ruby:           { label: 'Ruby', ior: 1.77, dispersion: 0.009, absorption: [0.03, 1.7, 1.15], density: 4.0, swatch: ['#ff9aa8', '#c8102e', '#5e0414'] },
  yellowdiamond:  { label: 'Yellow diamond', ior: 2.417, dispersion: 0.022, absorption: [0.0, 0.04, 0.42], density: 3.52, swatch: ['#fff6c8', '#f1cf45', '#b88a12'] },
  bluediamond:    { label: 'Blue diamond', ior: 2.417, dispersion: 0.022, absorption: [0.27, 0.09, 0.0], density: 3.52, swatch: ['#eef6ff', '#8fbdf0', '#3f74b8'] },
  pinkdiamond:    { label: 'Pink diamond', ior: 2.417, dispersion: 0.022, absorption: [0.0, 0.2, 0.085], density: 3.52, swatch: ['#fff0f5', '#f4a6c4', '#c0577f'] },
  yellowsapphire: { label: 'Yellow sapphire', ior: 1.77, dispersion: 0.009, absorption: [0.0, 0.05, 0.55], density: 4.0, swatch: ['#fff6c8', '#f1cf45', '#b88a12'] },
  tanzanite:      { label: 'Tanzanite', ior: 1.69, dispersion: 0.01, absorption: [0.55, 1.15, 0.05], density: 3.35, swatch: ['#c9c2ff', '#5b4bc4', '#261a6b'] },
  blackdiamond:   { label: 'Black diamond', ior: 2.417, dispersion: 0.012, absorption: [4.2, 4.2, 4.0], density: 3.52, swatch: ['#6a6c70', '#202124', '#050506'] },
  champagne:      { label: 'Champagne diamond', ior: 2.417, dispersion: 0.022, absorption: [0.03, 0.15, 0.4], density: 3.52, swatch: ['#fff3e0', '#d9a86c', '#8a5a2b'] },
  moissanite:     { label: 'Moissanite', ior: 2.65, dispersion: 0.052, absorption: [0, 0, 0.004], density: 3.21, swatch: ['#ffffff', '#e6eef0', '#b8c4c8'] },
};

/** f0: the alloy's reflectance (linear RGB). density in g/cm³ by fineness. */
export const METALS = {
  white:    { label: 'White gold', f0: [0.86, 0.85, 0.83], swatch: '#e4e4e2', density: { '14k': 12.6, '18k': 14.7 } },
  // A deep, warm yellow: richer than the pale yellow of pure reflectance tables, as gold looks in a photo.
  yellow:   { label: 'Yellow gold', f0: [0.93, 0.62, 0.26], swatch: '#d9a94a', density: { '14k': 13.1, '18k': 15.6 } },
  rose:     { label: 'Rose gold', f0: [0.97, 0.63, 0.5], swatch: '#e7ab93', density: { '14k': 13.0, '18k': 15.1 } },
  platinum: { label: 'Platinum', f0: [0.74, 0.72, 0.69], swatch: '#cfd0d1', density: { '14k': 20.7, '18k': 20.7, pt: 20.7 } },
  // Offered for wedding bands: a deeper red gold, and white gold under black rhodium.
  red:      { label: 'Red gold', f0: [0.95, 0.52, 0.38], swatch: '#d4876f', density: { '14k': 13.2, '18k': 15.2 } },
  black:    { label: 'Black gold', f0: [0.12, 0.12, 0.125], swatch: '#2b2b2d', density: { '14k': 12.6, '18k': 14.7 } },
};

/** The metals the engagement ring builder offers (bands offer them all). */
export const RING_METALS = ['white', 'yellow', 'rose', 'platinum'];

export const KARATS = { '14k': '14k', '18k': '18k' };

/** Label for a metal at a fineness: "14k White gold", "Platinum". */
export const metalLabel = (metal, karat) => (metal === 'platinum' ? 'Platinum' : `${karat} ${METALS[metal].label}`);

/** Grams of metal for a volume in mm³. */
export const gramsOf = (volume, metal, karat) => (volume * METALS[metal].density[metal === 'platinum' ? 'pt' : karat]) / 1000;

/** Finishes for metal surfaces (the band builder offers them; rings are polished). */
export const FINISHES = {
  polished:   { label: 'High polish', roughness: 0.05 },
  satin:      { label: 'Satin brush', roughness: 0.3, brushed: true },
  crossbrush: { label: 'Cross brush', roughness: 0.28, brushed: true, across: true },
  matte:      { label: 'Matte', roughness: 0.5 },
  sand:       { label: 'Sandblast', roughness: 0.4 },
  frost:      { label: 'Frost', roughness: 0.1 },
  hammered:   { label: 'Hammered', roughness: 0.08, hammered: true },
  florentine: { label: 'Florentine', roughness: 0.2 },
  bark:       { label: 'Bark', roughness: 0.12 },
};

/** US ring size to inner diameter in mm (ISO 8653 / US standard). */
export const usToDiameter = (us) => 11.63 + 0.8128 * us;
/** EU ring size is the inner circumference in mm. */
export const euToDiameter = (eu) => eu / Math.PI;
export const diameterToUs = (d) => (d - 11.63) / 0.8128;
