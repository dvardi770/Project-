import type { FeedSource, PrismaClient } from '@jewelry/db';
import type { NormalizedDiamond } from './types';

/** The slice of the Prisma client the writer needs (easy to fake in tests). */
export type DiamondCacheDb = Pick<PrismaClient, 'diamondCache' | '$transaction'>;

/**
 * Upsert one page of diamonds, keyed by (source, sourceStockId). The page is
 * one transaction, so a page is either fully visible or not at all.
 */
export async function upsertDiamonds(
  db: DiamondCacheDb,
  diamonds: readonly NormalizedDiamond[],
  syncRunId: string,
  syncedAt: Date = new Date(),
): Promise<number> {
  if (diamonds.length === 0) return 0;

  // A page can repeat a stone when the upstream list shifts mid-sync.
  const unique = new Map<string, NormalizedDiamond>();
  for (const d of diamonds) unique.set(`${d.source}:${d.sourceStockId}`, d);

  // A stone promised to a customer stays on hold here even if the feed still
  // lists it as available: the feed does not know about our orders.
  const allocated = await db.diamondCache.findMany({
    where: {
      OR: [...unique.values()].map((d) => ({ source: d.source, sourceStockId: d.sourceStockId })),
      castingOrders: { some: { status: { notIn: ['CANCELED', 'DELIVERED'] } } },
    },
    select: { source: true, sourceStockId: true },
  });
  const held = new Set(allocated.map((d) => `${d.source}:${d.sourceStockId}`));

  await db.$transaction(
    [...unique.entries()].map(([key, d]) => {
      const availability = held.has(key) && d.availability === 'AVAILABLE' ? ('ON_HOLD' as const) : d.availability;
      const data = { ...d, availability, syncRunId, lastSyncedAt: syncedAt };
      return db.diamondCache.upsert({
        where: { source_sourceStockId: { source: d.source, sourceStockId: d.sourceStockId } },
        create: data,
        update: data,
      });
    }),
  );
  return unique.size;
}

/**
 * After a sync run that read the whole feed, flag every stone the run did not
 * touch as UNAVAILABLE. Rows are kept because casting orders reference them.
 * Never call this after a partial or failed run.
 */
export async function markUnseenUnavailable(
  db: DiamondCacheDb,
  source: FeedSource,
  runStartedAt: Date,
): Promise<number> {
  const { count } = await db.diamondCache.updateMany({
    where: {
      source,
      lastSyncedAt: { lt: runStartedAt },
      availability: { not: 'UNAVAILABLE' },
    },
    data: { availability: 'UNAVAILABLE' },
  });
  return count;
}
