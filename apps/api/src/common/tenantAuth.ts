import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiKeyType, FeedSource } from '@jewelry/db';
import { ttlMemo } from './cache';
import type { AppDeps } from './context';
import { forbidden, unauthorized } from './errors';

export interface TenantContext {
  tenantId: string;
  keyType: ApiKeyType;
  defaultCurrency: string;
  /** Feeds this tenant may search: platform feeds plus its own connections. */
  feedSources: FeedSource[];
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

/** Only this hash is stored in api_keys.keyHash. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function extractKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header) return header.trim();
  const auth = request.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

export function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Refuses tenants whose subscription does not entitle them to the storefront API. */
export function assertSubscribed(tenant: { subscriptionStatus: string }): void {
  if (tenant.subscriptionStatus !== 'ACTIVE' && tenant.subscriptionStatus !== 'TRIALING') {
    throw forbidden('subscription_inactive', 'This account does not have an active subscription.');
  }
}

/** What the routes need to know about the caller, however it was authenticated. */
export function toTenantContext(
  tenant: { id: string; defaultCurrency: string; feedConnections: { source: FeedSource }[] },
  keyType: ApiKeyType,
  config: AppDeps['config'],
): TenantContext {
  return {
    tenantId: tenant.id,
    keyType,
    defaultCurrency: tenant.defaultCurrency,
    feedSources: [...new Set([...config.platformFeeds, ...tenant.feedConnections.map((c) => c.source)])],
  };
}

/**
 * Resolves the calling tenant from its API key on every request in scope.
 *
 * Publishable keys are visible in storefront HTML, so they only work from the
 * tenant's registered domains. Secret keys are for server-to-server calls.
 */
export function registerTenantAuth(app: FastifyInstance, deps: AppDeps): void {
  const { db, config } = deps;

  const lookup = ttlMemo(30_000, async (keyHash: string) => {
    const key = await db.apiKey.findUnique({
      where: { keyHash },
      include: {
        tenant: {
          include: {
            domains: { select: { hostname: true } },
            feedConnections: { where: { isEnabled: true }, select: { source: true } },
          },
        },
      },
    });
    return key;
  });

  app.decorateRequest('tenant');

  // preParsing runs after the rate limiter (onRequest) and before the body is read.
  app.addHook('preParsing', async (request) => {
    if (request.method === 'OPTIONS') return; // CORS preflight carries no key

    const rawKey = extractKey(request);
    if (!rawKey) throw unauthorized('Missing API key. Send it in the x-api-key header.');

    const key = await lookup(hashApiKey(rawKey));
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()) || key.tenant.deletedAt) {
      throw unauthorized('Invalid API key.');
    }
    const { tenant } = key;
    assertSubscribed(tenant);

    if (key.type === 'PUBLISHABLE') {
      const origin = request.headers.origin;
      const allowed =
        typeof origin === 'string' &&
        (config.corsDevOrigins.includes(origin) ||
          tenant.domains.some((d) => d.hostname === hostnameOf(origin)));
      if (!allowed) {
        throw forbidden('origin_not_allowed', 'This API key cannot be used from this origin.');
      }
    }

    request.tenant = toTenantContext(tenant, key.type, config);
  });
}
