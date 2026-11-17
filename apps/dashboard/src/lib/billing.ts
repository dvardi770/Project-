/**
 * Recurring monthly billing for merchants.
 *
 *   Shopify stores    → Shopify Billing API. Shopify requires apps to bill
 *                       through it; the charge appears on the merchant's
 *                       Shopify invoice.
 *   Everyone else     → Stripe Subscriptions (WooCommerce, Wix, custom sites).
 *
 * Both providers run the monthly cycle themselves. This module starts a
 * subscription, and keeps Tenant.subscriptionStatus in step with the provider
 * through webhooks. The storefront API refuses tenants that are not ACTIVE or
 * TRIALING, so this status is what switches a store's ring builder on and off.
 *
 * Whenever a webhook says "something changed", the current state is fetched
 * from the provider and applied, rather than trusting the event's own payload:
 * webhooks arrive late, twice and out of order.
 *
 * Nothing here depends on Next.js; the route handlers in app/api/billing are
 * thin wrappers around these functions.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PlatformType, PrismaClient, SubscriptionStatus, Tenant } from '@jewelry/db';
import { ShopifyConnector, decryptJson, decryptSecret, type ShopifyCredentials } from '@jewelry/platforms';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface BillingConfig {
  /** Public origin of the dashboard, no trailing slash. */
  dashboardUrl: string;
  planName: string;
  /** Monthly price in USD as a decimal string, used for Shopify. Stripe's amount lives on its Price. */
  priceUsd: string;
  stripeSecretKey?: string;
  stripePriceId?: string;
  stripeWebhookSecret?: string;
  stripeApiBase: string;
  shopifyAppSecret?: string;
  /** Create Shopify test charges (never billed). Required on development stores. */
  shopifyTestCharges: boolean;
  credentialsKey: Buffer | null;
}

export interface BillingDeps {
  db: PrismaClient;
  config: BillingConfig;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export type BillingProvider = 'SHOPIFY' | 'STRIPE';

export const providerFor = (platform: PlatformType): BillingProvider => (platform === 'SHOPIFY' ? 'SHOPIFY' : 'STRIPE');

/** A problem the merchant (or operator) can act on; safe to show in the dashboard. */
export class BillingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

const isLive = (status: SubscriptionStatus) => status === 'ACTIVE' || status === 'TRIALING' || status === 'PAST_DUE';

// ─── Stripe ──────────────────────────────────────────────────────────────────

/** Stripe's API takes form encoding with bracketed keys: a[b][0][c]=1. */
function formEncode(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) value.forEach((v, i) => formEncode(v, `${prefix}[${i}]`, out));
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
  } else out.set(prefix, String(value));
  return out;
}

async function stripe<T>(deps: BillingDeps, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const key = deps.config.stripeSecretKey;
  if (!key) throw new BillingError('stripe_not_configured', 'Card billing is not set up on this server.');
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${deps.config.stripeApiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? formEncode(body).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new BillingError('stripe_unreachable', `Could not reach Stripe: ${(err as Error).message}`);
  }
  const json = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok || !json) {
    throw new BillingError('stripe_error', json?.error?.message ?? `Stripe responded with ${response.status}`);
  }
  return json;
}

/** The parts of a Stripe Subscription this module reads. */
interface StripeSubscription {
  id: string;
  customer: string | { id: string };
  status: string;
  trial_end?: number | null;
  /** Top-level on older API versions; on each item from 2025 onward. */
  current_period_end?: number | null;
  items?: { data?: { current_period_end?: number | null }[] };
  metadata?: Record<string, string>;
}

export function mapStripeStatus(status: string): SubscriptionStatus | null {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'paused':
      return 'PAUSED';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
    default:
      // "incomplete": the first payment has not gone through yet. Nothing to record.
      return null;
  }
}

const fromUnix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null);

async function applyStripeSubscription(deps: BillingDeps, tenantId: string, sub: StripeSubscription): Promise<void> {
  const status = mapStripeStatus(sub.status);
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  await deps.db.tenant.update({
    where: { id: tenantId },
    data: {
      billingCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      billingSubscriptionId: sub.id,
      currentPeriodEndsAt: fromUnix(periodEnd),
      ...(sub.status === 'trialing' ? { trialEndsAt: fromUnix(sub.trial_end) } : {}),
      ...(status ? { subscriptionStatus: status } : {}),
    },
  });
}

async function startStripeCheckout(deps: BillingDeps, tenant: Tenant): Promise<string> {
  const { config } = deps;
  if (!config.stripePriceId) throw new BillingError('stripe_not_configured', 'Card billing is not set up on this server.');
  // Someone who already subscribed manages that subscription instead of buying a second one.
  if (tenant.billingSubscriptionId && isLive(tenant.subscriptionStatus)) return openBillingPortal(deps, tenant);

  const session = await stripe<{ url: string | null }>(deps, 'POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: config.stripePriceId, quantity: 1 }],
    success_url: `${config.dashboardUrl}/billing?checkout=success`,
    cancel_url: `${config.dashboardUrl}/billing?checkout=canceled`,
    // Both are echoed back in webhooks; they tie the payment to the tenant.
    client_reference_id: tenant.id,
    subscription_data: { metadata: { tenant_id: tenant.id } },
    ...(tenant.billingCustomerId ? { customer: tenant.billingCustomerId } : {}),
  });
  if (!session.url) throw new BillingError('stripe_error', 'Stripe did not return a checkout page.');
  return session.url;
}

/** Stripe's hosted page for updating a card, seeing invoices or cancelling. */
export async function openBillingPortal(deps: BillingDeps, tenant: Tenant): Promise<string> {
  if (providerFor(tenant.platformType) !== 'STRIPE') {
    throw new BillingError('managed_by_shopify', 'This subscription is managed in your Shopify admin, under Apps.');
  }
  if (!tenant.billingCustomerId) throw new BillingError('no_subscription', 'There is no subscription to manage yet.');
  const session = await stripe<{ url: string }>(deps, 'POST', '/v1/billing_portal/sessions', {
    customer: tenant.billingCustomerId,
    return_url: `${deps.config.dashboardUrl}/billing`,
  });
  return session.url;
}

/**
 * Check a Stripe-Signature header: "t=<unix>,v1=<hex>[,v1=<hex>…]" where each
 * v1 is HMAC-SHA256("<t>.<raw body>") with the endpoint's signing secret.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  let timestamp = '';
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value) timestamp = value;
    if (key === 'v1' && value) candidates.push(value);
  }
  if (!/^\d+$/.test(timestamp) || candidates.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false; // replay window, as Stripe's own library
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return candidates.some((candidate) => {
    if (!/^[0-9a-f]{64}$/i.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate, 'hex'), expected);
  });
}

export type WebhookOutcome =
  | { status: 200; handled: boolean; tenantId?: string }
  | { status: 400 | 401 | 503; error: string };

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

export async function handleStripeWebhook(deps: BillingDeps, rawBody: string, signature: string | null): Promise<WebhookOutcome> {
  const secret = deps.config.stripeWebhookSecret;
  if (!secret) return { status: 503, error: 'Stripe webhooks are not configured' };
  if (!verifyStripeSignature(rawBody, signature, secret, deps.now?.())) return { status: 401, error: 'Invalid signature' };

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { status: 400, error: 'Body is not JSON' };
  }
  const object = event.data?.object ?? {};
  const idOf = (value: unknown) => (typeof value === 'string' ? value : ((value as { id?: string } | null)?.id ?? null));

  // Work out which subscription changed and, where the event says so, whose it is.
  let subscriptionId: string | null = null;
  let tenantId: string | null = null;
  if (event.type === 'checkout.session.completed') {
    if (object.mode !== 'subscription') return { status: 200, handled: false };
    subscriptionId = idOf(object.subscription);
    tenantId = typeof object.client_reference_id === 'string' ? object.client_reference_id : null;
  } else if (SUBSCRIPTION_EVENTS.has(event.type)) {
    subscriptionId = idOf(object.id);
  } else if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
    subscriptionId = idOf(object.subscription) ?? idOf((object.parent as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details?.subscription);
  } else {
    return { status: 200, handled: false };
  }
  if (!subscriptionId) return { status: 200, handled: false };

  // The event is only a prompt; Stripe's current record is the truth.
  const sub = await stripe<StripeSubscription>(deps, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  tenantId ??= sub.metadata?.tenant_id ?? null;
  const tenant =
    (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId) ? await deps.db.tenant.findUnique({ where: { id: tenantId } }) : null) ??
    (await deps.db.tenant.findFirst({ where: { billingSubscriptionId: sub.id } }));
  if (!tenant) return { status: 200, handled: false }; // not one of ours; acknowledge so Stripe stops retrying

  // An old, cancelled subscription must not overwrite the state of its replacement.
  if (tenant.billingSubscriptionId && tenant.billingSubscriptionId !== sub.id && mapStripeStatus(sub.status) === 'CANCELED') {
    return { status: 200, handled: false, tenantId: tenant.id };
  }
  await applyStripeSubscription(deps, tenant.id, sub);
  return { status: 200, handled: true, tenantId: tenant.id };
}

// ─── Shopify ─────────────────────────────────────────────────────────────────

const APP_SUBSCRIPTION_CREATE = `
  mutation StartSubscription($name: String!, $returnUrl: URL!, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }`;

const ACTIVE_SUBSCRIPTIONS = `{
  currentAppInstallation { activeSubscriptions { id name status currentPeriodEnd test } }
}`;

function shopifyAdmin(deps: BillingDeps, tenant: Tenant): ShopifyConnector {
  if (!deps.config.credentialsKey || !tenant.platformCredentialsEnc) {
    throw new BillingError('shopify_not_connected', 'This store is not connected to Shopify yet.');
  }
  try {
    const credentials = decryptJson<ShopifyCredentials>(tenant.platformCredentialsEnc, deps.config.credentialsKey);
    return new ShopifyConnector(credentials, { fetch: deps.fetch });
  } catch {
    throw new BillingError('shopify_not_connected', "This store's Shopify connection needs to be set up again.");
  }
}

async function startShopifySubscription(deps: BillingDeps, tenant: Tenant): Promise<string> {
  const { config } = deps;
  let result;
  try {
    result = await shopifyAdmin(deps, tenant).graphql<{
      appSubscriptionCreate: {
        confirmationUrl: string | null;
        userErrors: { message: string }[];
      };
    }>(APP_SUBSCRIPTION_CREATE, {
      name: config.planName,
      returnUrl: `${config.dashboardUrl}/api/billing/shopify/return`,
      test: config.shopifyTestCharges,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: config.priceUsd, currencyCode: 'USD' },
              interval: 'EVERY_30_DAYS',
            },
          },
        },
      ],
    });
  } catch (err) {
    if (err instanceof BillingError) throw err;
    throw new BillingError('shopify_error', `Shopify did not accept the request: ${(err as Error).message}`);
  }
  const { confirmationUrl, userErrors } = result.appSubscriptionCreate;
  if (userErrors.length) throw new BillingError('shopify_error', userErrors.map((e) => e.message).join('; '));
  if (!confirmationUrl) throw new BillingError('shopify_error', 'Shopify did not return an approval page.');
  // The merchant approves the charge on this Shopify page, then lands on returnUrl.
  return confirmationUrl;
}

export function mapShopifyStatus(status: string): SubscriptionStatus | null {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'FROZEN': // the shop's own Shopify bill is unpaid
      return 'PAST_DUE';
    case 'CANCELLED':
    case 'DECLINED':
    case 'EXPIRED':
      return 'CANCELED';
    default: // PENDING: waiting for the merchant to approve
      return null;
  }
}

/** Ask Shopify what the store is subscribed to right now and record it. */
export async function syncShopifySubscription(deps: BillingDeps, tenant: Tenant): Promise<SubscriptionStatus> {
  const data = await shopifyAdmin(deps, tenant).graphql<{
    currentAppInstallation: {
      activeSubscriptions: { id: string; status: string; currentPeriodEnd: string | null }[];
    };
  }>(ACTIVE_SUBSCRIPTIONS);
  const active = data.currentAppInstallation.activeSubscriptions.find((s) => s.status === 'ACTIVE');

  if (active) {
    await deps.db.tenant.update({
      where: { id: tenant.id },
      data: {
        subscriptionStatus: 'ACTIVE',
        billingSubscriptionId: active.id,
        currentPeriodEndsAt: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
      },
    });
    return 'ACTIVE';
  }
  // No active subscription. Only a store that had one is downgraded: a trial
  // that has simply not subscribed yet keeps its trial.
  if (tenant.billingSubscriptionId) {
    await deps.db.tenant.update({ where: { id: tenant.id }, data: { subscriptionStatus: 'CANCELED' } });
    return 'CANCELED';
  }
  return tenant.subscriptionStatus;
}

/**
 * Shopify's `app_subscriptions/update` webhook. Signed like every Shopify
 * webhook: base64 HMAC-SHA256 of the raw body in X-Shopify-Hmac-Sha256.
 */
export async function handleShopifyBillingWebhook(
  deps: BillingDeps,
  rawBody: string,
  headers: { hmac: string | null; shop: string | null },
): Promise<WebhookOutcome> {
  const shop = headers.shop?.toLowerCase() ?? '';
  const tenant = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)
    ? await deps.db.tenant.findFirst({ where: { platformType: 'SHOPIFY', platformStoreId: shop } })
    : null;

  const secrets: string[] = [];
  if (deps.config.shopifyAppSecret) secrets.push(deps.config.shopifyAppSecret);
  if (tenant?.platformWebhookSecretEnc && deps.config.credentialsKey) {
    try {
      secrets.push(decryptSecret(tenant.platformWebhookSecretEnc, deps.config.credentialsKey));
    } catch {
      // an unreadable stored secret cannot vouch for anything
    }
  }
  const given = Buffer.from(headers.hmac ?? '', 'base64');
  const authentic = secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!authentic) return { status: 401, error: 'Invalid signature' };
  if (!tenant) return { status: 200, handled: false };

  try {
    await syncShopifySubscription(deps, tenant);
  } catch {
    // The store's token no longer works (for example the app was uninstalled),
    // so fall back to what the webhook itself reports.
    let status: SubscriptionStatus | null = null;
    try {
      const payload = JSON.parse(rawBody) as { app_subscription?: { status?: string } };
      status = mapShopifyStatus(payload.app_subscription?.status ?? '');
    } catch {
      return { status: 400, error: 'Body is not JSON' };
    }
    if (status) await deps.db.tenant.update({ where: { id: tenant.id }, data: { subscriptionStatus: status } });
  }
  return { status: 200, handled: true, tenantId: tenant.id };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Begin (or resume managing) the tenant's subscription. Returns where to send the merchant. */
export async function startSubscription(deps: BillingDeps, tenantId: string): Promise<string> {
  const tenant = await deps.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return providerFor(tenant.platformType) === 'SHOPIFY'
    ? startShopifySubscription(deps, tenant)
    : startStripeCheckout(deps, tenant);
}
