/**
 * Shopify App Proxy.
 *
 * A store's app proxy forwards https://{store}/apps/{subpath}/… to this API at
 * /shopify/proxy/…, adding `shop`, `path_prefix`, `timestamp` and a `signature`
 * computed with the app's client secret.
 *
 *   GET  /shopify/proxy            → the ring builder page. The response is
 *        Liquid (Content-Type: application/liquid), which Shopify renders
 *        inside the store's own theme layout: header, footer and styles are
 *        the theme's, and the widget is a normal element on the page. No iframe.
 *
 *   ANY  /shopify/proxy/api/v1/…   → the storefront API, same routes as
 *        /api/v1. The widget calls these through the proxy, so its requests are
 *        same-origin on the store and are authenticated by Shopify's signature:
 *        the merchant configures no API key, no domain list and no CORS.
 *
 * App setup (Partner dashboard → App proxy): prefix "apps", subpath of your
 * choice (e.g. "ring-builder"), proxy URL https://{this API}/shopify/proxy.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { decryptSecret } from '@jewelry/platforms';
import { ttlMemo } from '../common/cache';
import type { AppDeps } from '../common/context';
import { HttpError, forbidden, unauthorized } from '../common/errors';
import { assertSubscribed, toTenantContext } from '../common/tenantAuth';
import { cartRoutes } from './cart';
import { diamondRoutes } from './diamonds';
import { settingRoutes } from './settings';
import { WIDGET_SCRIPT_PATH } from './widgetAsset';

/** Requests older than this are refused, which bounds replay of a captured URL. */
const MAX_AGE_SECONDS = 300;

type Query = Record<string, string | string[] | undefined>;

/**
 * Shopify's App Proxy signature: every query parameter except `signature`,
 * as "key=value" (repeated keys joined with ","), sorted, concatenated with
 * no separator, HMAC-SHA256 with the app secret, hex. Same algorithm as
 * @shopify/shopify-api's validateHmac(..., { signator: 'appProxy' }).
 */
export function shopifyProxySignature(query: Query, secret: string): string {
  const message = Object.entries(query)
    .filter(([key, value]) => key !== 'signature' && key !== 'hmac' && value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .sort()
    .join('');
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function verifyShopifyProxy(query: Query, secrets: readonly string[], now = Date.now()): boolean {
  const given = typeof query.signature === 'string' ? query.signature : '';
  const timestamp = Number(query.timestamp);
  if (!/^[0-9a-f]{64}$/i.test(given) || !Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > MAX_AGE_SECONDS) return false;
  const actual = Buffer.from(given.toLowerCase(), 'hex');
  return secrets.some((secret) => {
    const expected = Buffer.from(shopifyProxySignature(query, secret), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

const escapeAttribute = (value: string) =>
  value.replace(/[&<>"'{}%]/g, (c) => `&#${c.charCodeAt(0)};`); // also neutralises Liquid delimiters

/** The Liquid that Shopify renders inside the theme. */
export function ringBuilderLiquid(options: { scriptUrl: string; pathPrefix: string }): string {
  return `{%- comment -%} Ring builder, served through the Shopify App Proxy. {%- endcomment -%}
<div class="page-width jewelry-configurator-page">
  <script src="${escapeAttribute(options.scriptUrl)}" defer></script>
  <jewelry-configurator
    api-base="${escapeAttribute(options.pathPrefix)}"
    platform="shopify"
    locale="{{ request.locale.iso_code | escape }}"
  ></jewelry-configurator>
  <noscript><p>The ring builder needs JavaScript. Please enable it in your browser.</p></noscript>
</div>
`;
}

const unavailableLiquid = `<div class="page-width"><p>The ring builder is not available for this store yet.</p></div>\n`;

export async function shopifyProxyRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  const findShop = ttlMemo(30_000, (shop: string) =>
    db.tenant.findFirst({
      where: { platformType: 'SHOPIFY', platformStoreId: shop, deletedAt: null },
      include: { feedConnections: { where: { isEnabled: true }, select: { source: true } } },
    }),
  );

  /**
   * Check that the request really came through Shopify for this shop.
   * Returns the shop's tenant, or null when the shop has not been onboarded.
   */
  async function authenticate(request: FastifyRequest) {
    const query = request.query as Query;
    const shop = typeof query.shop === 'string' ? query.shop.toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw unauthorized('Invalid proxy signature.');

    const tenant = await findShop(shop);
    const secrets: string[] = [];
    if (config.shopifyAppSecret) secrets.push(config.shopifyAppSecret);
    if (tenant?.platformWebhookSecretEnc && config.credentialsKey) {
      try {
        secrets.push(decryptSecret(tenant.platformWebhookSecretEnc, config.credentialsKey));
      } catch {
        // an unreadable stored secret simply cannot vouch for the request
      }
    }
    if (!verifyShopifyProxy(query, secrets)) throw unauthorized('Invalid proxy signature.');
    return tenant;
  }

  // ── The page ──
  const page = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const tenant = await authenticate(request);
    reply.type('application/liquid').header('cache-control', 'no-store');

    const subscribed = tenant && (tenant.subscriptionStatus === 'ACTIVE' || tenant.subscriptionStatus === 'TRIALING');
    if (!subscribed) return unavailableLiquid;

    // path_prefix is where the proxy is mounted on the store, e.g. /apps/ring-builder.
    const pathPrefix = String((request.query as Query).path_prefix ?? '');
    if (!/^\/(apps|a|community|tools)\/[A-Za-z0-9_-]+$/.test(pathPrefix)) {
      throw new HttpError(400, 'invalid_path_prefix', 'Unexpected app proxy path.');
    }
    const scriptUrl = config.widgetScriptUrl ?? `${request.protocol}://${request.host}${WIDGET_SCRIPT_PATH}`;
    return ringBuilderLiquid({ scriptUrl, pathPrefix });
  };
  app.get('/shopify/proxy', page);
  app.get('/shopify/proxy/', page);

  // ── The storefront API, through the proxy ──
  await app.register(
    async (api) => {
      await api.register(rateLimit, {
        // Shopify relays these requests, so many shoppers can share an address.
        max: config.rateLimitPerMinute * 10,
        timeWindow: '1 minute',
        nameSpace: 'ratelimit:shopify:',
        skipOnError: true,
        keyGenerator: (request) => `${String((request.query as Query).shop ?? '')}:${request.ip}`,
        errorResponseBuilder: (_request, context) =>
          new HttpError(429, 'rate_limited', `Too many requests. Retry in ${context.after}.`),
      });

      api.decorateRequest('tenant');
      api.addHook('preParsing', async (request) => {
        const tenant = await authenticate(request);
        if (!tenant) throw forbidden('store_not_connected', 'This store is not connected to the ring builder.');
        assertSubscribed(tenant);
        // Same rights as a publishable key used from the store's own pages.
        request.tenant = toTenantContext(tenant, 'PUBLISHABLE', config);
      });

      await api.register(diamondRoutes, deps);
      await api.register(settingRoutes, deps);
      await api.register(cartRoutes, deps);
    },
    { prefix: '/shopify/proxy/api/v1' },
  );
}
