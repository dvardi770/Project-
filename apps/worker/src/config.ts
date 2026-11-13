import { parseEncryptionKey } from '@jewelry/platforms';
import { z } from 'zod';

const schema = z.object({
  REDIS_URL: z.string().url().optional(),
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),
  NIVODA_USERNAME: z.string().optional(),
  NIVODA_PASSWORD: z.string().optional(),
  NIVODA_ENDPOINT: z.string().url().optional(),
  NIVODA_PRICE_UNIT: z.enum(['cents', 'dollars']).default('cents'),
  NIVODA_AUTO_HOLD: z.enum(['true', 'false']).default('false'),
  SUPPLIER_HOLD_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(5),
  FEED_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(360),
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(60),
});

export interface WorkerConfig {
  redisUrl?: string;
  credentialsKey: Buffer | null;
  /** Null when no Nivoda account is configured; the feed sync is then skipped. */
  nivoda: { username: string; password: string; endpoint?: string; priceUnit: 'cents' | 'dollars' } | null;
  /** Reserve ordered Nivoda stones with Nivoda automatically. Off unless NIVODA_AUTO_HOLD=true. */
  nivodaAutoHold: boolean;
  supplierHoldIntervalMs: number;
  feedSyncIntervalMs: number;
  cleanupIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  return {
    redisUrl: e.REDIS_URL,
    credentialsKey: e.CREDENTIALS_ENCRYPTION_KEY ? parseEncryptionKey(e.CREDENTIALS_ENCRYPTION_KEY) : null,
    nivoda:
      e.NIVODA_USERNAME && e.NIVODA_PASSWORD
        ? { username: e.NIVODA_USERNAME, password: e.NIVODA_PASSWORD, endpoint: e.NIVODA_ENDPOINT, priceUnit: e.NIVODA_PRICE_UNIT }
        : null,
    nivodaAutoHold: e.NIVODA_AUTO_HOLD === 'true',
    supplierHoldIntervalMs: e.SUPPLIER_HOLD_INTERVAL_MINUTES * 60_000,
    feedSyncIntervalMs: e.FEED_SYNC_INTERVAL_MINUTES * 60_000,
    cleanupIntervalMs: e.CLEANUP_INTERVAL_MINUTES * 60_000,
  };
}
