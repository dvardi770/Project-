/**
 * Reserves ordered stones with their supplier.
 *
 * When a customer pays for a ring whose centre stone comes from the Nivoda
 * feed, the stone is only marked ON_HOLD in our own database. This job asks
 * Nivoda to hold it too, so another buyer cannot take it while the order is
 * reviewed. A hold is a reservation, not a purchase: buying the stone
 * (Nivoda's create_order) is left to a person.
 *
 * Off by default. Enable with NIVODA_AUTO_HOLD=true once the account's hold
 * terms are understood.
 */
import type { PrismaClient } from '@jewelry/db';
import { NivodaClient, type NivodaConfig } from '@jewelry/feeds';

const BATCH = 25;

export interface SupplierHoldsDeps {
  db: PrismaClient;
  nivoda: NivodaConfig | null;
  enabled: boolean;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
  now?: () => Date;
}

export interface SupplierHoldsResult {
  held: number;
  denied: number;
  failed: number;
}

/** Nivoda's `until` may be an ISO string or a timestamp; anything else is not stored. */
function parseUntil(raw: string | null): Date | null {
  if (!raw) return null;
  const numeric = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const date = Number.isNaN(numeric) ? new Date(raw) : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function runSupplierHolds(deps: SupplierHoldsDeps): Promise<SupplierHoldsResult | null> {
  const { db, log } = deps;
  if (!deps.enabled) {
    log.info('[supplier-holds] skipped: NIVODA_AUTO_HOLD is not "true"');
    return null;
  }
  if (!deps.nivoda) {
    log.info('[supplier-holds] skipped: NIVODA_USERNAME / NIVODA_PASSWORD are not set');
    return null;
  }

  // Only clean, confirmed orders: an order already ON_HOLD needs a person first.
  const orders = await db.castingOrder.findMany({
    where: {
      status: 'CONFIRMED',
      supplierHoldAttemptedAt: null,
      centerDiamond: { source: 'NIVODA' },
    },
    include: { centerDiamond: { select: { sourceStockId: true } } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  const result: SupplierHoldsResult = { held: 0, denied: 0, failed: 0 };
  if (orders.length === 0) return result;

  const client = new NivodaClient({ ...deps.nivoda, logger: log });
  for (const order of orders) {
    const now = deps.now?.() ?? new Date();
    try {
      const hold = await client.createHold(order.centerDiamond!.sourceStockId);
      if (hold.denied) {
        result.denied++;
        await db.castingOrder.update({
          where: { id: order.id },
          data: {
            supplierHoldAttemptedAt: now,
            status: 'ON_HOLD',
            notes: [order.notes, 'Nivoda declined to hold the centre stone; it may no longer be available.']
              .filter(Boolean)
              .join(' '),
          },
        });
      } else {
        result.held++;
        await db.castingOrder.update({
          where: { id: order.id },
          data: { supplierHoldAttemptedAt: now, supplierHoldId: hold.id, supplierHoldUntil: parseUntil(hold.until) },
        });
      }
    } catch (err) {
      // Left untouched, so the next run tries again.
      result.failed++;
      log.warn(`[supplier-holds] ${order.jobBagNumber}: ${(err as Error).message}`);
    }
  }

  log.info(`[supplier-holds] ${result.held} held, ${result.denied} declined, ${result.failed} failed`);
  return result;
}
