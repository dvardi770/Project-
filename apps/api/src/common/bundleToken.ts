import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * What the server priced. The storefront carries this token through the cart;
 * the order webhook verifies it, so a shopper cannot change the price or swap
 * components client-side.
 */
export interface BundleClaims {
  v: 1;
  bundleId: string;
  tenantId: string;
  settingVariantId: string;
  diamondId: string;
  ringSize: string;
  engraving: string | null;
  settingPrice: string;
  diamondPrice: string;
  total: string;
  currency: string;
  /** Unix seconds. */
  expiresAt: number;
}

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export function signBundleToken(claims: BundleClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the claims, or null if the token is malformed, forged or expired. */
export function verifyBundleToken(token: string, secret: string, now = Date.now()): BundleClaims | null {
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as BundleClaims;
    if (claims.v !== 1 || claims.expiresAt * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
