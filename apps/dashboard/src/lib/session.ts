/**
 * Dashboard sign-in.
 *
 * A merchant signs in with their account's secret API key (sk_…). The key is
 * checked against its stored hash and exchanged for a signed, HTTP-only cookie
 * naming the tenant; the key itself is never stored in the browser.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma, type Tenant } from '@jewelry/db';
import { sessionSecret } from './env';

const COOKIE = 'jb_session';
const MAX_AGE_SECONDS = 12 * 60 * 60;

const sign = (payload: string) => createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

export function encodeSession(tenantId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, e: Math.floor(now / 1000) + MAX_AGE_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { t, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t?: string; e?: number };
    return typeof t === 'string' && typeof e === 'number' && e * 1000 > now ? t : null;
  } catch {
    return null;
  }
}

/** Exchange a secret API key for a session. Returns false if the key is not valid. */
export async function signIn(secretKey: string): Promise<boolean> {
  const key = secretKey.trim();
  if (!key.startsWith('sk_')) return false;
  const record = await prisma.apiKey.findUnique({
    where: { keyHash: createHash('sha256').update(key).digest('hex') },
    include: { tenant: { select: { id: true, deletedAt: true } } },
  });
  const usable =
    record && record.type === 'SECRET' && !record.revokedAt && (!record.expiresAt || record.expiresAt > new Date()) && !record.tenant.deletedAt;
  if (!usable) return false;

  (await cookies()).set(COOKIE, encodeSession(record.tenant.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return true;
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in tenant, or null. */
export async function currentTenant(): Promise<Tenant | null> {
  const tenantId = decodeSession((await cookies()).get(COOKIE)?.value);
  if (!tenantId) return null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  return tenant && !tenant.deletedAt ? tenant : null;
}

/** For pages and actions that need a signed-in merchant. */
export async function requireTenant(): Promise<Tenant> {
  const tenant = await currentTenant();
  if (!tenant) redirect('/login');
  return tenant;
}

export const hasActiveSubscription = (tenant: Pick<Tenant, 'subscriptionStatus'>) =>
  tenant.subscriptionStatus === 'ACTIVE' || tenant.subscriptionStatus === 'TRIALING';
