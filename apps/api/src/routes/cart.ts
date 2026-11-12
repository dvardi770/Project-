/**
 * POST /api/v1/bundle — turn a chosen setting + diamond into one cart line.
 *
 * Everything is re-read and re-priced on the server; nothing the browser says
 * about price is trusted. The response carries a signed token recording what
 * was priced, which the storefront passes through the cart (as a hidden line
 * item property) and the order webhook verifies with verifyBundleToken().
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@jewelry/db';
import { calculateRetailPrice } from '@jewelry/pricing';
import { z } from 'zod';
import { signBundleToken } from '../common/bundleToken';
import type { AppDeps } from '../common/context';
import { conflict, notFound, unprocessable } from '../common/errors';
import type { Money } from '../common/query';

const bodySchema = z.object({
  settingVariantId: z.uuid(),
  diamondId: z.uuid(),
  ringSize: z.coerce.number().min(1).max(20),
  engraving: z
    .string()
    .trim()
    .max(40)
    // printable characters only: this text is cut into metal and shown in carts
    .regex(/^[\p{L}\p{N}\p{P}\p{Zs}♥]*$/u, 'contains unsupported characters')
    .optional(),
});

const title = (s: string) =>
  s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** WHITE_GOLD_14K → "14K White Gold", PLATINUM_950 → "Platinum 950". */
function metalLabel(metal: string): string {
  const karat = metal.match(/^(.*)_(\d+K)$/);
  return karat ? `${karat[2]} ${title(karat[1]!)}` : title(metal);
}

export interface BundleResponse {
  bundleId: string;
  /** Unix seconds; after this the bundle must be rebuilt. */
  expiresAt: number;
  /** Signed record of what was priced. Verify server-side before fulfilling. */
  token: string;
  lineItem: {
    title: string;
    sku: string;
    quantity: 1;
    price: Money;
    imageUrl: string | null;
    requiresShipping: true;
    /**
     * Flat key/values for Shopify line-item properties or WooCommerce/Wix item
     * meta. Keys starting with "_" are hidden from shoppers at checkout.
     */
    properties: Record<string, string>;
  };
  components: [
    { type: 'SETTING'; id: string; settingId: string; sku: string; name: string; metal: string; price: Money },
    { type: 'DIAMOND'; id: string; description: string; certificate: string | null; price: Money },
  ];
}

export async function cartRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  app.post('/bundle', async (request, reply): Promise<BundleResponse> => {
    const body = bodySchema.parse(request.body);
    const { tenantId, feedSources } = request.tenant;

    const [variant, diamond, matrix] = await Promise.all([
      db.virtualSettingVariant.findFirst({
        where: {
          id: body.settingVariantId,
          isActive: true,
          setting: { isActive: true, OR: [{ tenantId }, { tenantId: null }] },
        },
        include: { setting: true },
      }),
      db.diamondCache.findFirst({
        where: { id: body.diamondId, source: { in: feedSources } },
      }),
      deps.markupMatrix(tenantId),
    ]);

    if (!variant) throw notFound('setting_not_found', 'Setting variant not found.');
    if (!diamond) throw notFound('diamond_not_found', 'Diamond not found.');
    if (diamond.availability !== 'AVAILABLE') {
      throw conflict('diamond_unavailable', 'This diamond is no longer available.');
    }

    // ── Pricing ── (first: an item that is not for sale must look like it does not exist)
    const { setting } = variant;
    const settingPrice = calculateRetailPrice(
      { wholesalePrice: variant.castingCost, currency: variant.currency, target: 'SETTING' },
      matrix.rules,
    );
    const diamondPrice = calculateRetailPrice(
      {
        wholesalePrice: diamond.wholesalePrice,
        currency: diamond.currency,
        carat: diamond.carat,
        origin: diamond.origin,
        feedSource: diamond.source,
        target: 'FEED_DIAMOND',
      },
      matrix.rules,
    );
    // Same rule as search: an item no markup rule covers is not for sale.
    if (!settingPrice) throw notFound('setting_not_found', 'Setting variant not found.');
    if (!diamondPrice) throw notFound('diamond_not_found', 'Diamond not found.');
    if (settingPrice.currency !== diamondPrice.currency) {
      throw unprocessable('currency_mismatch', 'Setting and diamond are priced in different currencies.');
    }

    // ── Compatibility ──
    if (!setting.compatibleShapes.includes(diamond.shape)) {
      throw unprocessable('incompatible_shape', `This setting does not accept ${title(diamond.shape)} stones.`, {
        compatibleShapes: setting.compatibleShapes,
      });
    }
    if (diamond.carat.lt(setting.centerCaratMin) || diamond.carat.gt(setting.centerCaratMax)) {
      throw unprocessable('incompatible_carat', 'This diamond is outside the carat range of the setting.', {
        min: setting.centerCaratMin.toNumber(),
        max: setting.centerCaratMax.toNumber(),
      });
    }
    const ringSize = new Prisma.Decimal(body.ringSize);
    if (
      (setting.minRingSize && ringSize.lt(setting.minRingSize)) ||
      (setting.maxRingSize && ringSize.gt(setting.maxRingSize))
    ) {
      throw unprocessable('ring_size_unavailable', 'This setting is not made in that ring size.', {
        min: setting.minRingSize?.toNumber() ?? null,
        max: setting.maxRingSize?.toNumber() ?? null,
      });
    }

    const currency = settingPrice.currency;
    const total = settingPrice.retailPrice.plus(diamondPrice.retailPrice);
    const money = (d: Prisma.Decimal): Money => ({ amount: d.toFixed(2), currency });

    // ── Line item ──
    const bundleId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + config.bundleTtlSeconds;
    const engraving = body.engraving || null;
    const metal = metalLabel(variant.metal);
    const grades = [diamond.color, diamond.clarity, diamond.cut ? title(diamond.cut) : null].filter(Boolean);
    const diamondDescription = [
      `${diamond.carat.toFixed(2)}ct`,
      title(diamond.shape),
      diamond.origin === 'LAB_GROWN' ? 'Lab-Grown' : 'Natural',
      ...grades,
    ].join(' ');
    const certificate =
      diamond.lab !== 'NONE' && diamond.certificateNumber ? `${diamond.lab} ${diamond.certificateNumber}` : null;

    const token = signBundleToken(
      {
        v: 1,
        bundleId,
        tenantId,
        settingVariantId: variant.id,
        diamondId: diamond.id,
        ringSize: ringSize.toString(),
        engraving,
        settingPrice: settingPrice.retailPrice.toFixed(2),
        diamondPrice: diamondPrice.retailPrice.toFixed(2),
        total: total.toFixed(2),
        currency,
        expiresAt,
      },
      config.bundleSigningSecret,
    );

    const properties: Record<string, string> = {
      Setting: setting.name,
      Metal: metal,
      'Ring size': ringSize.toString(),
      Diamond: diamondDescription,
      ...(certificate ? { Certificate: certificate } : {}),
      ...(engraving ? { Engraving: engraving } : {}),
      _bundle_id: bundleId,
      _bundle_token: token,
    };

    reply.header('cache-control', 'no-store');
    return {
      bundleId,
      expiresAt,
      token,
      lineItem: {
        title: `${setting.name} in ${metal} with ${diamond.carat.toFixed(2)}ct ${title(diamond.shape)} Diamond`,
        sku: `${setting.sku}-${variant.metal}`,
        quantity: 1,
        price: money(total),
        imageUrl: variant.imageUrls[0] ?? setting.thumbnailUrl ?? diamond.imageUrl,
        requiresShipping: true,
        properties,
      },
      components: [
        {
          type: 'SETTING',
          id: variant.id,
          settingId: setting.id,
          sku: setting.sku,
          name: setting.name,
          metal: variant.metal,
          price: money(settingPrice.retailPrice),
        },
        {
          type: 'DIAMOND',
          id: diamond.id,
          description: diamondDescription,
          certificate,
          price: money(diamondPrice.retailPrice),
        },
      ],
    };
  });
}
