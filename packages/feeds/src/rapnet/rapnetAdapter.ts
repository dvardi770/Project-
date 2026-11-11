/**
 * RapNet → NormalizedDiamond.
 *
 * RapNet inventory reaches us in two forms: JSON records from the API and
 * CSV downloads. Column names differ between the two ("cert_num" vs
 * "Certificate #"), so fields are looked up through alias lists after
 * reducing every key to lower-case letters and digits.
 *
 * This module only parses and normalises; it does no I/O. Persist the result
 * with upsertDiamonds() from ../normalizer/diamondCacheWriter.
 */
import { Prisma, type Availability, type StoneOrigin } from '@jewelry/db';
import {
  certificateLookupUrl,
  normalizeClarity,
  normalizeColor,
  normalizeCutGrade,
  normalizeFluorescence,
  normalizeLab,
  normalizeShape,
  normalizeUrl,
  parseCertificateNumber,
  toDecimal,
  toPositiveDecimal,
} from '../normalizer/grading';
import type { NormalizedDiamond, RejectedRecord } from '../normalizer/types';

export type RapnetRecord = Record<string, unknown>;

export interface RapnetAdapterOptions {
  /** Used when a record does not say whether it is lab-grown. Default NATURAL. */
  defaultOrigin?: StoneOrigin;
  /** Used when a record carries no currency. Default USD. */
  defaultCurrency?: string;
}

export interface RapnetFeedResult {
  diamonds: NormalizedDiamond[];
  rejected: RejectedRecord[];
}

// ─── Field lookup ────────────────────────────────────────────────────────────

/** Aliases are written already reduced: lower-case, letters and digits only. */
const FIELDS = {
  diamondId: ['diamondid', 'rapnetid', 'rapnetdiamondid', 'lotid', 'id'],
  stockNumber: ['stocknum', 'stocknumber', 'stock', 'stockno', 'vendorstocknumber', 'sku'],
  sellerId: ['sellerid', 'selleraccountid', 'accountid', 'rapnetaccountid'],
  sellerName: ['sellercompany', 'sellercompanyname', 'sellername', 'seller', 'company', 'companyname', 'suppliername', 'supplier'],
  shape: ['shape'],
  carat: ['size', 'weight', 'carat', 'carats', 'caratweight'],
  color: ['color', 'colour'],
  clarity: ['clarity'],
  cut: ['cut', 'cutgrade'],
  polish: ['polish'],
  symmetry: ['symmetry', 'sym'],
  fluorescence: ['fluorintensity', 'fluorescenceintensity', 'fluorescence', 'fluor', 'flour'],
  lab: ['lab', 'certlab', 'gradinglab'],
  certNumber: ['certnum', 'certnumber', 'certificatenum', 'certificatenumber', 'certificate', 'cert', 'reportnumber', 'reportno'],
  certUrl: ['certfileurl', 'certificateurl', 'certfile', 'certificatefile', 'certurl'],
  totalPrice: ['totalsalesprice', 'totalprice', 'cashprice', 'totalcashprice', 'price'],
  pricePerCarat: ['pricepercarat', 'cashpricepercarat', 'ppc', 'pricect'],
  currency: ['currencycode', 'currency'],
  rapDiscount: ['rapnetdiscount', 'rapnetdiscountpercent', 'discountpercent', 'cashpricediscountpercent', 'discount', 'rapdiscount'],
  length: ['measlength', 'measurementslength', 'length'],
  width: ['measwidth', 'measurementswidth', 'width'],
  depth: ['measdepth', 'measurementsdepth', 'depth', 'height'],
  measurements: ['measurements', 'meas'],
  depthPercent: ['depthpercent', 'depthpct', 'totaldepth', 'totaldepthpercent'],
  tablePercent: ['tablepercent', 'tablepct', 'table'],
  girdleMin: ['girdlemin', 'girdlethin'],
  girdleMax: ['girdlemax', 'girdlethick'],
  girdle: ['girdle', 'girdlecondition'],
  culet: ['culetsize', 'culet'],
  fancyColor: ['fancycolordominantcolor', 'fancycolor', 'fancycolour'],
  fancyIntensity: ['fancycolorintensity', 'fancyintensity'],
  fancyOvertone: ['fancycolorovertone', 'fancyovertone', 'fancycolorsecondarycolor'],
  image: ['imagefileurl', 'imageurl', 'imagefile', 'image', 'diamondimage'],
  video: ['videourl', 'videofileurl', 'videolink', 'video', 'v360url'],
  country: ['country', 'countrycode', 'location'],
  availability: ['availability', 'status'],
  labGrown: ['labgrown', 'islabgrown', 'lab_grown', 'growntype', 'type', 'diamondtype'],
} as const;

type Field = keyof typeof FIELDS;

function reduceKey(k: string): string {
  // "Depth %" must not collide with "Depth" (mm).
  return k.toLowerCase().replace(/%/g, 'percent').replace(/[^a-z0-9]/g, '');
}

/** Flatten one level of nesting ("seller": { "company": … } → "sellercompany"). */
function indexRecord(record: RapnetRecord): Map<string, unknown> {
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(record)) {
    const rk = reduceKey(k);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v as RapnetRecord)) {
        const nested = rk + reduceKey(ck);
        if (!index.has(nested)) index.set(nested, cv);
      }
    } else if (!index.has(rk)) {
      index.set(rk, v);
    }
  }
  return index;
}

function pick(index: Map<string, unknown>, field: Field): unknown {
  for (const alias of FIELDS[field]) {
    const v = index.get(reduceKey(alias));
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function text(index: Map<string, unknown>, field: Field): string | null {
  const v = pick(index, field);
  return v === undefined ? null : String(v).trim();
}

// ─── Value mapping ───────────────────────────────────────────────────────────

const COUNTRY_CODES: Record<string, string> = {
  USA: 'US',
  UNITEDSTATES: 'US',
  INDIA: 'IN',
  ISRAEL: 'IL',
  BELGIUM: 'BE',
  HONGKONG: 'HK',
  UAE: 'AE',
  UNITEDARABEMIRATES: 'AE',
  UK: 'GB',
  UNITEDKINGDOM: 'GB',
  CHINA: 'CN',
  THAILAND: 'TH',
  CANADA: 'CA',
  SOUTHAFRICA: 'ZA',
};

function countryCode(raw: string | null): string | null {
  if (!raw) return null;
  const k = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (k.length === 2) return k;
  return COUNTRY_CODES[k] ?? null;
}

function mapOrigin(raw: unknown, fallback: StoneOrigin): StoneOrigin {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw ? 'LAB_GROWN' : 'NATURAL';
  const k = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (['TRUE', 'YES', 'Y', '1', 'LABGROWN', 'LAB', 'LGD', 'CVD', 'HPHT', 'SYNTHETIC', 'LABCREATED'].includes(k)) {
    return 'LAB_GROWN';
  }
  if (['FALSE', 'NO', 'N', '0', 'NATURAL', 'MINED', 'EARTHMINED'].includes(k)) return 'NATURAL';
  return fallback;
}

function mapAvailability(raw: string | null): Availability {
  if (!raw) return 'AVAILABLE';
  const k = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (['AVAILABLE', 'GUARANTEEDAVAILABLE', 'GA', 'A', 'INSTOCK'].includes(k)) return 'AVAILABLE';
  if (['ONHOLD', 'HOLD', 'MEMO', 'ONMEMO', 'M', 'OUTONMEMO'].includes(k)) return 'ON_HOLD';
  if (['SOLD', 'S'].includes(k)) return 'SOLD';
  return 'UNAVAILABLE';
}

/** "6.45 x 6.48 x 3.99", "6.45-6.48*3.99" → [6.45, 6.48, 3.99]. */
function splitMeasurements(raw: string | null): (Prisma.Decimal | null)[] {
  if (!raw) return [];
  return (raw.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((n) => toPositiveDecimal(n, 2));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalise one RapNet record. Throws with a readable reason when the record
 * has no usable identity, carat weight or price.
 */
export function normalizeRapnetRecord(
  record: RapnetRecord,
  options: RapnetAdapterOptions = {},
): NormalizedDiamond {
  const index = indexRecord(record);

  const diamondId = text(index, 'diamondId');
  const stockNumber = text(index, 'stockNumber');
  const sellerId = text(index, 'sellerId');
  // RapNet's own id is globally unique; a seller's stock number is not.
  const sourceStockId = diamondId ?? (stockNumber ? `${sellerId ?? 'unknown'}:${stockNumber}` : null);
  if (!sourceStockId) throw new Error('record has neither a diamond id nor a stock number');

  const carat = toPositiveDecimal(pick(index, 'carat'), 3);
  if (!carat) throw new Error(`invalid carat weight: ${String(pick(index, 'carat'))}`);

  let total = toPositiveDecimal(pick(index, 'totalPrice'), 2);
  let perCarat = toPositiveDecimal(pick(index, 'pricePerCarat'), 2);
  if (!total && perCarat) total = perCarat.mul(carat).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  if (!perCarat && total) perCarat = total.div(carat).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  if (!total || !perCarat) throw new Error('record has no usable price');

  const dims = splitMeasurements(text(index, 'measurements'));
  const length = toPositiveDecimal(pick(index, 'length'), 2) ?? dims[0] ?? null;
  const width = toPositiveDecimal(pick(index, 'width'), 2) ?? dims[1] ?? null;
  const depth = toPositiveDecimal(pick(index, 'depth'), 2) ?? dims[2] ?? null;

  const girdleMin = text(index, 'girdleMin');
  const girdleMax = text(index, 'girdleMax');
  const girdle =
    girdleMin && girdleMax && girdleMin !== girdleMax
      ? `${girdleMin} - ${girdleMax}`
      : (girdleMin ?? girdleMax ?? text(index, 'girdle'));

  const lab = normalizeLab(pick(index, 'lab'));
  const certificateNumber = parseCertificateNumber(pick(index, 'certNumber'));
  const rapDiscount = toDecimal(pick(index, 'rapDiscount'));
  const currency = (text(index, 'currency') ?? options.defaultCurrency ?? 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`invalid currency: ${currency}`);

  return {
    source: 'RAPNET',
    sourceStockId,
    supplierName: text(index, 'sellerName'),

    lab,
    certificateNumber,
    certificateUrl: normalizeUrl(pick(index, 'certUrl')) ?? certificateLookupUrl(lab, certificateNumber),

    origin: mapOrigin(pick(index, 'labGrown'), options.defaultOrigin ?? 'NATURAL'),
    shape: normalizeShape(pick(index, 'shape')),
    carat,
    color: normalizeColor(pick(index, 'color')),
    clarity: normalizeClarity(pick(index, 'clarity')),
    cut: normalizeCutGrade(pick(index, 'cut')),
    polish: normalizeCutGrade(pick(index, 'polish')),
    symmetry: normalizeCutGrade(pick(index, 'symmetry')),
    fluorescence: normalizeFluorescence(pick(index, 'fluorescence')),

    fancyColor: text(index, 'fancyColor'),
    fancyIntensity: text(index, 'fancyIntensity'),
    fancyOvertone: text(index, 'fancyOvertone'),

    lengthMm: length,
    widthMm: width,
    depthMm: depth,
    lwRatio: length && width ? length.div(width).toDecimalPlaces(2) : null,
    depthPercent: toPositiveDecimal(pick(index, 'depthPercent'), 2),
    tablePercent: toPositiveDecimal(pick(index, 'tablePercent'), 2),
    girdle,
    culet: text(index, 'culet'),

    wholesalePrice: total,
    pricePerCarat: perCarat,
    currency,
    rapDiscountPct: rapDiscount ? rapDiscount.toDecimalPlaces(2) : null,

    imageUrl: normalizeUrl(pick(index, 'image')),
    videoUrl: normalizeUrl(pick(index, 'video')),
    locationCountry: countryCode(text(index, 'country')),
    deliveryDays: null,
    availability: mapAvailability(text(index, 'availability')),

    raw: record as Prisma.InputJsonValue,
  };
}

/** Normalise a batch; bad records are collected instead of aborting the feed. */
export function normalizeRapnetFeed(
  records: readonly RapnetRecord[],
  options: RapnetAdapterOptions = {},
): RapnetFeedResult {
  const diamonds: NormalizedDiamond[] = [];
  const rejected: RejectedRecord[] = [];
  for (const record of records) {
    try {
      diamonds.push(normalizeRapnetRecord(record, options));
    } catch (err) {
      rejected.push({ reason: (err as Error).message, record });
    }
  }
  return { diamonds, rejected };
}

/**
 * Parse a RapNet CSV download (RFC 4180: quoted fields, doubled quotes,
 * embedded newlines) into records keyed by the header row.
 */
export function parseRapnetCsv(csv: string): RapnetRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = csv.replace(/^﻿/, '');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i]?.trim() ?? ''])));
}

/** Convenience: CSV text straight to normalised diamonds. */
export function normalizeRapnetCsv(csv: string, options: RapnetAdapterOptions = {}): RapnetFeedResult {
  return normalizeRapnetFeed(parseRapnetCsv(csv), options);
}
