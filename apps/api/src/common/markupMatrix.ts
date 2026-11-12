import { createHash } from 'node:crypto';
import type { MarkupRule, PrismaClient } from '@jewelry/db';
import { loadMarkupMatrix } from '@jewelry/pricing';
import { ttlMemo } from './cache';

export interface MarkupMatrix {
  rules: MarkupRule[];
  /** Changes whenever any active rule changes; used in cache keys. */
  version: string;
}

export type MarkupMatrixLoader = ((tenantId: string) => Promise<MarkupMatrix>) & { clear: () => void };

/**
 * A tenant's active markup rules, held in process for a short time so a burst
 * of searches does not re-read them. A merchant's edit is live within the TTL.
 */
export function createMarkupMatrixLoader(db: PrismaClient, ttlMs = 15_000): MarkupMatrixLoader {
  return ttlMemo(ttlMs, async (tenantId) => {
    const rules = await loadMarkupMatrix(db, tenantId);
    const hash = createHash('sha1');
    for (const r of rules) hash.update(`${r.id}:${r.updatedAt.getTime()};`);
    return { rules, version: hash.digest('hex').slice(0, 16) };
  });
}
