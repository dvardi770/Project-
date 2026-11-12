import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { prisma, type PrismaClient } from '@jewelry/db';
import { MemoryCache, RedisCache, type Cache } from './common/cache';
import type { AppDeps } from './common/context';
import { registerErrorHandler } from './common/errors';
import { createMarkupMatrixLoader } from './common/markupMatrix';
import { hostnameOf, registerTenantAuth } from './common/tenantAuth';
import { loadConfig, type AppConfig } from './config/env';
import { cartRoutes } from './routes/cart';
import { diamondRoutes } from './routes/diamonds';
import { settingRoutes } from './routes/settings';

export interface BuildServerOptions {
  config: AppConfig;
  db: PrismaClient;
  cache: Cache;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config, db, cache } = options;
  const deps: AppDeps = { config, db, cache, markupMatrix: createMarkupMatrixLoader(db) };

  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== 'test',
    trustProxy: true, // behind a load balancer
    bodyLimit: 64 * 1024,
  });
  registerErrorHandler(app);

  // The widget runs on merchants' storefronts, so every browser call is
  // cross-origin. An origin is allowed when its hostname is a registered
  // tenant domain; which tenant it belongs to is checked again, against the
  // API key, in registerTenantAuth.
  const isKnownOrigin = async (origin: string): Promise<boolean> => {
    if (config.corsDevOrigins.includes(origin)) return true;
    const hostname = hostnameOf(origin);
    if (!hostname) return false;
    const key = `cors:host:${hostname}`;
    const cached = await cache.get<boolean>(key);
    if (cached !== null) return cached;
    const known = (await db.tenantDomain.count({ where: { hostname } })) > 0;
    await cache.set(key, known, 60);
    return known;
  };

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, false); // server-to-server: no CORS headers needed
      isKnownOrigin(origin).then(
        (known) => callback(null, known),
        (err: Error) => callback(err, false),
      );
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-api-key', 'authorization'],
    exposedHeaders: ['x-cache'],
    maxAge: 600,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      registerTenantAuth(api, deps);
      await api.register(diamondRoutes, deps);
      await api.register(settingRoutes, deps);
      await api.register(cartRoutes, deps);
    },
    { prefix: '/api/v1' },
  );

  app.addHook('onClose', async () => {
    await cache.close();
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const cache = config.redisUrl
    ? new RedisCache(config.redisUrl, (err) => console.warn(`[redis] ${err.message}`))
    : new MemoryCache();
  const app = await buildServer({ config, db: prisma, cache });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
