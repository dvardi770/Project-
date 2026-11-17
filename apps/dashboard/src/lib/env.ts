import { parseEncryptionKey } from '@jewelry/platforms';
import type { BillingConfig } from './billing';

/** Read at request time, never at build time, so `next build` needs no secrets. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function sessionSecret(): string {
  const secret = required('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return secret;
}

export function dashboardUrl(): string {
  return required('DASHBOARD_URL').replace(/\/+$/, '');
}

export function foundryName(): string {
  return process.env.PLATFORM_FOUNDRY_NAME?.trim() || 'Platform Foundry';
}

export function billingConfig(): BillingConfig {
  const price = process.env.BILLING_PRICE_USD ?? '99.00';
  if (!/^\d+(\.\d{1,2})?$/.test(price)) throw new Error('BILLING_PRICE_USD must be an amount such as 99.00');
  return {
    dashboardUrl: dashboardUrl(),
    planName: process.env.BILLING_PLAN_NAME?.trim() || 'Jewelry Builder',
    priceUsd: price,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || undefined,
    stripePriceId: process.env.STRIPE_PRICE_ID || undefined,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
    // Only for pointing at a local Stripe stand-in during tests.
    stripeApiBase: process.env.STRIPE_API_BASE || 'https://api.stripe.com',
    shopifyAppSecret: process.env.SHOPIFY_APP_SECRET || undefined,
    shopifyTestCharges: process.env.SHOPIFY_BILLING_TEST === 'true',
    credentialsKey: process.env.CREDENTIALS_ENCRYPTION_KEY
      ? parseEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY)
      : null,
  };
}
