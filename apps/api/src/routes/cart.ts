/**
 * POST /api/v1/bundle   — quote a setting + stone as one cart line.
 * POST /api/v1/cart-item — make a quoted bundle addable to the storefront's
 *                          own cart (Shopify, WooCommerce).
 * POST /api/v1/checkout  — or turn it straight into a payable checkout on the
 *                          tenant's storefront platform (any platform).
 *
 * Nothing the browser says about price is trusted. /bundle re-reads and
 * re-prices everything and returns a signed token recording the quote.
 * /cart-item and /checkout accept only that token, record the quote as a
 * CheckoutSession and create the product or order on the platform themselves,
 * with the price set server-side.
 * The paid-order webhook is matched back to the session (see orderIntake).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlatformType } from '@jewelry/db';
import {
  BUNDLE_ID_PROPERTY,
  createConnector,
  decryptJson,
  type CheckoutLineItem,
  type PlatformConnector,
} from '@jewelry/platforms';
import { z } from 'zod';
import { signBundleToken, verifyBundleToken } from '../common/bundleToken';
import type { AppDeps } from '../common/context';
import { badGateway, badRequest, conflict, serviceUnavailable } from '../common/errors';
import type { Money } from '../common/query';
import { resolveBundle } from '../services/bundle';

const bundleBody = z.object({
  settingVariantId: z.uuid(),
  diamondId: z.uuid(),
  /** Which inventory the diamond came from (the `inventory` field in search results). */
  inventory: z.enum(['FEED', 'MERCHANT']).default('FEED'),
  ringSize: z.coerce.number().min(1).max(20),
  engraving: z
    .string()
    .trim()
    .max(40)
    // printable characters only: this text is cut into metal and shown in carts
    .regex(/^[\p{L}\p{N}\p{P}\p{Zs}♥+&]*$/u, 'contains unsupported characters')
    .optional(),
});

const checkoutBody = z.object({ token: z.string().min(1).max(4000) });

/** How long a created checkout is expected to stay payable; informational. */
const CHECKOUT_SESSION_DAYS = 7;

export interface BundleResponse {
  bundleId: string;
  /** Unix seconds; after this the bundle must be quoted again. */
  expiresAt: number;
  /** Signed record of the quote. Send it to POST /api/v1/checkout. */
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
    {
      type: 'DIAMOND';
      id: string;
      inventory: 'FEED' | 'MERCHANT';
      description: string;
      certificate: string | null;
      price: Money;
    },
  ];
}

export interface CheckoutResponse {
  bundleId: string;
  /** Send the shopper here to pay. */
  checkoutUrl: string;
}

export interface CartItemResponse {
  bundleId: string;
  platform: PlatformType;
  /** Shopify: variant id for /cart/add.js. WooCommerce: product id for wc-ajax add_to_cart. */
  purchasableId: string;
  quantity: 1;
  /** Line-item properties to send with the add-to-cart call where the platform supports them. */
  properties: Record<string, string>;
}

export async function cartRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;
  const limited = { config: { rateLimit: { max: config.checkoutRateLimitPerMinute, timeWindow: '1 minute' } } };

  app.post('/bundle', limited, async (request, reply): Promise<BundleResponse> => {
    const body = bundleBody.parse(request.body);
    const bundle = await resolveBundle(deps, request.tenant, {
      settingVariantId: body.settingVariantId,
      stoneSource: body.inventory,
      stoneId: body.diamondId,
      ringSize: body.ringSize,
      engraving: body.engraving,
    });

    const bundleId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + config.bundleTtlSeconds;
    const money = (d: { toFixed(n: number): string }): Money => ({ amount: d.toFixed(2), currency: bundle.currency });

    const token = signBundleToken(
      {
        v: 1,
        bundleId,
        tenantId: request.tenant.tenantId,
        settingVariantId: bundle.variant.id,
        stoneSource: bundle.stone.source,
        stoneId: bundle.stone.id,
        stoneRuleId: bundle.stoneRuleId,
        ringSize: bundle.ringSize.toString(),
        engraving: bundle.engraving,
        settingPrice: bundle.settingPrice.toFixed(2),
        stonePrice: bundle.stonePrice.toFixed(2),
        total: bundle.total.toFixed(2),
        currency: bundle.currency,
        expiresAt,
      },
      config.bundleSigningSecret,
    );

    reply.header('cache-control', 'no-store');
    return {
      bundleId,
      expiresAt,
      token,
      lineItem: {
        title: bundle.title,
        sku: bundle.sku,
        quantity: 1,
        price: money(bundle.total),
        imageUrl: bundle.imageUrl,
        requiresShipping: true,
        properties: { ...bundle.properties, [BUNDLE_ID_PROPERTY]: bundleId },
      },
      components: [
        {
          type: 'SETTING',
          id: bundle.variant.id,
          settingId: bundle.setting.id,
          sku: bundle.setting.sku,
          name: bundle.setting.name,
          metal: bundle.variant.metal,
          price: money(bundle.settingPrice),
        },
        {
          type: 'DIAMOND',
          id: bundle.stone.id,
          inventory: bundle.stone.source,
          description: bundle.stoneDescription,
          certificate: bundle.certificate,
          price: money(bundle.stonePrice),
        },
      ],
    };
  });

  /**
   * Shared front half of both hand-off routes: authenticate the quote, make
   * sure it can still be sold, and record it as a CheckoutSession before
   * anything is created on the platform (something payable on the platform
   * that we have no record of could be paid and never matched).
   */
  async function openSession(request: FastifyRequest, token: string) {
    const claims = verifyBundleToken(token, config.bundleSigningSecret);
    if (!claims || claims.tenantId !== request.tenant.tenantId) {
      throw badRequest('invalid_bundle_token', 'This bundle is invalid or has expired. Build it again.');
    }
    const existing = await db.checkoutSession.findUnique({ where: { id: claims.bundleId } });
    if (existing && existing.status !== 'OPEN') {
      throw conflict('bundle_already_ordered', 'This bundle has already been ordered.');
    }
    if (!config.credentialsKey) {
      throw serviceUnavailable('checkout_not_configured', 'Checkout is not configured on this server.');
    }
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: claims.tenantId } });
    if (!tenant.platformCredentialsEnc) {
      throw conflict('platform_not_connected', 'This store has not connected its e-commerce platform yet.');
    }

    // Availability and compatibility may have changed since the quote. The
    // price is honoured as quoted for the life of the token.
    const bundle = await resolveBundle(deps, request.tenant, {
      settingVariantId: claims.settingVariantId,
      stoneSource: claims.stoneSource,
      stoneId: claims.stoneId,
      ringSize: claims.ringSize,
      engraving: claims.engraving,
    });

    if (!existing) {
      await db.checkoutSession.create({
        data: {
          id: claims.bundleId,
          tenantId: claims.tenantId,
          platform: tenant.platformType,
          settingVariantId: claims.settingVariantId,
          stoneSource: claims.stoneSource,
          stoneId: claims.stoneId,
          ringSize: claims.ringSize,
          engraving: claims.engraving,
          settingPrice: claims.settingPrice,
          stonePrice: claims.stonePrice,
          total: claims.total,
          currency: claims.currency,
          stoneMarkupRuleId: claims.stoneRuleId,
          expiresAt: new Date(Date.now() + CHECKOUT_SESSION_DAYS * 86_400_000),
        },
      });
    }

    const item: CheckoutLineItem = {
      bundleId: claims.bundleId,
      title: bundle.title,
      sku: bundle.sku,
      amount: claims.total,
      currency: claims.currency,
      imageUrl: bundle.imageUrl,
      properties: bundle.properties,
    };
    let connector: PlatformConnector;
    try {
      const credentials = decryptJson<unknown>(tenant.platformCredentialsEnc, config.credentialsKey);
      connector = createConnector(tenant.platformType, credentials, { fetch: deps.fetch });
    } catch (err) {
      request.log.error({ err, tenantId: tenant.id }, 'stored platform credentials are unusable');
      throw badGateway('platform_error', "The store's e-commerce platform connection needs attention.");
    }
    return { claims, existing, tenant, bundle, item, connector };
  }

  /** Run a platform call, turning its failure into a 502 the widget can show. */
  async function onPlatform<T>(request: FastifyRequest, tenantId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      request.log.error({ err, tenantId }, 'platform call failed');
      throw badGateway('platform_error', "The store's e-commerce platform did not accept the request.");
    }
  }

  app.post('/checkout', limited, async (request, reply): Promise<CheckoutResponse> => {
    const { token } = checkoutBody.parse(request.body);
    reply.header('cache-control', 'no-store');
    const { claims, existing, tenant, item, connector } = await openSession(request, token);

    // Same token twice (double click, retry): hand back the checkout already made.
    if (existing?.checkoutUrl) return { bundleId: existing.id, checkoutUrl: existing.checkoutUrl };

    const created = await onPlatform(request, tenant.id, () => connector.createCheckout(item));
    await db.checkoutSession.update({
      where: { id: claims.bundleId },
      data: { externalCheckoutId: created.externalCheckoutId, checkoutUrl: created.checkoutUrl },
    });
    return { bundleId: claims.bundleId, checkoutUrl: created.checkoutUrl };
  });

  app.post('/cart-item', limited, async (request, reply): Promise<CartItemResponse> => {
    const { token } = checkoutBody.parse(request.body);
    reply.header('cache-control', 'no-store');
    const { claims, existing, tenant, bundle, item, connector } = await openSession(request, token);

    const respond = (purchasableId: string): CartItemResponse => ({
      bundleId: claims.bundleId,
      platform: tenant.platformType,
      purchasableId,
      quantity: 1,
      properties: { ...bundle.properties, [BUNDLE_ID_PROPERTY]: claims.bundleId },
    });

    if (existing?.checkoutUrl) {
      throw conflict('bundle_in_checkout', 'A checkout has already been started for this bundle.');
    }
    if (existing?.externalCheckoutId) return respond(existing.externalCheckoutId); // retry
    if (!connector.createCartItem) {
      throw conflict('native_cart_unsupported', 'This platform has no native cart hand-off; use /checkout.');
    }

    const created = await onPlatform(request, tenant.id, () => connector.createCartItem!(item));
    await db.checkoutSession.update({
      where: { id: claims.bundleId },
      data: { externalCheckoutId: created.purchasableId },
    });
    return respond(created.purchasableId);
  });
}
