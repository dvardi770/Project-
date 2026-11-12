/**
 * POST /api/v1/bundle   — quote a setting + stone as one cart line.
 * POST /api/v1/checkout — turn a quoted bundle into a payable checkout on the
 *                         tenant's storefront platform.
 *
 * Nothing the browser says about price is trusted. /bundle re-reads and
 * re-prices everything and returns a signed token recording the quote.
 * /checkout accepts only that token, records the quote as a CheckoutSession and
 * creates the order on the platform itself, with the price set server-side.
 * The paid-order webhook is matched back to the session (see orderIntake).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { BUNDLE_ID_PROPERTY, PlatformError, createConnector, decryptJson } from '@jewelry/platforms';
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

  app.post('/checkout', limited, async (request, reply): Promise<CheckoutResponse> => {
    const { token } = checkoutBody.parse(request.body);
    const claims = verifyBundleToken(token, config.bundleSigningSecret);
    if (!claims || claims.tenantId !== request.tenant.tenantId) {
      throw badRequest('invalid_bundle_token', 'This bundle is invalid or has expired. Build it again.');
    }
    reply.header('cache-control', 'no-store');

    // Same token twice (double click, retry): hand back the checkout already made.
    const existing = await db.checkoutSession.findUnique({ where: { id: claims.bundleId } });
    if (existing?.checkoutUrl) {
      if (existing.status !== 'OPEN') throw conflict('bundle_already_ordered', 'This bundle has already been ordered.');
      return { bundleId: existing.id, checkoutUrl: existing.checkoutUrl };
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

    // Record the quote before calling the platform: a checkout that exists on
    // the platform but not here could be paid and never matched.
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

    let created;
    try {
      const credentials = decryptJson<unknown>(tenant.platformCredentialsEnc, config.credentialsKey);
      const connector = createConnector(tenant.platformType, credentials, { fetch: deps.fetch });
      created = await connector.createCheckout({
        bundleId: claims.bundleId,
        title: bundle.title,
        sku: bundle.sku,
        amount: claims.total,
        currency: claims.currency,
        imageUrl: bundle.imageUrl,
        properties: bundle.properties,
      });
    } catch (err) {
      request.log.error({ err, tenantId: tenant.id }, 'platform checkout failed');
      const detail = err instanceof PlatformError ? '' : ' (stored credentials could not be read)';
      throw badGateway('platform_error', `The store's e-commerce platform did not accept the checkout${detail}.`);
    }

    await db.checkoutSession.update({
      where: { id: claims.bundleId },
      data: { externalCheckoutId: created.externalCheckoutId, checkoutUrl: created.checkoutUrl },
    });
    return { bundleId: claims.bundleId, checkoutUrl: created.checkoutUrl };
  });
}
