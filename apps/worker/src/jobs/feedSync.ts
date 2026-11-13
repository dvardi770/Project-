/**
 * Pulls the Nivoda feed into DiamondCache, then drops the API's cached search
 * results so new and withdrawn stones show up straight away.
 */
import type { PrismaClient } from '@jewelry/db';
import { ingestNivoda, type NivodaConfig, type NivodaSyncResult } from '@jewelry/feeds';
import { bumpInventoryEpoch, type Cache } from '@jewelry/shared/cache';

export interface FeedSyncDeps {
  db: PrismaClient;
  cache: Cache;
  nivoda: NivodaConfig | null;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export async function runFeedSync(deps: FeedSyncDeps): Promise<NivodaSyncResult | null> {
  if (!deps.nivoda) {
    deps.log.info('[feed-sync] skipped: NIVODA_USERNAME / NIVODA_PASSWORD are not set');
    return null;
  }
  try {
    const result = await ingestNivoda(deps.db, { ...deps.nivoda, logger: deps.log });
    deps.log.info(
      `[feed-sync] nivoda: ${result.upserted} upserted, ${result.rejected} rejected, ${result.markedUnavailable} withdrawn`,
    );
    return result;
  } finally {
    // Even a run that failed part-way has changed rows.
    await bumpInventoryEpoch(deps.cache);
  }
}
