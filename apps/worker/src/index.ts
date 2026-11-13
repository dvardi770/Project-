/**
 * Background worker. Runs each job on its own interval inside one process:
 *
 *   pnpm --filter @jewelry/worker start
 *
 * or a single job once and exit, for platforms that schedule jobs themselves:
 *
 *   pnpm --filter @jewelry/worker job feed-sync
 *   pnpm --filter @jewelry/worker job supplier-holds
 *   pnpm --filter @jewelry/worker job cart-cleanup
 */
import { prisma } from '@jewelry/db';
import { MemoryCache, RedisCache } from '@jewelry/shared/cache';
import { loadConfig } from './config';
import { runCartCleanup } from './jobs/cartCleanup';
import { runFeedSync } from './jobs/feedSync';
import { runSupplierHolds } from './jobs/supplierHolds';

const config = loadConfig();
const log = console;
const cache = config.redisUrl
  ? new RedisCache(config.redisUrl, (err) => log.warn(`[redis] ${err.message}`))
  : new MemoryCache();
if (!config.redisUrl) log.warn('[worker] REDIS_URL is not set: the API will not hear about inventory changes');

const jobs = {
  'feed-sync': {
    everyMs: config.feedSyncIntervalMs,
    run: () => runFeedSync({ db: prisma, cache, nivoda: config.nivoda, log }),
  },
  'supplier-holds': {
    everyMs: config.supplierHoldIntervalMs,
    run: () => runSupplierHolds({ db: prisma, nivoda: config.nivoda, enabled: config.nivodaAutoHold, log }),
  },
  'cart-cleanup': {
    everyMs: config.cleanupIntervalMs,
    run: () => runCartCleanup({ db: prisma, credentialsKey: config.credentialsKey, log }),
  },
} as const;
type JobName = keyof typeof jobs;

/** Run a job; a failure is logged, never thrown, so one bad run cannot stop the schedule. */
async function attempt(name: JobName): Promise<boolean> {
  const started = Date.now();
  try {
    await jobs[name].run();
    log.info(`[worker] ${name} finished in ${Math.round((Date.now() - started) / 1000)}s`);
    return true;
  } catch (err) {
    log.error(`[worker] ${name} failed:`, err);
    return false;
  }
}

async function shutdown(code: number): Promise<never> {
  await cache.close();
  await prisma.$disconnect();
  process.exit(code);
}

const onceAt = process.argv.indexOf('--once');
if (onceAt !== -1) {
  const name = process.argv[onceAt + 1] as JobName | undefined;
  if (!name || !(name in jobs)) {
    log.error(`usage: --once <${Object.keys(jobs).join('|')}>`);
    await shutdown(2);
  }
  await shutdown((await attempt(name!)) ? 0 : 1);
}

// Each job waits its full interval after finishing, so a slow run never overlaps the next.
const timers = new Map<JobName, NodeJS.Timeout>();
let stopping = false;
function schedule(name: JobName, delayMs: number): void {
  timers.set(
    name,
    setTimeout(async () => {
      await attempt(name);
      if (!stopping) schedule(name, jobs[name].everyMs);
    }, delayMs),
  );
}
(Object.keys(jobs) as JobName[]).forEach((name, i) => schedule(name, 1000 + i * 5000));
log.info(`[worker] started: ${Object.entries(jobs).map(([n, j]) => `${n} every ${j.everyMs / 60_000} min`).join(', ')}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info(`[worker] ${signal} received, stopping`);
    stopping = true;
    for (const timer of timers.values()) clearTimeout(timer);
    void shutdown(0);
  });
}
