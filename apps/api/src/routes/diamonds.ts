/**
 * GET /api/v1/diamonds — storefront diamond search.
 *
 * Searches two inventories as one list: the wholesale feed cache and the
 * jeweler's own uploaded stones.
 *
 * Shoppers filter and sort on the *retail* price, which differs per tenant.
 * The tenant's markup matrix is therefore compiled into a SQL CASE expression
 * (one branch per rule, in rule-rank order) so Postgres filters, sorts and
 * paginates on the exact retail price. The query touches only the columns in
 * diamond_cache_search_idx, finds one page of ids, and full rows are then
 * fetched for just that page. The prices returned are computed by the pricing
 * engine itself, which stays the single source of truth.
 *
 * Results are cached in Redis, keyed by inventory epoch, tenant, feed access,
 * matrix version and the normalised query, so a markup change or a sold stone
 * invalidates them automatically.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CutGrade,
  DiamondClarity,
  DiamondColor,
  DiamondShape,
  GradingLab,
  Prisma,
  StoneOrigin,
  type CustomMerchantStock,
  type DiamondCache,
  type FeedSource,
  type MarkupRule,
  type MarkupTarget,
} from '@jewelry/db';
import { compareMarkupRules } from '@jewelry/pricing';
import { z } from 'zod';
import { inventoryEpoch, singleFlight } from '../common/cache';
import type { AppDeps } from '../common/context';
import { badRequest } from '../common/errors';
import { csvEnum, pagination, upperEnum, type Money } from '../common/query';
import { priceFeedDiamond, priceMerchantStone, type StonePrice, type StoneSource } from '../common/stones';

const { sql, join, raw } = Prisma;

const SORTS = {
  price_asc: raw('c."retailPrice" ASC, c."id" ASC'),
  price_desc: raw('c."retailPrice" DESC, c."id" ASC'),
  carat_asc: raw('c."carat" ASC, c."id" ASC'),
  carat_desc: raw('c."carat" DESC, c."id" ASC'),
} as const;

const Inventory = { FEED: 'FEED', MERCHANT: 'MERCHANT' } as const;

const querySchema = z.object({
  shape: csvEnum(DiamondShape),
  origin: upperEnum(StoneOrigin).optional(),
  caratMin: z.coerce.number().min(0).max(100).optional(),
  caratMax: z.coerce.number().min(0).max(100).optional(),
  /** Retail price bounds, in the tenant's prices. */
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  cut: csvEnum(CutGrade),
  clarity: csvEnum(DiamondClarity),
  color: csvEnum(DiamondColor),
  lab: csvEnum(GradingLab),
  /** Which inventories to search. Default: both. */
  inventory: csvEnum(Inventory),
  sort: z.enum(['price_asc', 'price_desc', 'carat_asc', 'carat_desc']).default('price_asc'),
  ...pagination,
});

type DiamondQuery = z.infer<typeof querySchema>;

/** What a storefront sees. Wholesale cost and supplier identity never leave the server. */
export interface DiamondDto {
  id: string;
  /** FEED = virtual wholesale inventory, MERCHANT = the jeweler's own stock. */
  inventory: StoneSource;
  origin: StoneOrigin;
  shape: DiamondShape;
  carat: number;
  color: DiamondColor | null;
  clarity: DiamondClarity | null;
  cut: CutGrade | null;
  polish: CutGrade | null;
  symmetry: CutGrade | null;
  fluorescence: string | null;
  fancyColor: string | null;
  fancyIntensity: string | null;
  lab: GradingLab;
  certificateNumber: string | null;
  certificateUrl: string | null;
  measurements: { lengthMm: number | null; widthMm: number | null; depthMm: number | null; lwRatio: number | null };
  depthPercent: number | null;
  tablePercent: number | null;
  imageUrl: string | null;
  videoUrl: string | null;
  deliveryDays: number | null;
  price: Money;
}

/**
 * Counting every match of a broad search costs a second full scan, and no
 * shopper pages that far. Totals are exact up to this many and capped beyond.
 */
const TOTAL_CAP = 10_000;

interface SearchResult {
  data: DiamondDto[];
  total: number;
  /** True when there are more than TOTAL_CAP matches; show it as "10,000+". */
  totalCapped: boolean;
  hasMore: boolean;
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());
const money = (p: StonePrice): Money => ({ amount: p.retailPrice.toFixed(2), currency: p.currency });

function feedDto(d: DiamondCache, price: StonePrice): DiamondDto {
  return {
    id: d.id,
    inventory: 'FEED',
    origin: d.origin,
    shape: d.shape,
    carat: d.carat.toNumber(),
    color: d.color,
    clarity: d.clarity,
    cut: d.cut,
    polish: d.polish,
    symmetry: d.symmetry,
    fluorescence: d.fluorescence,
    fancyColor: d.fancyColor,
    fancyIntensity: d.fancyIntensity,
    lab: d.lab,
    certificateNumber: d.certificateNumber,
    certificateUrl: d.certificateUrl,
    measurements: { lengthMm: num(d.lengthMm), widthMm: num(d.widthMm), depthMm: num(d.depthMm), lwRatio: num(d.lwRatio) },
    depthPercent: num(d.depthPercent),
    tablePercent: num(d.tablePercent),
    imageUrl: d.imageUrl,
    videoUrl: d.videoUrl,
    deliveryDays: d.deliveryDays,
    price: money(price),
  };
}

function merchantDto(m: CustomMerchantStock, price: StonePrice): DiamondDto | null {
  if (!m.shape || !m.carat || !m.origin) return null;
  const lwRatio = m.lengthMm && m.widthMm && m.widthMm.gt(0) ? m.lengthMm.div(m.widthMm).toDecimalPlaces(2) : null;
  return {
    id: m.id,
    inventory: 'MERCHANT',
    origin: m.origin,
    shape: m.shape,
    carat: m.carat.toNumber(),
    color: m.color,
    clarity: m.clarity,
    cut: m.cut,
    polish: m.polish,
    symmetry: m.symmetry,
    fluorescence: m.fluorescence,
    fancyColor: null,
    fancyIntensity: null,
    lab: m.lab ?? 'NONE',
    certificateNumber: m.certificateNumber,
    certificateUrl: m.certificateUrl,
    measurements: { lengthMm: num(m.lengthMm), widthMm: num(m.widthMm), depthMm: num(m.depthMm), lwRatio: num(lwRatio) },
    depthPercent: null,
    tablePercent: null,
    imageUrl: m.imageUrls[0] ?? null,
    videoUrl: m.videoUrl,
    deliveryDays: 0, // already in the jeweler's hands
    price: money(price),
  };
}

// ─── Markup matrix → SQL ─────────────────────────────────────────────────────

/** Column expressions for the table a rule is evaluated against. */
interface PricedColumns {
  currency: Prisma.Sql;
  origin: Prisma.Sql;
  carat: Prisma.Sql;
  cost: Prisma.Sql;
  /** Null for merchant stock, which has no feed source. */
  feedSource: Prisma.Sql | null;
}

const FEED_COLUMNS: PricedColumns = {
  currency: raw('d."currency"'),
  origin: raw('d."origin"'),
  carat: raw('d."carat"'),
  cost: raw('d."wholesalePrice"'),
  feedSource: raw('d."source"'),
};

const MERCHANT_COLUMNS: PricedColumns = {
  currency: raw('m."currency"'),
  origin: raw('m."origin"'),
  carat: raw('m."carat"'),
  cost: raw('m."costPrice"'),
  feedSource: null,
};

/** The same test selectMarkupRule() applies, as a SQL predicate. Null = can never match. */
function ruleMatches(rule: MarkupRule, col: PricedColumns): Prisma.Sql | null {
  const conditions = [sql`${col.currency} = ${rule.currency.toUpperCase()}`];
  if (rule.feedSource) {
    if (!col.feedSource) return null;
    conditions.push(sql`${col.feedSource} = ${rule.feedSource}::"FeedSource"`);
  }
  if (rule.origin) conditions.push(sql`${col.origin} = ${rule.origin}::"StoneOrigin"`);
  if (rule.caratMin) conditions.push(sql`${col.carat} >= ${rule.caratMin.toString()}::numeric`);
  if (rule.caratMax) conditions.push(sql`${col.carat} < ${rule.caratMax.toString()}::numeric`);
  if (rule.costMin) conditions.push(sql`${col.cost} >= ${rule.costMin.toString()}::numeric`);
  if (rule.costMax) conditions.push(sql`${col.cost} < ${rule.costMax.toString()}::numeric`);
  return join(conditions, ' AND ');
}

/** cost × (1 + pct/100) + fixed, then the rule's rounding. */
function rulePrice(rule: MarkupRule, col: PricedColumns): Prisma.Sql {
  const multiplier = rule.markupPercent.div(100).plus(1).toString();
  const base = sql`(${col.cost} * ${multiplier}::numeric + ${rule.fixedAddition.toString()}::numeric)`;
  switch (rule.rounding) {
    case 'NEAREST_1':
      return sql`round(${base})`;
    case 'NEAREST_10':
      return sql`round(${base} / 10) * 10`;
    case 'NEAREST_100':
      return sql`round(${base} / 100) * 100`;
    case 'ENDING_99':
      return sql`floor(${base}) + 0.99`;
    default:
      return sql`round(${base}, 2)`;
  }
}

/** CASE picks the first matching branch, so branch order is rule rank. Null = no rule can apply. */
function retailPriceExpression(rules: MarkupRule[], target: MarkupTarget, col: PricedColumns): Prisma.Sql | null {
  const branches: Prisma.Sql[] = [];
  for (const rule of rules.filter((r) => r.isActive && r.target === target).sort(compareMarkupRules)) {
    const when = ruleMatches(rule, col);
    if (when) branches.push(sql`WHEN ${when} THEN ${rulePrice(rule, col)}`);
  }
  return branches.length ? sql`CASE ${join(branches, ' ')} END` : null;
}

// ─── Search ──────────────────────────────────────────────────────────────────

function enumList(values: readonly string[], type: string) {
  return sql`ANY(${[...values]}::${raw(`"${type}"`)}[])`;
}

/** Filters shared by both inventories; `t` is the table alias. */
function gradeFilters(query: DiamondQuery, t: string): Prisma.Sql[] {
  const c = (name: string) => raw(`${t}."${name}"`);
  const where: Prisma.Sql[] = [];
  if (query.origin) where.push(sql`${c('origin')} = ${query.origin}::"StoneOrigin"`);
  if (query.shape) where.push(sql`${c('shape')} = ${enumList(query.shape, 'DiamondShape')}`);
  if (query.cut) where.push(sql`${c('cut')} = ${enumList(query.cut, 'CutGrade')}`);
  if (query.clarity) where.push(sql`${c('clarity')} = ${enumList(query.clarity, 'DiamondClarity')}`);
  if (query.color) where.push(sql`${c('color')} = ${enumList(query.color, 'DiamondColor')}`);
  if (query.lab) where.push(sql`${c('lab')} = ${enumList(query.lab, 'GradingLab')}`);
  if (query.caratMin !== undefined) where.push(sql`${c('carat')} >= ${query.caratMin}::numeric`);
  if (query.caratMax !== undefined) where.push(sql`${c('carat')} <= ${query.caratMax}::numeric`);
  return where;
}

async function searchDiamonds(
  deps: AppDeps,
  query: DiamondQuery,
  scope: { tenantId: string; feedSources: FeedSource[] },
  rules: MarkupRule[],
): Promise<SearchResult> {
  const wanted = query.inventory ?? ['FEED', 'MERCHANT'];
  const sources: Prisma.Sql[] = [];

  // Feed stones: only columns covered by diamond_cache_search_idx.
  const feedRetail = retailPriceExpression(rules, 'FEED_DIAMOND', FEED_COLUMNS);
  if (wanted.includes('FEED') && feedRetail && scope.feedSources.length > 0) {
    const where = [
      sql`d."availability" = 'AVAILABLE'`,
      sql`d."source" = ${enumList(scope.feedSources, 'FeedSource')}`,
      ...gradeFilters(query, 'd'),
    ];
    sources.push(sql`
      SELECT 'FEED' AS "inventory", d."id", d."carat", ${feedRetail} AS "retailPrice"
      FROM "diamond_cache" d
      WHERE ${join(where, ' AND ')}`);
  }

  // The jeweler's own stones: an explicit retail price wins over markup rules.
  if (wanted.includes('MERCHANT')) {
    const markedUp = retailPriceExpression(rules, 'MERCHANT_STONE', MERCHANT_COLUMNS);
    const explicit = sql`CASE WHEN m."retailPrice" > 0 THEN round(m."retailPrice", 2) END`;
    const retail = markedUp
      ? sql`COALESCE(${explicit}, CASE WHEN m."costPrice" > 0 THEN ${markedUp} END)`
      : explicit;
    const where = [
      sql`m."tenantId" = ${scope.tenantId}::uuid`,
      sql`m."stockType" = 'STONE'`,
      sql`m."availability" = 'AVAILABLE'`,
      sql`m."quantity" > 0`,
      sql`m."shape" IS NOT NULL AND m."carat" IS NOT NULL AND m."origin" IS NOT NULL`,
      ...gradeFilters(query, 'm'),
    ];
    sources.push(sql`
      SELECT 'MERCHANT' AS "inventory", m."id", m."carat", ${retail} AS "retailPrice"
      FROM "custom_merchant_stock" m
      WHERE ${join(where, ' AND ')}`);
  }

  if (sources.length === 0) return { data: [], total: 0, totalCapped: false, hasMore: false };

  const priced = [sql`c."retailPrice" IS NOT NULL`]; // NULL = no rule matched = not for sale
  if (query.priceMin !== undefined) priced.push(sql`c."retailPrice" >= ${query.priceMin}::numeric`);
  if (query.priceMax !== undefined) priced.push(sql`c."retailPrice" <= ${query.priceMax}::numeric`);
  const from = sql`FROM (${join(sources, ' UNION ALL ')}) c WHERE ${join(priced, ' AND ')}`;

  const offset = (query.page - 1) * query.limit;
  const [page, counted] = await Promise.all([
    deps.db.$queryRaw<{ inventory: StoneSource; id: string }[]>(sql`
      SELECT c."inventory", c."id" ${from}
      ORDER BY ${SORTS[query.sort]}
      LIMIT ${query.limit} OFFSET ${offset}`),
    deps.db.$queryRaw<{ total: number }[]>(
      sql`SELECT COUNT(*)::int AS total FROM (SELECT 1 ${from} LIMIT ${TOTAL_CAP + 1}) capped`,
    ),
  ]);

  // Full rows for this page only.
  const idsOf = (inventory: StoneSource) => page.filter((r) => r.inventory === inventory).map((r) => r.id);
  const [feedRows, merchantRows] = await Promise.all([
    idsOf('FEED').length ? deps.db.diamondCache.findMany({ where: { id: { in: idsOf('FEED') } } }) : [],
    idsOf('MERCHANT').length
      ? deps.db.customMerchantStock.findMany({ where: { id: { in: idsOf('MERCHANT') }, tenantId: scope.tenantId } })
      : [],
  ]);
  const feedById = new Map(feedRows.map((r) => [r.id, r]));
  const merchantById = new Map(merchantRows.map((r) => [r.id, r]));

  const data: DiamondDto[] = [];
  for (const ref of page) {
    let dto: DiamondDto | null = null;
    if (ref.inventory === 'FEED') {
      const row = feedById.get(ref.id);
      const price = row && priceFeedDiamond(row, rules);
      if (row && price) dto = feedDto(row, price);
    } else {
      const row = merchantById.get(ref.id);
      const price = row && priceMerchantStone(row, rules);
      if (row && price) dto = merchantDto(row, price);
    }
    if (dto) data.push(dto);
  }
  const counted_ = counted[0]?.total ?? 0;
  const totalCapped = counted_ > TOTAL_CAP;
  return {
    data,
    total: Math.min(counted_, TOTAL_CAP),
    totalCapped,
    hasMore: totalCapped ? page.length === query.limit : offset + page.length < counted_,
  };
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function diamondRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/diamonds', async (request, reply) => {
    const query = querySchema.parse(request.query);
    if (query.caratMin !== undefined && query.caratMax !== undefined && query.caratMin > query.caratMax) {
      throw badRequest('invalid_range', 'caratMin must not exceed caratMax');
    }
    if (query.priceMin !== undefined && query.priceMax !== undefined && query.priceMin > query.priceMax) {
      throw badRequest('invalid_range', 'priceMin must not exceed priceMax');
    }

    const { tenantId, feedSources } = request.tenant;
    const [matrix, epoch] = await Promise.all([deps.markupMatrix(tenantId), inventoryEpoch(deps.cache)]);

    // Key order is fixed by the schema, so equal queries serialise identically.
    // Merchant stock is private, so entries are never shared between tenants.
    const digest = createHash('sha1')
      .update(JSON.stringify({ ...query, shape: query.shape?.slice().sort(), cut: query.cut?.slice().sort(), clarity: query.clarity?.slice().sort(), color: query.color?.slice().sort(), lab: query.lab?.slice().sort(), inventory: query.inventory?.slice().sort() }))
      .digest('hex');
    const cacheKey = `diamonds:v3:${epoch}:${tenantId}:${[...feedSources].sort().join('+')}:${matrix.version}:${digest}`;

    let result = await deps.cache.get<SearchResult>(cacheKey);
    reply.header('x-cache', result ? 'HIT' : 'MISS');
    if (!result) {
      result = await singleFlight(cacheKey, async () => {
        const fresh = await searchDiamonds(deps, query, { tenantId, feedSources }, matrix.rules);
        await deps.cache.set(cacheKey, fresh, deps.config.searchCacheTtlSeconds);
        return fresh;
      });
    }

    return {
      data: result.data,
      page: query.page,
      limit: query.limit,
      total: result.total,
      totalCapped: result.totalCapped,
      hasMore: result.hasMore,
    };
  });
}
