/**
 * POST /api/v1/custom/cart-item — put a ring or band designed in the 3D builders in the store's
 * own cart (Shopify, WooCommerce).
 *
 * Body: { kind: 'ring' | 'band', design: { …the builder's options } }. The server builds and
 * prices the design itself with the builders' engine (services/customDesign); the browser's price
 * is never read. It records a CheckoutSession for the design and creates a one-off product at
 * that price on the platform; the paid-order webhook turns it into a casting order (orderIntake).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma, PlatformType } from '@jewelry/db';
import { BUNDLE_ID_PROPERTY, createConnector, decryptJson, type PlatformConnector } from '@jewelry/platforms';
import { z } from 'zod';
import type { AppDeps } from '../common/context';
import { badGateway, conflict, serviceUnavailable, unprocessable } from '../common/errors';
import type { Money } from '../common/query';
import { InvalidDesign, priceDesign } from '../services/customDesign';

const body = z.object({
  kind: z.enum(['ring', 'band']),
  design: z.record(z.string(), z.unknown()),
});

const CHECKOUT_SESSION_DAYS = 7;

export interface CustomCartItemResponse {
  bundleId: string;
  platform: PlatformType;
  /** Shopify: variant id for /cart/add.js. WooCommerce: product id for wc-ajax add_to_cart. */
  purchasableId: string;
  quantity: 1;
  title: string;
  price: Money;
  /** How the price is made up, as the builder shows it. */
  lines: { label: string; amount: string }[];
  properties: Record<string, string>;
}

export async function customRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;
  const limited = { config: { rateLimit: { max: config.checkoutRateLimitPerMinute, timeWindow: '1 minute' } } };

  app.post('/custom/cart-item', limited, async (request, reply): Promise<CustomCartItemResponse> => {
    const input = body.parse(request.body);
    reply.header('cache-control', 'no-store');

    let priced;
    try {
      priced = await priceDesign(config.builderDir, input.kind, input.design);
    } catch (err) {
      if (err instanceof InvalidDesign) throw unprocessable('invalid_design', `This design cannot be made: ${err.message}`);
      throw err;
    }
    if (!(priced.total > 0)) throw unprocessable('invalid_design', 'This design has no price.');

    if (!config.credentialsKey) throw serviceUnavailable('checkout_not_configured', 'Checkout is not configured on this server.');
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: request.tenant.tenantId } });
    if (!tenant.platformCredentialsEnc) throw conflict('platform_not_connected', 'This store has not connected its e-commerce platform yet.');
    let connector: PlatformConnector;
    try {
      connector = createConnector(tenant.platformType, decryptJson<unknown>(tenant.platformCredentialsEnc, config.credentialsKey), { fetch: deps.fetch });
    } catch (err) {
      request.log.error({ err, tenantId: tenant.id }, 'stored platform credentials are unusable');
      throw badGateway('platform_error', "The store's e-commerce platform connection needs attention.");
    }
    if (!connector.createCartItem) throw conflict('native_cart_unsupported', 'This platform has no native cart hand-off.');

    const bundleId = randomUUID();
    const amount = priced.total.toFixed(2);
    const customDesign = {
      kind: priced.kind,
      design: priced.design,
      specs: priced.specs,
      lines: priced.lines,
      title: priced.title,
      metal: priced.metal,
      hasStones: priced.hasStones,
      hasCentre: priced.hasCentre,
    } as unknown as Prisma.InputJsonValue;
    // Recorded before anything exists on the platform, so a payable product is never unknown here.
    await db.checkoutSession.create({
      data: {
        id: bundleId,
        tenantId: tenant.id,
        platform: tenant.platformType,
        customDesign,
        ringSize: priced.ringSize,
        engraving: priced.engraving,
        settingPrice: amount,
        stonePrice: '0',
        total: amount,
        currency: priced.currency,
        expiresAt: new Date(Date.now() + CHECKOUT_SESSION_DAYS * 86_400_000),
      },
    });

    let created;
    try {
      created = await connector.createCartItem({
        bundleId,
        title: priced.title,
        sku: priced.sku,
        amount,
        currency: priced.currency,
        imageUrl: null,
        properties: priced.properties,
      });
    } catch (err) {
      request.log.error({ err, tenantId: tenant.id }, 'platform call failed');
      throw badGateway('platform_error', "The store's e-commerce platform did not accept the request.");
    }
    await db.checkoutSession.update({
      where: { id: bundleId },
      data: { externalCheckoutId: created.purchasableId, externalProductId: created.productId },
    });

    return {
      bundleId,
      platform: tenant.platformType,
      purchasableId: created.purchasableId,
      quantity: 1,
      title: priced.title,
      price: { amount, currency: priced.currency },
      lines: priced.lines.map((l) => ({ label: l.label, amount: l.amount.toFixed(2) })),
      properties: { ...priced.properties, [BUNDLE_ID_PROPERTY]: bundleId },
    };
  });
}
