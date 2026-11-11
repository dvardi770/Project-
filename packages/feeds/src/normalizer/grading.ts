/**
 * Vocabulary shared by every feed adapter: maps the free-text grading terms
 * suppliers send ("EX", "V.Good", "VVS 1", "Strong Blue") onto the enums in
 * schema.prisma. Every function returns null for values it does not recognise
 * so that bad data is stored as "unknown" rather than as a wrong grade.
 */
import {
  CutGrade,
  DiamondClarity,
  DiamondColor,
  DiamondShape,
  Fluorescence,
  GradingLab,
  Prisma,
} from '@jewelry/db';

/** Upper-case and strip everything except A–Z and 0–9. */
function key(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const SHAPES: Record<string, DiamondShape> = {
  ROUND: 'ROUND',
  RD: 'ROUND',
  RB: 'ROUND',
  RBC: 'ROUND',
  BR: 'ROUND',
  B: 'ROUND',
  ROUNDBRILLIANT: 'ROUND',
  BRILLIANT: 'ROUND',
  PRINCESS: 'PRINCESS',
  PR: 'PRINCESS',
  PRN: 'PRINCESS',
  CUSHION: 'CUSHION',
  CU: 'CUSHION',
  CUS: 'CUSHION',
  CB: 'CUSHION',
  CUSHIONBRILLIANT: 'CUSHION',
  CUSHIONMODIFIED: 'CUSHION',
  CUSHIONMODIFIEDBRILLIANT: 'CUSHION',
  CMB: 'CUSHION',
  OVAL: 'OVAL',
  OV: 'OVAL',
  EMERALD: 'EMERALD',
  EM: 'EMERALD',
  EC: 'EMERALD',
  SQUAREEMERALD: 'ASSCHER',
  SQEMERALD: 'ASSCHER',
  ASSCHER: 'ASSCHER',
  AS: 'ASSCHER',
  ASH: 'ASSCHER',
  PEAR: 'PEAR',
  PS: 'PEAR',
  PE: 'PEAR',
  MARQUISE: 'MARQUISE',
  MQ: 'MARQUISE',
  MAR: 'MARQUISE',
  RADIANT: 'RADIANT',
  RA: 'RADIANT',
  RAD: 'RADIANT',
  SQUARERADIANT: 'RADIANT',
  SQRADIANT: 'RADIANT',
  HEART: 'HEART',
  HS: 'HEART',
  HT: 'HEART',
  HE: 'HEART',
};

/** Unknown or exotic shapes (trilliant, baguette, …) become OTHER. */
export function normalizeShape(raw: unknown): DiamondShape {
  return SHAPES[key(raw)] ?? 'OTHER';
}

const SINGLE_COLORS = new Set(['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']);

/**
 * D–M map one-to-one; N through Z (including ranges such as "O-P") collapse
 * into N_TO_Z. Fancy colours return null and belong in the fancy* columns.
 */
export function normalizeColor(raw: unknown): DiamondColor | null {
  const k = key(raw);
  if (!k) return null;
  if (SINGLE_COLORS.has(k)) return k as DiamondColor;
  // "N", "OP", "STUV", "WZ" — an ascending run of letters from N to Z.
  if (/^[N-Z]{1,4}$/.test(k) && isLetterRun(k)) return 'N_TO_Z';
  return null;
}

/** True when letters are ascending, e.g. "OP", "STUV", "WZ". */
function isLetterRun(k: string): boolean {
  for (let i = 1; i < k.length; i++) {
    if (k.charCodeAt(i) <= k.charCodeAt(i - 1)) return false;
  }
  return true;
}

const CLARITIES: Record<string, DiamondClarity> = {
  FL: 'FL',
  FLAWLESS: 'FL',
  IF: 'IF',
  LC: 'IF',
  INTERNALLYFLAWLESS: 'IF',
  VVS1: 'VVS1',
  VVS2: 'VVS2',
  VS1: 'VS1',
  VS2: 'VS2',
  SI1: 'SI1',
  SI2: 'SI2',
  SI3: 'SI3',
  I1: 'I1',
  I2: 'I2',
  I3: 'I3',
  P1: 'I1',
  P2: 'I2',
  P3: 'I3',
};

export function normalizeClarity(raw: unknown): DiamondClarity | null {
  return CLARITIES[key(raw)] ?? null;
}

const CUT_GRADES: Record<string, CutGrade> = {
  IDEAL: 'IDEAL',
  ID: 'IDEAL',
  I: 'IDEAL',
  EXCELLENT: 'EXCELLENT',
  EX: 'EXCELLENT',
  EXC: 'EXCELLENT',
  X: 'EXCELLENT',
  VERYGOOD: 'VERY_GOOD',
  VG: 'VERY_GOOD',
  VGOOD: 'VERY_GOOD',
  GOOD: 'GOOD',
  GD: 'GOOD',
  G: 'GOOD',
  FAIR: 'FAIR',
  FR: 'FAIR',
  F: 'FAIR',
  POOR: 'POOR',
  PR: 'POOR',
  P: 'POOR',
};

/** Cut, polish and symmetry all use the same scale. */
export function normalizeCutGrade(raw: unknown): CutGrade | null {
  return CUT_GRADES[key(raw)] ?? null;
}

const FLUORESCENCE: Record<string, Fluorescence> = {
  NONE: 'NONE',
  NON: 'NONE',
  NIL: 'NONE',
  NO: 'NONE',
  N: 'NONE',
  INERT: 'NONE',
  FAINT: 'FAINT',
  FNT: 'FAINT',
  FA: 'FAINT',
  F: 'FAINT',
  SLIGHT: 'FAINT',
  SL: 'FAINT',
  VERYSLIGHT: 'FAINT',
  VSL: 'FAINT',
  NEGLIGIBLE: 'FAINT',
  MEDIUM: 'MEDIUM',
  MED: 'MEDIUM',
  M: 'MEDIUM',
  STRONG: 'STRONG',
  STG: 'STRONG',
  ST: 'STRONG',
  S: 'STRONG',
  VERYSTRONG: 'VERY_STRONG',
  VST: 'VERY_STRONG',
  VSTG: 'VERY_STRONG',
  VS: 'VERY_STRONG',
};

/** Accepts intensity with a trailing colour, e.g. "Strong Blue". */
export function normalizeFluorescence(raw: unknown): Fluorescence | null {
  const k = key(raw);
  if (!k) return null;
  const direct = FLUORESCENCE[k];
  if (direct) return direct;
  const withoutColor = k.replace(/(BLUE|YELLOW|WHITE|GREEN|ORANGE|RED)$/, '');
  return FLUORESCENCE[withoutColor] ?? null;
}

const LABS: Record<string, GradingLab> = {
  GIA: 'GIA',
  IGI: 'IGI',
  HRD: 'HRD',
  HRDANTWERP: 'HRD',
  GCAL: 'GCAL',
  AGS: 'AGS',
  AGSL: 'AGS',
  NONE: 'NONE',
  NA: 'NONE',
  UNCERTIFIED: 'NONE',
};

export function normalizeLab(raw: unknown): GradingLab {
  const k = key(raw);
  if (!k) return 'NONE';
  return LABS[k] ?? 'OTHER';
}

/**
 * Reduce a certificate reference to the bare report number.
 * "GIA 2141438167" → "2141438167", "IGI# LG 123456789" → "LG123456789",
 * "N/A" → null.
 */
export function parseCertificateNumber(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).toUpperCase().trim();
  // Spreadsheets sometimes emit long report numbers as floats ("2141438167.0").
  s = s.replace(/\.0+$/, '');
  // Drop a leading lab name; "LG" is part of IGI lab-grown numbers and is kept.
  s = s.replace(/^(GIA|IGI|HRD|GCAL|AGSL?|CERT(IFICATE)?|REPORT)\b[\s:#.-]*/, '');
  s = s.replace(/[^A-Z0-9]/g, '');
  if (!s || /^(NA|NONE|NULL|0+)$/.test(s)) return null;
  return s;
}

/** Public report-lookup page for the labs that offer a stable deep link. */
export function certificateLookupUrl(lab: GradingLab, certNumber: string | null): string | null {
  if (!certNumber) return null;
  const n = encodeURIComponent(certNumber);
  switch (lab) {
    case 'GIA':
      return `https://www.gia.edu/report-check?reportno=${n}`;
    case 'IGI':
      return `https://www.igi.org/verify-your-report/?r=${n}`;
    default:
      return null;
  }
}

/** Trimmed absolute http(s) URL, upgraded to https; anything else is null. */
export function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  try {
    const url = new URL(s);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Parse "1,234.50", "$1234", 1234.5 … into a Decimal; null if not a finite number. */
export function toDecimal(raw: unknown): Prisma.Decimal | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Prisma.Decimal) return raw.isFinite() ? raw : null;
  const s = typeof raw === 'number' ? String(raw) : String(raw).replace(/[,$%\s]/g, '');
  if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const d = new Prisma.Decimal(s);
  return d.isFinite() ? d : null;
}

/** Positive Decimal rounded to `places`, or null. */
export function toPositiveDecimal(raw: unknown, places: number): Prisma.Decimal | null {
  const d = toDecimal(raw);
  if (!d || d.lte(0)) return null;
  return d.toDecimalPlaces(places, Prisma.Decimal.ROUND_HALF_UP);
}
