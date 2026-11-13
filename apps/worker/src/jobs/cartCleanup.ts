/**
 * Housekeeping for checkout sessions.
 *
 *  1. Sessions past their expiry that were never ordered are marked EXPIRED.
 *  2. The one-off product a native-cart hand-off created on the store is
 *     deleted once it is no longer needed: after the bundle was ordered, or
 *     after the session expired. A store would otherwise collect one hidden
 *     product per "Add to Cart" click.
 */
import type { CheckoutSession, PrismaClient, Tenant } from '@jewelry/db';
import { createConnector, decryptJson, type HttpOptions, type PlatformConnector } from '@jewelry/platforms';

/** Give the order webhook time to finish before removing an ordered product. */
const ORDERED_GRACE_MS = 60 * 60 * 1000;
const BATCH = 100;

export interface CartCleanupDeps {
  db: PrismaClient;
  credentialsKey: Buffer | null;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
  http?: HttpOptions;
  now?: () => Date;
}

export interface CartCleanupResult {
  expired: number;
  productsDeleted: number;
  productsFailed: number;
}

export async function runCartCleanup(deps: CartCleanupDeps): Promise<CartCleanupResult> {
  const { db, log } = deps;
  const now = deps.now?.() ?? new Date();

  const { count: expired } = await db.checkoutSession.updateMany({
    where: { status: 'OPEN', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  const result: CartCleanupResult = { expired, productsDeleted: 0, productsFailed: 0 };
  if (!deps.credentialsKey) {
    log.warn('[cart-cleanup] CREDENTIALS_ENCRYPTION_KEY is not set: store products cannot be removed');
    return result;
  }

  const sessions = await db.checkoutSession.findMany({
    where: {
      externalProductId: { not: null },
      productDeletedAt: null,
      OR: [
        { status: 'EXPIRED' },
        { status: 'ORDERED', updatedAt: { lt: new Date(now.getTime() - ORDERED_GRACE_MS) } },
      ],
    },
    include: { tenant: true },
    orderBy: { expiresAt: 'asc' },
    take: BATCH,
  });

  const connectors = new Map<string, PlatformConnector | null>();
  const connectorFor = (tenant: Tenant): PlatformConnector | null => {
    if (!connectors.has(tenant.id)) {
      let connector: PlatformConnector | null = null;
      try {
        if (tenant.platformCredentialsEnc) {
          const credentials = decryptJson<unknown>(tenant.platformCredentialsEnc, deps.credentialsKey!);
          connector = createConnector(tenant.platformType, credentials, deps.http);
        }
      } catch (err) {
        log.warn(`[cart-cleanup] tenant ${tenant.id}: credentials unusable (${(err as Error).message})`);
      }
      connectors.set(tenant.id, connector);
    }
    return connectors.get(tenant.id) ?? null;
  };

  for (const session of sessions as (CheckoutSession & { tenant: Tenant })[]) {
    const connector = connectorFor(session.tenant);
    if (!connector?.deleteCartItem) continue; // retried once the store is reconnected
    try {
      await connector.deleteCartItem(session.externalProductId!);
      await db.checkoutSession.update({ where: { id: session.id }, data: { productDeletedAt: now } });
      result.productsDeleted++;
    } catch (err) {
      result.productsFailed++;
      log.warn(`[cart-cleanup] session ${session.id}: ${(err as Error).message}`);
    }
  }

  log.info(
    `[cart-cleanup] ${result.expired} expired, ${result.productsDeleted} products removed, ${result.productsFailed} failed`,
  );
  return result;
}
