import { FeedSource } from '@jewelry/db';
import { z } from 'zod';

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  REDIS_URL: z.string().url().optional(),
  BUNDLE_SIGNING_SECRET: z.string().min(32, 'must be at least 32 characters'),
  BUNDLE_TTL_SECONDS: z.coerce.number().int().min(60).default(1800),
  SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
  PLATFORM_FEEDS: z.string().default('NIVODA'),
  CORS_DEV_ORIGINS: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  redisUrl?: string;
  bundleSigningSecret: string;
  bundleTtlSeconds: number;
  searchCacheTtlSeconds: number;
  /** Feeds every tenant can search through the platform's own account. */
  platformFeeds: FeedSource[];
  /** Exact origins (scheme://host[:port]) allowed in addition to tenant domains. */
  corsDevOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  const e = parsed.data;
  const feeds = csv(e.PLATFORM_FEEDS).map((f) => f.toUpperCase());
  const unknown = feeds.filter((f) => !(f in FeedSource));
  if (unknown.length) throw new Error(`Invalid environment: PLATFORM_FEEDS has unknown feed ${unknown.join(', ')}`);

  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    bundleSigningSecret: e.BUNDLE_SIGNING_SECRET,
    bundleTtlSeconds: e.BUNDLE_TTL_SECONDS,
    searchCacheTtlSeconds: e.SEARCH_CACHE_TTL_SECONDS,
    platformFeeds: feeds as FeedSource[],
    corsDevOrigins: csv(e.CORS_DEV_ORIGINS),
  };
}
