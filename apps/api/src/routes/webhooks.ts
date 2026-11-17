/**
 * POST /webhooks/:platform/:tenantId — order notifications from storefronts.
 *
 * Each tenant registers this URL (with its own tenant id) on its platform. The
 * delivery is authenticated with the tenant's stored webhook secret against
 * the raw request body, then paid orders are handed to order intake.
 *
 * Responses: 200 once handled (including deliveries we ignore, so platforms do
 * not retry them), 401 for a bad signature, 5xx if intake failed and the
 * platform should redeliver.
 */
import type { FastifyInstance } from 'fastify';
import type { PlatformType } from '@jewelry/db';
import { decryptSecret, receiveOrderWebhook } from '@jewelry/platforms';
import { z } from 'zod';
import { bumpInventoryEpoch } from '../common/cache';
import type { AppDeps } from '../common/context';
import { notFound, serviceUnavailable, unauthorized } from '../common/errors';
import { ingestPaidOrder } from '../services/orderIntake';

const PLATFORMS: Record<string, PlatformType> = {
  shopify: 'SHOPIFY',
  woocommerce: 'WOOCOMMERCE',
  wix: 'WIX',
};

const params = z.object({ platform: z.string(), tenantId: z.uuid() });

export async function webhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config } = deps;

  // Signatures cover the exact bytes sent, so keep the body unparsed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.post('/webhooks/:platform/:tenantId', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    const { platform: slug, tenantId } = params.parse(request.params);
    const platform = PLATFORMS[slug.toLowerCase()];
    if (!platform) throw notFound('not_found', 'Unknown platform.');
    if (!config.credentialsKey) {
      throw serviceUnavailable('webhooks_not_configured', 'Webhooks are not configured on this server.');
    }

    const tenant = await db.tenant.findFirst({ where: { id: tenantId, platformType: platform, deletedAt: null } });
    // Same answer whether the tenant is unknown or the signature is wrong.
    if (!tenant?.platformWebhookSecretEnc) throw unauthorized('Invalid webhook signature.');

    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    let received;
    try {
      const secret = decryptSecret(tenant.platformWebhookSecretEnc, config.credentialsKey);
      received = receiveOrderWebhook(platform, rawBody, request.headers, secret);
    } catch (err) {
      request.log.warn({ err, tenantId }, 'webhook could not be read');
      throw unauthorized('Invalid webhook signature.');
    }
    if (!received.ok) throw unauthorized('Invalid webhook signature.');

    const { order } = received;
    if (!order || !order.paid) return { received: true, handled: false };

    const result = await ingestPaidOrder(db, tenantId, order);
    // Stones were taken out of stock: drop cached search results.
    if (result.created.length > 0) await bumpInventoryEpoch(deps.cache);
    request.log.info({ tenantId, order: order.externalOrderId, ...result }, 'order webhook handled');
    return {
      received: true,
      handled: true,
      castingOrders: result.created.map((c) => c.jobBagNumber),
      duplicates: result.duplicates,
    };
  });
}
