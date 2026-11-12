/**
 * GET /api/v1/diamonds — storefront diamond search.
 *
 * Shoppers filter and sort on the *retail* price, which differs per tenant.
 * The tenant's markup matrix is therefore compiled into a SQL CASE expression
 * (one branch per rule, in rule-rank order) so Postgres filters, sorts and
 * paginates on the exact retail price. The prices returned are then computed
 * by the pricing engine itself, which stays the single source of truth.
 *
 * Results are cached in Redis, keyed by feed access, matrix version and the
 * normalised query, so tenants with identical pricing share entries and a
 * markup change invalidates them automatically.
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
  type FeedSource,
  type MarkupRule,
} from '@jewelry/db';
import { calculateRetailPrice, compareMarkupRules } from '@jewelry/pricing';
import { z } from 'zod';
import type { AppDeps } from '../common/context';
import { badRequest } from '../common/errors';
import { csvEnum, pagination, upperEnum, type Money } from '../common/query';

const { sql, join, empty, raw } = Prisma;

const SORTS = {
  price_asc: raw('p."retailPrice" ASC, p."id" ASC'),
  price_desc: raw('p."retailPrice" DESC, p."id" ASC'),
  carat_asc: raw('p."carat" ASC, p."id" ASC'),
  carat_desc: raw('p."carat" DESC, p."id" ASC'),
} as const;

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
  sort: z.enum(['price_asc', 'price_desc', 'carat_asc', 'carat_desc']).default('price_asc'),
  ...pagination,
});

type DiamondQuery = z.infer<typeof querySchema>;

interface DiamondRow {
  id: string;
  source: FeedSource;
  origin: StoneOrigin;
  shape: DiamondShape;
  carat: Prisma.Decimal;
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
  lengthMm: Prisma.Decimal | null;
  widthMm: Prisma.Decimal | null;
  depthMm: Prisma.Decimal | null;
  lwRatio: Prisma.Decimal | null;
  depthPercent: Prisma.Decimal | null;
  tablePercent: Prisma.Decimal | null;
  imageUrl: string | null;
  videoUrl: string | null;
  deliveryDays: number | null;
  wholesalePrice: Prisma.Decimal;
  currency: string;
}

/** What a storefront sees. Wholesale cost and supplier identity never leave the server. */
export interface DiamondDto {
  id: string;
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

interface SearchResult {
  data: DiamondDto[];
  total: number;
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

// ─── Markup matrix → SQL ─────────────────────────────────────────────────────

/** The same test selectMarkupRule() applies, as a predicate on diamond_cache. */
function ruleMatches(rule: MarkupRule) {
  const conditions = [sql`d."currency" = ${rule.currency.toUpperCase()}`];
  if (rule.feedSource) conditions.push(sql`d."source" = ${rule.feedSource}::"FeedSource"`);
  if (rule.origin) conditions.push(sql`d."origin" = ${rule.origin}::"StoneOrigin"`);
  if (rule.caratMin) conditions.push(sql`d."carat" >= ${rule.caratMin.toString()}::numeric`);
  if (rule.caratMax) conditions.push(sql`d."carat" < ${rule.caratMax.toString()}::numeric`);
  if (rule.costMin) conditions.push(sql`d."wholesalePrice" >= ${rule.costMin.toString()}::numeric`);
  if (rule.costMax) conditions.push(sql`d."wholesalePrice" < ${rule.costMax.toString()}::numeric`);
  return join(conditions, ' AND ');
}

/** wholesale × (1 + pct/100) + fixed, then the rule's rounding. */
function rulePrice(rule: MarkupRule) {
  const multiplier = rule.markupPercent.div(100).plus(1).toString();
  const base = sql`(d."wholesalePrice" * ${multiplier}::numeric + ${rule.fixedAddition.toString()}::numeric)`;
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

/** CASE picks the first matching branch, so branch order is rule rank. */
function retailPriceExpression(rules: MarkupRule[]) {
  const ranked = rules.filter((r) => r.isActive && r.target === 'FEED_DIAMOND').sort(compareMarkupRules);
  if (ranked.length === 0) return null;
  const branches = ranked.map((r) => sql`WHEN ${ruleMatches(r)} THEN ${rulePrice(r)}`);
  return sql`CASE ${join(branches, ' ')} END`;
}

// ─── Search ──────────────────────────────────────────────────────────────────

function enumList(values: readonly string[], type: string) {
  return sql`ANY(${[...values]}::${raw(`"${type}"`)}[])`;
}

async function searchDiamonds(
  deps: AppDeps,
  query: DiamondQuery,
  feedSources: FeedSource[],
  rules: MarkupRule[],
): Promise<SearchResult> {
  const retail = retailPriceExpression(rules);
  // No pricing rules, or no feed access: nothing is for sale.
  if (!retail || feedSources.length === 0) return { data: [], total: 0 };

  const where = [
    sql`d."availability" = 'AVAILABLE'`,
    sql`d."source" = ${enumList(feedSources, 'FeedSource')}`,
  ];
  if (query.origin) where.push(sql`d."origin" = ${query.origin}::"StoneOrigin"`);
  if (query.shape) where.push(sql`d."shape" = ${enumList(query.shape, 'DiamondShape')}`);
  if (query.cut) where.push(sql`d."cut" = ${enumList(query.cut, 'CutGrade')}`);
  if (query.clarity) where.push(sql`d."clarity" = ${enumList(query.clarity, 'DiamondClarity')}`);
  if (query.color) where.push(sql`d."color" = ${enumList(query.color, 'DiamondColor')}`);
  if (query.lab) where.push(sql`d."lab" = ${enumList(query.lab, 'GradingLab')}`);
  if (query.caratMin !== undefined) where.push(sql`d."carat" >= ${query.caratMin}::numeric`);
  if (query.caratMax !== undefined) where.push(sql`d."carat" <= ${query.caratMax}::numeric`);

  const priced = [sql`p."retailPrice" IS NOT NULL`]; // NULL = no rule matched = not for sale
  if (query.priceMin !== undefined) priced.push(sql`p."retailPrice" >= ${query.priceMin}::numeric`);
  if (query.priceMax !== undefined) priced.push(sql`p."retailPrice" <= ${query.priceMax}::numeric`);

  const from = sql`
    FROM (
      SELECT d.*, ${retail} AS "retailPrice"
      FROM "diamond_cache" d
      WHERE ${join(where, ' AND ')}
    ) p
    WHERE ${join(priced, ' AND ')}`;

  const offset = (query.page - 1) * query.limit;
  const [rows, counted] = await Promise.all([
    deps.db.$queryRaw<DiamondRow[]>(sql`
      SELECT p."id", p."source", p."origin", p."shape", p."carat", p."color", p."clarity",
             p."cut", p."polish", p."symmetry", p."fluorescence", p."fancyColor", p."fancyIntensity",
             p."lab", p."certificateNumber", p."certificateUrl",
             p."lengthMm", p."widthMm", p."depthMm", p."lwRatio", p."depthPercent", p."tablePercent",
             p."imageUrl", p."videoUrl", p."deliveryDays", p."wholesalePrice", p."currency"
      ${from}
      ORDER BY ${SORTS[query.sort]}
      LIMIT ${query.limit} OFFSET ${offset}`),
    deps.db.$queryRaw<{ total: number }[]>(sql`SELECT COUNT(*)::int AS total ${from}`),
  ]);

  const data: DiamondDto[] = [];
  for (const row of rows) {
    const priced = calculateRetailPrice(
      {
        wholesalePrice: row.wholesalePrice,
        currency: row.currency,
        carat: row.carat,
        origin: row.origin,
        feedSource: row.source,
        target: 'FEED_DIAMOND',
      },
      rules,
    );
    if (!priced) continue;
    data.push({
      id: row.id,
      origin: row.origin,
      shape: row.shape,
      carat: row.carat.toNumber(),
      color: row.color,
      clarity: row.clarity,
      cut: row.cut,
      polish: row.polish,
      symmetry: row.symmetry,
      fluorescence: row.fluorescence,
      fancyColor: row.fancyColor,
      fancyIntensity: row.fancyIntensity,
      lab: row.lab,
      certificateNumber: row.certificateNumber,
      certificateUrl: row.certificateUrl,
      measurements: {
        lengthMm: num(row.lengthMm),
        widthMm: num(row.widthMm),
        depthMm: num(row.depthMm),
        lwRatio: num(row.lwRatio),
      },
      depthPercent: num(row.depthPercent),
      tablePercent: num(row.tablePercent),
      imageUrl: row.imageUrl,
      videoUrl: row.videoUrl,
      deliveryDays: row.deliveryDays,
      price: { amount: priced.retailPrice.toFixed(2), currency: priced.currency },
    });
  }
  return { data, total: counted[0]?.total ?? 0 };
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
    const matrix = await deps.markupMatrix(tenantId);

    // Key order is fixed by the schema, so equal queries serialise identically.
    const digest = createHash('sha1')
      .update(JSON.stringify({ ...query, shape: query.shape?.slice().sort(), cut: query.cut?.slice().sort(), clarity: query.clarity?.slice().sort(), color: query.color?.slice().sort(), lab: query.lab?.slice().sort() }))
      .digest('hex');
    const cacheKey = `diamonds:v1:${[...feedSources].sort().join('+')}:${matrix.version}:${digest}`;

    let result = await deps.cache.get<SearchResult>(cacheKey);
    reply.header('x-cache', result ? 'HIT' : 'MISS');
    if (!result) {
      result = await searchDiamonds(deps, query, feedSources, matrix.rules);
      await deps.cache.set(cacheKey, result, deps.config.searchCacheTtlSeconds);
    }

    return {
      data: result.data,
      page: query.page,
      limit: query.limit,
      total: result.total,
      hasMore: query.page * query.limit < result.total,
    };
  });
}
