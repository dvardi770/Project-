/**
 * Retail pricing.
 *
 *   retail = wholesale × (1 + markupPercent / 100) + fixedAddition
 *
 * markupPercent is stored as a percentage (35 = +35 %), so the multiplier
 * applied to the wholesale price is 1.35. The result is then rounded as the
 * rule dictates. All arithmetic is decimal — no floating point touches money.
 *
 * calculateRetailPrice() is pure. getRetailPrice() and createTenantPricer()
 * add the database lookup of the tenant's active markup matrix.
 */
import {
  Prisma,
  type FeedSource,
  type MarkupRule,
  type MarkupTarget,
  type PriceRounding,
  type PrismaClient,
  type StoneOrigin,
} from '@jewelry/db';

type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The fields of MarkupRule the engine reads. A full MarkupRule row satisfies it. */
export type MarkupRuleInput = Pick<
  MarkupRule,
  | 'id'
  | 'name'
  | 'isActive'
  | 'priority'
  | 'target'
  | 'feedSource'
  | 'origin'
  | 'caratMin'
  | 'caratMax'
  | 'costMin'
  | 'costMax'
  | 'markupPercent'
  | 'fixedAddition'
  | 'currency'
  | 'rounding'
  | 'createdAt'
>;

export interface PriceableItem {
  /** Wholesale cost of the item. */
  wholesalePrice: Prisma.Decimal.Value;
  /** ISO-4217 code of wholesalePrice. Default USD. */
  currency?: string;
  /** What is being priced. Default FEED_DIAMOND. */
  target?: MarkupTarget;
  carat?: Prisma.Decimal.Value | null;
  origin?: StoneOrigin | null;
  feedSource?: FeedSource | null;
}

export interface RetailPrice {
  retailPrice: Decimal;
  wholesalePrice: Decimal;
  currency: string;
  /** retailPrice − wholesalePrice. */
  markupAmount: Decimal;
  /** Price before the rule's rounding step. */
  unroundedPrice: Decimal;
  rule: {
    id: string;
    name: string;
    markupPercent: Decimal;
    fixedAddition: Decimal;
    rounding: PriceRounding;
  };
}

// ─── Rule selection ──────────────────────────────────────────────────────────

/** Half-open range test: min ≤ value < max; a null bound is unbounded. */
function inRange(value: Decimal | null, min: Decimal | null, max: Decimal | null): boolean {
  if (min === null && max === null) return true;
  if (value === null) return false; // the rule needs a value the item lacks
  if (min !== null && value.lt(min)) return false;
  if (max !== null && value.gte(max)) return false;
  return true;
}

/** How many optional criteria a rule pins down; used to break priority ties. */
function specificity(rule: MarkupRuleInput): number {
  return (
    Number(rule.feedSource !== null) +
    Number(rule.origin !== null) +
    Number(rule.caratMin !== null || rule.caratMax !== null) +
    Number(rule.costMin !== null || rule.costMax !== null)
  );
}

/**
 * Pick the rule that prices this item: highest priority first, then the most
 * specific rule, then the oldest (so the outcome never depends on row order).
 * Returns null when no active rule matches.
 */
export function selectMarkupRule(
  item: PriceableItem,
  rules: readonly MarkupRuleInput[],
): MarkupRuleInput | null {
  const cost = new Decimal(item.wholesalePrice);
  const carat = item.carat === null || item.carat === undefined ? null : new Decimal(item.carat);
  const currency = (item.currency ?? 'USD').toUpperCase();
  const target = item.target ?? 'FEED_DIAMOND';

  const matches = rules.filter(
    (rule) =>
      rule.isActive &&
      rule.target === target &&
      // fixedAddition is denominated in the rule's currency
      rule.currency.toUpperCase() === currency &&
      (rule.feedSource === null || rule.feedSource === (item.feedSource ?? null)) &&
      (rule.origin === null || rule.origin === (item.origin ?? null)) &&
      inRange(carat, rule.caratMin, rule.caratMax) &&
      inRange(cost, rule.costMin, rule.costMax),
  );

  matches.sort(
    (a, b) =>
      b.priority - a.priority ||
      specificity(b) - specificity(a) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return matches[0] ?? null;
}

// ─── Arithmetic ──────────────────────────────────────────────────────────────

function roundToStep(amount: Decimal, step: number): Decimal {
  return amount.div(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(step);
}

export function applyRounding(amount: Decimal, rounding: PriceRounding): Decimal {
  switch (rounding) {
    case 'NEAREST_1':
      return roundToStep(amount, 1);
    case 'NEAREST_10':
      return roundToStep(amount, 10);
    case 'NEAREST_100':
      return roundToStep(amount, 100);
    case 'ENDING_99':
      // 1234.00 → 1234.99, 1234.50 → 1234.99
      return amount.floor().plus('0.99');
    case 'NONE':
    default:
      return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
}

/** wholesale × (1 + markupPercent / 100) + fixedAddition, before rounding. */
export function applyMarkup(
  wholesalePrice: Prisma.Decimal.Value,
  markupPercent: Prisma.Decimal.Value,
  fixedAddition: Prisma.Decimal.Value = 0,
): Decimal {
  const multiplier = new Decimal(markupPercent).div(100).plus(1);
  return new Decimal(wholesalePrice).mul(multiplier).plus(fixedAddition);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Price one item against an already-loaded markup matrix.
 *
 * Returns null when no rule matches. Callers should treat that as "not for
 * sale" and hide the item — falling back to the wholesale price would sell
 * stock at cost.
 */
export function calculateRetailPrice(
  item: PriceableItem,
  rules: readonly MarkupRuleInput[],
): RetailPrice | null {
  const wholesalePrice = new Decimal(item.wholesalePrice);
  if (!wholesalePrice.isFinite() || wholesalePrice.lte(0)) {
    throw new RangeError(`wholesalePrice must be a positive amount, got ${String(item.wholesalePrice)}`);
  }

  const rule = selectMarkupRule(item, rules);
  if (!rule) return null;

  const unroundedPrice = applyMarkup(wholesalePrice, rule.markupPercent, rule.fixedAddition);
  const retailPrice = applyRounding(unroundedPrice, rule.rounding);

  return {
    retailPrice,
    wholesalePrice,
    currency: (item.currency ?? 'USD').toUpperCase(),
    markupAmount: retailPrice.minus(wholesalePrice),
    unroundedPrice,
    rule: {
      id: rule.id,
      name: rule.name,
      markupPercent: rule.markupPercent,
      fixedAddition: rule.fixedAddition,
      rounding: rule.rounding,
    },
  };
}

export type MarkupRuleDb = Pick<PrismaClient, 'markupRule'>;

/** Load a tenant's active markup matrix, best rule first. */
export async function loadMarkupMatrix(
  db: MarkupRuleDb,
  tenantId: string,
  target?: MarkupTarget,
): Promise<MarkupRule[]> {
  return db.markupRule.findMany({
    where: { tenantId, isActive: true, ...(target ? { target } : {}) },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });
}

/**
 * Look up the merchant's active markup matrix and price a single item.
 * For lists, use createTenantPricer() so the matrix is read only once.
 */
export async function getRetailPrice(
  db: MarkupRuleDb,
  tenantId: string,
  item: PriceableItem,
): Promise<RetailPrice | null> {
  const rules = await loadMarkupMatrix(db, tenantId, item.target ?? 'FEED_DIAMOND');
  return calculateRetailPrice(item, rules);
}

/** Load the matrix once and return a synchronous pricer for search results. */
export async function createTenantPricer(
  db: MarkupRuleDb,
  tenantId: string,
): Promise<(item: PriceableItem) => RetailPrice | null> {
  const rules = await loadMarkupMatrix(db, tenantId);
  return (item) => calculateRetailPrice(item, rules);
}
