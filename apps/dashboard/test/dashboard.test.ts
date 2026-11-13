/**
 * Billing, markup matrix and fulfilment logic against a real Postgres, with the
 * billing providers replaced by a recording stand-in. Skipped unless
 * TEST_DATABASE_URL is set (see apps/api/test/api.test.ts).
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Tenant } from '@jewelry/db';
import { calculateRetailPrice } from '@jewelry/pricing';
import { encryptJson, parseEncryptionKey } from '@jewelry/platforms';
import {
  handleShopifyBillingWebhook,
  handleStripeWebhook,
  mapShopifyStatus,
  mapStripeStatus,
  openBillingPortal,
  startSubscription,
  syncShopifySubscription,
  verifyStripeSignature,
  type BillingConfig,
  type BillingDeps,
} from '../src/lib/billing';
import { fulfillViaFoundry, listOrders } from '../src/lib/fulfillment';
import { DEFAULT_MATRIX, previewPrice, rulesToMatrix, saveMatrix } from '../src/lib/markup';

const url = process.env.TEST_DATABASE_URL;
const KEY = parseEncryptionKey('ef'.repeat(32));
const WHSEC = 'whsec_test_secret';
const APP_SECRET = 'shopify-app-secret';

describe.skipIf(!url)('dashboard', () => {
  let db: PrismaClient;
  let stripeTenant: Tenant;
  let shopifyTenant: Tenant;
  let variantId: string;

  /** Requests made to Stripe / Shopify, and the scripted replies. */
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  let reply: (url: string, body: string) => unknown = () => ({});
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body });
    const result = reply(String(input), body);
    const status = (result as { __status?: number }).__status ?? 200;
    return new Response(JSON.stringify(result), { status });
  }) as typeof fetch;

  const config: BillingConfig = {
    dashboardUrl: 'https://dash.example.com',
    planName: 'Jewelry Builder',
    priceUsd: '99.00',
    stripeSecretKey: 'sk_test_stripe',
    stripePriceId: 'price_monthly',
    stripeWebhookSecret: WHSEC,
    stripeApiBase: 'https://api.stripe.test',
    shopifyAppSecret: APP_SECRET,
    shopifyTestCharges: true,
    credentialsKey: KEY,
  };
  const deps = (): BillingDeps => ({ db, config, fetch: fakeFetch });
  const fresh = (t: Tenant) => db.tenant.findUniqueOrThrow({ where: { id: t.id } });

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: url });
    await db.$executeRawUnsafe(
      'TRUNCATE "tenants", "diamond_cache", "virtual_settings", "casting_vendors", "custom_merchant_stock" RESTART IDENTITY CASCADE',
    );
    stripeTenant = await db.tenant.create({
      data: { name: 'Woo Jeweler', slug: 'woo-jeweler', platformType: 'WOOCOMMERCE', subscriptionStatus: 'TRIALING' },
    });
    shopifyTenant = await db.tenant.create({
      data: {
        name: 'Shopify Jeweler',
        slug: 'shopify-jeweler',
        platformType: 'SHOPIFY',
        platformStoreId: 'jeweler.myshopify.com',
        subscriptionStatus: 'TRIALING',
        platformCredentialsEnc: encryptJson({ shopDomain: 'jeweler.myshopify.com', accessToken: 'shpat_x' }, KEY),
      },
    });
    const setting = await db.virtualSetting.create({
      data: {
        sku: 'D-1',
        name: 'Dashboard Solitaire',
        style: 'SOLITAIRE',
        compatibleShapes: ['ROUND'],
        centerCaratMin: '0.5',
        centerCaratMax: '3',
        cadId: 'CAD-D',
        variants: { create: { metal: 'WHITE_GOLD_14K', castingCost: '400' } },
      },
      include: { variants: true },
    });
    variantId = setting.variants[0]!.id;
  });

  beforeEach(() => {
    calls.length = 0;
    reply = () => ({});
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  // ── Stripe ──────────────────────────────────────────────────────────────────

  describe('Stripe subscriptions', () => {
    const sign = (body: string, secret = WHSEC, at = Math.floor(Date.now() / 1000)) =>
      `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
    const event = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: 'evt_1', type, data: { object } });
    const subscription = (over: Record<string, unknown> = {}) => ({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      items: { data: [{ current_period_end: 1800000000 }] },
      metadata: { tenant_id: stripeTenant.id },
      ...over,
    });

    it('starts Checkout in subscription mode, tied to the tenant', async () => {
      reply = () => ({ url: 'https://checkout.stripe.test/c/pay_1' });
      expect(await startSubscription(deps(), stripeTenant.id)).toBe('https://checkout.stripe.test/c/pay_1');

      const call = calls[0]!;
      expect(call.url).toBe('https://api.stripe.test/v1/checkout/sessions');
      expect(call.headers.authorization).toBe('Bearer sk_test_stripe');
      expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
        mode: 'subscription',
        'line_items[0][price]': 'price_monthly',
        'line_items[0][quantity]': '1',
        success_url: 'https://dash.example.com/billing?checkout=success',
        cancel_url: 'https://dash.example.com/billing?checkout=canceled',
        client_reference_id: stripeTenant.id,
        'subscription_data[metadata][tenant_id]': stripeTenant.id,
      });
    });

    it('verifies webhook signatures the way Stripe signs them', () => {
      const body = '{"a":1}';
      expect(verifyStripeSignature(body, sign(body), WHSEC)).toBe(true);
      expect(verifyStripeSignature(body + ' ', sign(body), WHSEC)).toBe(false); // body changed
      expect(verifyStripeSignature(body, sign(body, 'other'), WHSEC)).toBe(false);
      expect(verifyStripeSignature(body, sign(body, WHSEC, Math.floor(Date.now() / 1000) - 3600), WHSEC)).toBe(false); // replayed
      expect(verifyStripeSignature(body, null, WHSEC)).toBe(false);
      expect(verifyStripeSignature(body, 't=abc,v1=zz', WHSEC)).toBe(false);
      // during secret rotation Stripe sends two v1 values; either may match
      const at = Math.floor(Date.now() / 1000);
      const good = createHmac('sha256', WHSEC).update(`${at}.${body}`).digest('hex');
      expect(verifyStripeSignature(body, `t=${at},v1=${'0'.repeat(64)},v1=${good}`, WHSEC)).toBe(true);
    });

    it('activates the tenant when checkout completes, using Stripe’s current record', async () => {
      reply = (u) => (u.endsWith('/v1/subscriptions/sub_1') ? subscription() : {});
      const body = event('checkout.session.completed', {
        mode: 'subscription',
        subscription: 'sub_1',
        customer: 'cus_1',
        client_reference_id: stripeTenant.id,
      });
      expect(await handleStripeWebhook(deps(), body, sign(body))).toEqual({ status: 200, handled: true, tenantId: stripeTenant.id });
      expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.stripe.test/v1/subscriptions/sub_1' });

      const t = await fresh(stripeTenant);
      expect(t).toMatchObject({ subscriptionStatus: 'ACTIVE', billingCustomerId: 'cus_1', billingSubscriptionId: 'sub_1' });
      expect(t.currentPeriodEndsAt).toEqual(new Date(1800000000 * 1000));
    });

    it('follows the subscription through failed payment, recovery and cancellation', async () => {
      const send = async (type: string, current: Record<string, unknown>, object: Record<string, unknown> = { id: 'sub_1' }) => {
        reply = () => subscription(current);
        const body = event(type, object);
        const outcome = await handleStripeWebhook(deps(), body, sign(body));
        return [outcome.status, (await fresh(stripeTenant)).subscriptionStatus];
      };
      expect(await send('invoice.payment_failed', { status: 'past_due' }, { subscription: 'sub_1' })).toEqual([200, 'PAST_DUE']);
      // the event says "active" in its payload, but only Stripe's record is believed
      expect(await send('customer.subscription.updated', { status: 'past_due' }, { id: 'sub_1', status: 'active' })).toEqual([200, 'PAST_DUE']);
      expect(await send('customer.subscription.updated', { status: 'active' })).toEqual([200, 'ACTIVE']);
      expect(await send('customer.subscription.paused', { status: 'paused' })).toEqual([200, 'PAUSED']);
      // older API versions carry the period end on the subscription itself
      expect(await send('customer.subscription.resumed', { status: 'active', items: undefined, current_period_end: 1900000000 })).toEqual([200, 'ACTIVE']);
      expect((await fresh(stripeTenant)).currentPeriodEndsAt).toEqual(new Date(1900000000 * 1000));
      expect(await send('customer.subscription.deleted', { status: 'canceled' })).toEqual([200, 'CANCELED']);
    });

    it('does not let an old cancelled subscription undo its replacement', async () => {
      await db.tenant.update({ where: { id: stripeTenant.id }, data: { subscriptionStatus: 'ACTIVE', billingSubscriptionId: 'sub_2' } });
      reply = () => ({ id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { tenant_id: stripeTenant.id } });
      const body = event('customer.subscription.deleted', { id: 'sub_1' });
      expect((await handleStripeWebhook(deps(), body, sign(body))).status).toBe(200);
      expect(await fresh(stripeTenant)).toMatchObject({ subscriptionStatus: 'ACTIVE', billingSubscriptionId: 'sub_2' });
    });

    it('rejects forged events and ignores ones that are not ours', async () => {
      const body = event('customer.subscription.updated', { id: 'sub_2' });
      expect(await handleStripeWebhook(deps(), body, sign(body, 'wrong'))).toEqual({ status: 401, error: 'Invalid signature' });
      expect(calls).toHaveLength(0);

      const other = event('payment_intent.succeeded', { id: 'pi_1' });
      expect(await handleStripeWebhook(deps(), other, sign(other))).toEqual({ status: 200, handled: false });

      reply = () => ({ id: 'sub_9', customer: 'cus_9', status: 'active', metadata: {} });
      const stranger = event('customer.subscription.updated', { id: 'sub_9' });
      expect(await handleStripeWebhook(deps(), stranger, sign(stranger))).toEqual({ status: 200, handled: false });

      const unconfigured = { ...deps(), config: { ...config, stripeWebhookSecret: undefined } };
      expect((await handleStripeWebhook(unconfigured, body, sign(body))).status).toBe(503);
    });

    it('sends an existing subscriber to the billing portal instead of a second checkout', async () => {
      reply = () => ({ url: 'https://billing.stripe.test/p/session_1' });
      expect(await startSubscription(deps(), stripeTenant.id)).toBe('https://billing.stripe.test/p/session_1');
      expect(calls[0]!.url).toBe('https://api.stripe.test/v1/billing_portal/sessions');
      expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
        customer: 'cus_1',
        return_url: 'https://dash.example.com/billing',
      });
      await expect(openBillingPortal(deps(), shopifyTenant)).rejects.toThrow(/Shopify admin/);
    });

    it('surfaces Stripe’s own error message', async () => {
      await db.tenant.update({ where: { id: stripeTenant.id }, data: { subscriptionStatus: 'CANCELED' } });
      reply = () => ({ __status: 400, error: { message: 'No such price: price_monthly' } });
      await expect(startSubscription(deps(), stripeTenant.id)).rejects.toThrow('No such price: price_monthly');
      await expect(startSubscription({ ...deps(), config: { ...config, stripeSecretKey: undefined } }, stripeTenant.id)).rejects.toThrow(/not set up/);
    });

    it('maps every Stripe status', () => {
      expect(['trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete_expired', 'incomplete'].map(mapStripeStatus)).toEqual([
        'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAST_DUE', 'PAUSED', 'CANCELED', 'CANCELED', null,
      ]);
    });
  });

  // ── Shopify ─────────────────────────────────────────────────────────────────

  describe('Shopify Billing API', () => {
    const active = (subs: unknown[]) => ({ data: { currentAppInstallation: { activeSubscriptions: subs } } });
    const hmac = (body: string, secret = APP_SECRET) => createHmac('sha256', secret).update(body).digest('base64');

    it('creates a 30-day recurring charge and returns Shopify’s approval page', async () => {
      reply = () => ({
        data: { appSubscriptionCreate: { appSubscription: { id: 'gid://shopify/AppSubscription/1', status: 'PENDING' }, confirmationUrl: 'https://jeweler.myshopify.com/admin/charges/confirm', userErrors: [] } },
      });
      expect(await startSubscription(deps(), shopifyTenant.id)).toBe('https://jeweler.myshopify.com/admin/charges/confirm');

      const call = calls[0]!;
      expect(call.url).toMatch(/^https:\/\/jeweler\.myshopify\.com\/admin\/api\/[\d-]+\/graphql\.json$/);
      expect(call.headers['x-shopify-access-token']).toBe('shpat_x');
      const { query, variables } = JSON.parse(call.body);
      expect(query).toContain('appSubscriptionCreate');
      expect(variables).toEqual({
        name: 'Jewelry Builder',
        returnUrl: 'https://dash.example.com/api/billing/shopify/return',
        test: true,
        lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: '99.00', currencyCode: 'USD' }, interval: 'EVERY_30_DAYS' } } }],
      });
    });

    it('reports Shopify user errors and a store that is not connected', async () => {
      reply = () => ({ data: { appSubscriptionCreate: { confirmationUrl: null, userErrors: [{ field: null, message: 'Shop is not eligible' }] } } });
      await expect(startSubscription(deps(), shopifyTenant.id)).rejects.toThrow('Shop is not eligible');
      await expect(startSubscription({ ...deps(), config: { ...config, credentialsKey: null } }, shopifyTenant.id)).rejects.toThrow(/not connected/);
    });

    it('records the subscription once Shopify says it is active', async () => {
      reply = () => active([]);
      expect(await syncShopifySubscription(deps(), shopifyTenant)).toBe('TRIALING'); // not approved: trial untouched

      reply = () => active([{ id: 'gid://shopify/AppSubscription/1', status: 'ACTIVE', currentPeriodEnd: '2026-12-13T00:00:00Z' }]);
      expect(await syncShopifySubscription(deps(), shopifyTenant)).toBe('ACTIVE');
      const t = await fresh(shopifyTenant);
      expect(t).toMatchObject({ subscriptionStatus: 'ACTIVE', billingSubscriptionId: 'gid://shopify/AppSubscription/1' });
      expect(t.currentPeriodEndsAt).toEqual(new Date('2026-12-13T00:00:00Z'));
    });

    it('handles the app_subscriptions/update webhook', async () => {
      const body = JSON.stringify({ app_subscription: { admin_graphql_api_id: 'gid://shopify/AppSubscription/1', status: 'CANCELLED' } });
      const headers = { hmac: hmac(body), shop: 'jeweler.myshopify.com' };

      expect(await handleShopifyBillingWebhook(deps(), body, { ...headers, hmac: hmac(body, 'wrong') })).toEqual({ status: 401, error: 'Invalid signature' });
      expect(await handleShopifyBillingWebhook(deps(), body, { hmac: hmac(body), shop: 'evil.example.com' })).toEqual({ status: 200, handled: false });

      // Shopify's live answer wins over the webhook body
      reply = () => active([]);
      expect(await handleShopifyBillingWebhook(deps(), body, headers)).toEqual({ status: 200, handled: true, tenantId: shopifyTenant.id });
      expect((await fresh(shopifyTenant)).subscriptionStatus).toBe('CANCELED');

      // app uninstalled: the token is dead, so the webhook's own status is used
      await db.tenant.update({ where: { id: shopifyTenant.id }, data: { subscriptionStatus: 'ACTIVE' } });
      reply = () => ({ __status: 401, errors: 'Invalid API key or access token' });
      const frozen = JSON.stringify({ app_subscription: { status: 'FROZEN' } });
      expect((await handleShopifyBillingWebhook(deps(), frozen, { hmac: hmac(frozen), shop: 'jeweler.myshopify.com' })).status).toBe(200);
      expect((await fresh(shopifyTenant)).subscriptionStatus).toBe('PAST_DUE');
    });

    it('maps every Shopify status', () => {
      expect(['ACTIVE', 'FROZEN', 'CANCELLED', 'DECLINED', 'EXPIRED', 'PENDING'].map(mapShopifyStatus)).toEqual([
        'ACTIVE', 'PAST_DUE', 'CANCELED', 'CANCELED', 'CANCELED', null,
      ]);
    });
  });

  // ── Markup matrix ───────────────────────────────────────────────────────────

  describe('markup matrix', () => {
    const rules = () => db.markupRule.findMany({ where: { tenantId: stripeTenant.id }, orderBy: { createdAt: 'asc' } });
    const price = async (cost: number, carat: number, origin: 'NATURAL' | 'LAB_GROWN') =>
      calculateRetailPrice({ wholesalePrice: cost, carat, origin }, await rules())?.retailPrice.toFixed(2) ?? null;

    it('shows suggested values until something is saved', async () => {
      expect(rulesToMatrix(await rules())).toEqual({ matrix: DEFAULT_MATRIX, saved: false, otherRules: 0 });
      expect(await price(1000, 1.2, 'NATURAL')).toBeNull(); // nothing for sale yet
    });

    it('saves tiers as rules the pricing engine uses, and reads them back unchanged', async () => {
      const matrix = {
        breaks: [1, 2],
        rows: [
          { NATURAL: { percent: 50, fixed: 0 }, LAB_GROWN: { percent: 120, fixed: 25 } },
          { NATURAL: { percent: 40, fixed: 100 }, LAB_GROWN: { percent: 100, fixed: 0 } },
          { NATURAL: { percent: 30, fixed: 0 }, LAB_GROWN: { percent: 80, fixed: 0 } },
        ],
        rounding: 'NEAREST_10' as const,
        settingPercent: 150,
      };
      await saveMatrix(db, stripeTenant.id, matrix);
      expect(await rules()).toHaveLength(7); // 3 tiers × 2 origins + settings
      expect(rulesToMatrix(await rules())).toEqual({ matrix, saved: true, otherRules: 0 });

      expect(await price(1000, 0.99, 'NATURAL')).toBe('1500.00');
      expect(await price(1000, 1.0, 'NATURAL')).toBe('1500.00'); // 1400 + 100; the tier starts at exactly 1 ct
      expect(await price(1000, 2.5, 'NATURAL')).toBe('1300.00');
      expect(await price(1004, 0.5, 'LAB_GROWN')).toBe('2230.00'); // 2208.80 + 25, to the nearest 10
      // the on-screen example agrees with the engine
      expect(previewPrice(1004, matrix.rows[0]!.LAB_GROWN, 'NEAREST_10').toFixed(2)).toBe(await price(1004, 0.5, 'LAB_GROWN'));
      const settingRule = (await rules()).find((r) => r.target === 'SETTING')!;
      expect(settingRule.markupPercent.toNumber()).toBe(150);
    });

    it('updates unchanged tiers in place and removes tiers that were deleted', async () => {
      const before = await rules();
      const keepId = before.find((r) => r.origin === 'NATURAL' && r.caratMin === null)!.id;
      await saveMatrix(db, stripeTenant.id, {
        breaks: [1],
        rows: [
          { NATURAL: { percent: 55, fixed: 0 }, LAB_GROWN: { percent: 120, fixed: 25 } },
          { NATURAL: { percent: 35, fixed: 0 }, LAB_GROWN: { percent: 90, fixed: 0 } },
        ],
        rounding: 'NONE',
        settingPercent: null,
      });
      const after = await rules();
      expect(after).toHaveLength(4);
      expect(after.find((r) => r.id === keepId)?.markupPercent.toNumber()).toBe(55); // same row, new value
      expect(after.some((r) => r.target === 'SETTING')).toBe(false);
      expect(await price(1000, 5, 'NATURAL')).toBe('1350.00');
    });

    it('leaves hand-made rules alone and reports them', async () => {
      const custom = await db.markupRule.create({
        data: { tenantId: stripeTenant.id, name: 'RapNet premium', feedSource: 'RAPNET', priority: 10, markupPercent: '70' },
      });
      await saveMatrix(db, stripeTenant.id, DEFAULT_MATRIX);
      expect(await db.markupRule.findUnique({ where: { id: custom.id } })).not.toBeNull();
      expect(rulesToMatrix(await rules())).toMatchObject({ saved: true, otherRules: 1 });
      // another tenant's rules are never touched
      expect(await db.markupRule.count({ where: { tenantId: shopifyTenant.id } })).toBe(0);
    });

    it.each([
      ['tiers out of order', { breaks: [2, 1] }],
      ['a repeated tier', { breaks: [1, 1] }],
      ['a negative markup', { rows: [{ NATURAL: { percent: -5, fixed: 0 }, LAB_GROWN: { percent: 1, fixed: 0 } }], breaks: [] }],
      ['rows that do not match tiers', { breaks: [] }],
      ['an unknown rounding', { rounding: 'UP' }],
      ['not a matrix at all', null],
    ])('rejects %s and changes nothing', async (_name, patch) => {
      const before = JSON.stringify(await rules());
      const input = patch === null ? 'nonsense' : { ...DEFAULT_MATRIX, ...patch };
      await expect(saveMatrix(db, stripeTenant.id, input)).rejects.toThrow();
      expect(JSON.stringify(await rules())).toBe(before);
    });
  });

  // ── Fulfilment ──────────────────────────────────────────────────────────────

  describe('fulfilment', () => {
    const order = (n: number, tenantId: string, status: 'CONFIRMED' | 'ON_HOLD' = 'CONFIRMED') =>
      db.castingOrder.create({
        data: {
          tenantId,
          jobBagNumber: `JB-DASH-${n}`,
          status,
          currentStage: 'CAD_PREP',
          externalOrderId: `100${n}`,
          settingVariantId: variantId,
          metal: 'WHITE_GOLD_14K',
          cadId: 'CAD-D',
          ringSize: '6.5',
          engraving: n === 1 ? 'Always' : null,
          notes: status === 'ON_HOLD' ? 'Paid 10.00 but the bundle was quoted at 4000.00.' : null,
          centerStoneSnapshot: { inventory: 'FEED', carat: '1.5', shape: 'OVAL', origin: 'LAB_GROWN', color: 'G', clarity: 'VS1', wholesalePrice: '800.40' },
          castingCost: '400',
          stoneCost: '800.40',
          retailTotal: '2600.99',
          routeSteps: { create: [{ sequence: 1, stage: 'CAD_PREP' }, { sequence: 2, stage: 'WAX_PRINT' }, { sequence: 3, stage: 'CASTING' }] },
        },
      });

    it('lists a tenant’s orders, newest first, without cost data', async () => {
      await order(1, stripeTenant.id);
      await order(2, stripeTenant.id, 'ON_HOLD');
      await order(3, shopifyTenant.id);
      const rows = await listOrders(db, stripeTenant.id);
      expect(rows.map((r) => r.jobBagNumber)).toEqual(['JB-DASH-2', 'JB-DASH-1']);
      expect(rows[1]).toMatchObject({
        settingName: 'Dashboard Solitaire',
        metal: '14K White Gold',
        stone: '1.50 ct Oval, Lab-Grown, G VS1',
        ringSize: '6.5',
        engraving: 'Always',
        total: '2600.99',
        status: 'CONFIRMED',
        progress: { done: 0, total: 3 },
      });
      expect(JSON.stringify(rows)).not.toMatch(/800\.40|castingCost|stoneCost|wholesale/);
    });

    it('sends a confirmed order to the foundry exactly once', async () => {
      const [target] = await db.castingOrder.findMany({ where: { jobBagNumber: 'JB-DASH-1' } });
      // two clicks at the same moment
      const results = await Promise.all([
        fulfillViaFoundry(db, stripeTenant.id, target!.id, 'Platform Foundry'),
        fulfillViaFoundry(db, stripeTenant.id, target!.id, 'Platform Foundry'),
      ].map((p) => p.catch((e: Error) => ({ ok: false as const, message: e.message }))));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => r.ok)).toEqual({ ok: true, jobBagNumber: 'JB-DASH-1', vendorName: 'Platform Foundry' });

      const after = await db.castingOrder.findUniqueOrThrow({
        where: { id: target!.id },
        include: { vendor: true, routeSteps: { orderBy: { sequence: 'asc' } } },
      });
      expect(after).toMatchObject({ status: 'IN_PRODUCTION', currentStage: 'CAD_PREP' });
      expect(after.vendor?.name).toBe('Platform Foundry');
      expect(after.routeSteps.map((s) => s.status)).toEqual(['IN_PROGRESS', 'PENDING', 'PENDING']);
      expect(after.routeSteps[0]!.startedAt).not.toBeNull();
      expect(await db.castingVendor.count({ where: { name: 'Platform Foundry' } })).toBe(1);

      const again = await fulfillViaFoundry(db, stripeTenant.id, target!.id, 'Platform Foundry');
      expect(again).toEqual({ ok: false, message: 'JB-DASH-1 has already been sent to production.' });
    });

    it('refuses held orders and other tenants’ orders', async () => {
      const held = await db.castingOrder.findFirstOrThrow({ where: { jobBagNumber: 'JB-DASH-2' } });
      const result = await fulfillViaFoundry(db, stripeTenant.id, held.id, 'Platform Foundry');
      expect(result.ok).toBe(false);
      expect((result as { message: string }).message).toMatch(/on hold.*Paid 10\.00/);
      expect((await db.castingOrder.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('ON_HOLD');

      const theirs = await db.castingOrder.findFirstOrThrow({ where: { jobBagNumber: 'JB-DASH-3' } });
      expect(await fulfillViaFoundry(db, stripeTenant.id, theirs.id, 'Platform Foundry')).toEqual({ ok: false, message: 'Order not found.' });
      expect((await db.castingOrder.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('CONFIRMED');
    });

    it('does not send work to a foundry that is switched off', async () => {
      await db.castingVendor.update({ where: { name: 'Platform Foundry' }, data: { isActive: false } });
      const theirs = await db.castingOrder.findFirstOrThrow({ where: { jobBagNumber: 'JB-DASH-3' } });
      const result = await fulfillViaFoundry(db, shopifyTenant.id, theirs.id, 'Platform Foundry');
      expect(result).toEqual({ ok: false, message: 'Platform Foundry is not accepting orders at the moment.' });
      await db.castingVendor.update({ where: { name: 'Platform Foundry' }, data: { isActive: true } });
    });
  });
});
