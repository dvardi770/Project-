/**
 * GET /api/v1/settings — ring mountings for the builder.
 *
 * Returns the tenant's own settings plus the shared platform catalogue,
 * filtered by metal and by the centre-stone shapes each setting accepts.
 * Each metal variant is priced with the tenant's SETTING markup rules;
 * variants no rule covers are not for sale and are left out.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DiamondShape, MetalType, MountingStyle, type MarkupRule, type Prisma } from '@jewelry/db';
import { calculateRetailPrice } from '@jewelry/pricing';
import { z } from 'zod';
import type { AppDeps } from '../common/context';
import { csvEnum, pagination, type Money } from '../common/query';

/** Catalogues are small; pricing and paging happen in memory over at most this many. */
const MAX_SETTINGS = 1000;

const querySchema = z.object({
  metal: csvEnum(MetalType),
  /** Settings that accept at least one of these centre-stone shapes. */
  shape: csvEnum(DiamondShape),
  style: csvEnum(MountingStyle),
  /** Settings whose centre-stone range includes this carat weight. */
  carat: z.coerce.number().positive().max(100).optional(),
  ...pagination,
});

type SettingQuery = z.infer<typeof querySchema>;

export interface SettingVariantDto {
  id: string;
  metal: MetalType;
  metalWeightGrams: number | null;
  video360Url: string | null;
  imageUrls: string[];
  price: Money;
}

export interface SettingDto {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  style: MountingStyle;
  compatibleShapes: DiamondShape[];
  centerCarat: { min: number; max: number };
  ringSize: { min: number | null; max: number | null };
  bandWidthMm: number | null;
  leadTimeDays: number | null;
  video360Url: string | null;
  thumbnailUrl: string | null;
  sideStones: {
    position: string | null;
    shape: DiamondShape;
    origin: string;
    quantity: number;
    totalCarat: number;
    sizeMm: number | null;
    colorGrade: string | null;
    clarityGrade: string | null;
  }[];
  variants: SettingVariantDto[];
  /** Cheapest variant, for "from $…" labels. */
  priceFrom: Money;
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

async function listSettings(
  deps: AppDeps,
  tenantId: string,
  query: SettingQuery,
  rules: MarkupRule[],
): Promise<SettingDto[]> {
  const variantFilter: Prisma.VirtualSettingVariantWhereInput = {
    isActive: true,
    ...(query.metal ? { metal: { in: query.metal } } : {}),
  };

  const settings = await deps.db.virtualSetting.findMany({
    where: {
      isActive: true,
      OR: [{ tenantId }, { tenantId: null }],
      variants: { some: variantFilter },
      ...(query.shape ? { compatibleShapes: { hasSome: query.shape } } : {}),
      ...(query.style ? { style: { in: query.style } } : {}),
      ...(query.carat !== undefined
        ? { centerCaratMin: { lte: query.carat }, centerCaratMax: { gte: query.carat } }
        : {}),
    },
    include: {
      variants: { where: variantFilter, orderBy: { castingCost: 'asc' } },
      sideStones: true,
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: MAX_SETTINGS,
  });

  const result: SettingDto[] = [];
  for (const s of settings) {
    const variants: SettingVariantDto[] = [];
    for (const v of s.variants) {
      const priced = calculateRetailPrice(
        { wholesalePrice: v.castingCost, currency: v.currency, target: 'SETTING' },
        rules,
      );
      if (!priced) continue;
      variants.push({
        id: v.id,
        metal: v.metal,
        metalWeightGrams: num(v.metalWeightGrams),
        video360Url: v.video360Url ?? s.video360Url,
        imageUrls: v.imageUrls,
        price: { amount: priced.retailPrice.toFixed(2), currency: priced.currency },
      });
    }
    if (variants.length === 0) continue;
    variants.sort((a, b) => Number(a.price.amount) - Number(b.price.amount));

    result.push({
      id: s.id,
      sku: s.sku,
      name: s.name,
      description: s.description,
      style: s.style,
      compatibleShapes: s.compatibleShapes,
      centerCarat: { min: s.centerCaratMin.toNumber(), max: s.centerCaratMax.toNumber() },
      ringSize: { min: num(s.minRingSize), max: num(s.maxRingSize) },
      bandWidthMm: num(s.bandWidthMm),
      leadTimeDays: s.leadTimeDays,
      video360Url: s.video360Url,
      thumbnailUrl: s.thumbnailUrl,
      sideStones: s.sideStones.map((st) => ({
        position: st.position,
        shape: st.shape,
        origin: st.origin,
        quantity: st.quantity,
        totalCarat: st.totalCarat.toNumber(),
        sizeMm: num(st.sizeMm),
        colorGrade: st.colorGrade,
        clarityGrade: st.clarityGrade,
      })),
      variants,
      priceFrom: variants[0]!.price,
    });
  }
  return result;
}

export async function settingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/settings', async (request, reply) => {
    const query = querySchema.parse(request.query);
    const { tenantId } = request.tenant;
    const matrix = await deps.markupMatrix(tenantId);

    // The full filtered list is cached; pages are cut from it.
    const { page, limit, ...filters } = query;
    const digest = createHash('sha1')
      .update(JSON.stringify({ ...filters, metal: filters.metal?.slice().sort(), shape: filters.shape?.slice().sort(), style: filters.style?.slice().sort() }))
      .digest('hex');
    const cacheKey = `settings:v1:${tenantId}:${matrix.version}:${digest}`;

    let all = await deps.cache.get<SettingDto[]>(cacheKey);
    reply.header('x-cache', all ? 'HIT' : 'MISS');
    if (!all) {
      all = await listSettings(deps, tenantId, query, matrix.rules);
      await deps.cache.set(cacheKey, all, deps.config.searchCacheTtlSeconds);
    }

    const start = (page - 1) * limit;
    return {
      data: all.slice(start, start + limit),
      page,
      limit,
      total: all.length,
      hasMore: start + limit < all.length,
    };
  });
}
