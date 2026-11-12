/**
 * One place that knows how a centre stone is priced and described, whichever
 * table it lives in: the wholesale feed cache or the jeweler's own stock.
 */
import type { CustomMerchantStock, DiamondCache, FeedSource, MarkupRule, Prisma, PrismaClient } from '@jewelry/db';
import { calculateRetailPrice } from '@jewelry/pricing';

export type StoneSource = 'FEED' | 'MERCHANT';

export interface StonePrice {
  retailPrice: Prisma.Decimal;
  currency: string;
  /** Null when the merchant set the retail price directly. */
  ruleId: string | null;
}

export function priceFeedDiamond(d: DiamondCache, rules: readonly MarkupRule[]): StonePrice | null {
  const priced = calculateRetailPrice(
    {
      wholesalePrice: d.wholesalePrice,
      currency: d.currency,
      carat: d.carat,
      origin: d.origin,
      feedSource: d.source,
      target: 'FEED_DIAMOND',
    },
    rules,
  );
  return priced && { retailPrice: priced.retailPrice, currency: priced.currency, ruleId: priced.rule.id };
}

/** An explicit retailPrice wins; otherwise MERCHANT_STONE rules mark up the cost. */
export function priceMerchantStone(m: CustomMerchantStock, rules: readonly MarkupRule[]): StonePrice | null {
  if (m.retailPrice && m.retailPrice.gt(0)) {
    return { retailPrice: m.retailPrice.toDecimalPlaces(2), currency: m.currency, ruleId: null };
  }
  if (!m.costPrice || m.costPrice.lte(0)) return null;
  const priced = calculateRetailPrice(
    { wholesalePrice: m.costPrice, currency: m.currency, carat: m.carat, origin: m.origin, target: 'MERCHANT_STONE' },
    rules,
  );
  return priced && { retailPrice: priced.retailPrice, currency: priced.currency, ruleId: priced.rule.id };
}

/** A centre stone from either table, reduced to what bundles and orders need. */
export interface Stone {
  source: StoneSource;
  id: string;
  available: boolean;
  shape: DiamondCache['shape'];
  carat: Prisma.Decimal;
  origin: DiamondCache['origin'];
  color: DiamondCache['color'];
  clarity: DiamondCache['clarity'];
  cut: DiamondCache['cut'];
  lab: DiamondCache['lab'];
  certificateNumber: string | null;
  imageUrl: string | null;
  /** What the stone costs the jeweler; null if a merchant stone has no cost recorded. */
  cost: Prisma.Decimal | null;
  price: StonePrice | null;
}

export async function loadStone(
  db: PrismaClient,
  scope: { tenantId: string; feedSources: FeedSource[] },
  source: StoneSource,
  id: string,
  rules: readonly MarkupRule[],
): Promise<Stone | null> {
  if (source === 'FEED') {
    const d = await db.diamondCache.findFirst({ where: { id, source: { in: scope.feedSources } } });
    if (!d) return null;
    return {
      source,
      id: d.id,
      available: d.availability === 'AVAILABLE',
      shape: d.shape,
      carat: d.carat,
      origin: d.origin,
      color: d.color,
      clarity: d.clarity,
      cut: d.cut,
      lab: d.lab,
      certificateNumber: d.certificateNumber,
      imageUrl: d.imageUrl,
      cost: d.wholesalePrice,
      price: priceFeedDiamond(d, rules),
    };
  }
  const m = await db.customMerchantStock.findFirst({ where: { id, tenantId: scope.tenantId, stockType: 'STONE' } });
  if (!m || !m.shape || !m.carat || !m.origin) return null;
  return {
    source,
    id: m.id,
    available: m.availability === 'AVAILABLE' && m.quantity > 0,
    shape: m.shape,
    carat: m.carat,
    origin: m.origin,
    color: m.color,
    clarity: m.clarity,
    cut: m.cut,
    lab: m.lab ?? 'NONE',
    certificateNumber: m.certificateNumber,
    imageUrl: m.imageUrls[0] ?? null,
    cost: m.costPrice,
    price: priceMerchantStone(m, rules),
  };
}
